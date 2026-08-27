from __future__ import annotations

import io
from pathlib import Path
from threading import Lock

import numpy as np
import onnxruntime as ort

from fastapi import FastAPI
from fastapi import File
from fastapi import HTTPException
from fastapi import UploadFile

from fastapi.responses import Response

from PIL import Image
from PIL import ImageOps


# ============================================================
# FASTAPI APP
# ============================================================

app = FastAPI(
    title="MazeCut API",
    description=(
        "Lightweight U2NetP background removal "
        "without the full rembg dependency stack."
    ),
)


# ============================================================
# PATHS / LIMITS
# ============================================================

API_ROOT = Path(__file__).resolve().parent

MODEL_PATH = (
    API_ROOT
    / "models"
    / "u2netp.onnx"
)


MAX_FILE_SIZE = 3_500_000

MAX_IMAGE_SIDE = 1280

MODEL_INPUT_SIZE = 320


SUPPORTED_TYPES = {
    "image/jpeg",
    "image/png",
    "image/webp",
}


# ============================================================
# ONNX SESSION CACHE
# ============================================================

_session = None
_session_lock = Lock()


def get_session():
    """
    Initialize ONNX Runtime only when the first image is processed.

    The session is cached so a warm Vercel function can reuse it.
    """

    global _session


    if _session is not None:
        return _session


    with _session_lock:
        if _session is not None:
            return _session


        if not MODEL_PATH.exists():
            raise RuntimeError(
                "u2netp.onnx is missing. "
                "Run `python download_model.py` before deploying."
            )


        options = ort.SessionOptions()


        # Hobby functions provide one vCPU. Limiting ONNX to one
        # thread avoids wasteful thread creation and reduces memory.
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1


        options.graph_optimization_level = (
            ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        )


        _session = ort.InferenceSession(
            str(MODEL_PATH),
            sess_options=options,
            providers=[
                "CPUExecutionProvider"
            ],
        )


    return _session


# ============================================================
# U2NETP PREPROCESSING
# ============================================================

def build_model_input(
    image: Image.Image
) -> np.ndarray:
    """
    Reproduce the U2NetP normalization used by rembg.

    The segmentation model itself always receives a 320x320 image.
    """

    resized = (
        image
        .convert("RGB")
        .resize(
            (
                MODEL_INPUT_SIZE,
                MODEL_INPUT_SIZE
            ),
            Image.Resampling.LANCZOS,
        )
    )


    image_array = np.asarray(
        resized,
        dtype=np.float32,
    )


    maximum = max(
        float(
            np.max(
                image_array
            )
        ),
        1e-6,
    )


    image_array = (
        image_array
        / maximum
    )


    normalized = np.empty(
        image_array.shape,
        dtype=np.float32,
    )


    normalized[:, :, 0] = (
        (
            image_array[:, :, 0]
            - 0.485
        )
        / 0.229
    )


    normalized[:, :, 1] = (
        (
            image_array[:, :, 1]
            - 0.456
        )
        / 0.224
    )


    normalized[:, :, 2] = (
        (
            image_array[:, :, 2]
            - 0.406
        )
        / 0.225
    )


    normalized = normalized.transpose(
        (
            2,
            0,
            1
        )
    )


    return np.expand_dims(
        normalized,
        axis=0,
    ).astype(
        np.float32,
        copy=False,
    )


# ============================================================
# MASK CREATION
# ============================================================

def predict_mask(
    image: Image.Image
) -> Image.Image:
    """
    Run U2NetP and convert its first output into an alpha mask.
    """

    session = get_session()


    model_input = build_model_input(
        image
    )


    input_name = (
        session
        .get_inputs()[0]
        .name
    )


    outputs = session.run(
        None,
        {
            input_name:
                model_input
        },
    )


    prediction = outputs[0][
        :,
        0,
        :,
        :
    ]


    maximum = float(
        np.max(
            prediction
        )
    )


    minimum = float(
        np.min(
            prediction
        )
    )


    difference = (
        maximum
        - minimum
    )


    if difference <= 1e-8:
        normalized = np.zeros_like(
            prediction,
            dtype=np.float32,
        )
    else:
        normalized = (
            prediction
            - minimum
        ) / difference


    normalized = np.squeeze(
        normalized
    )


    mask_array = (
        np.clip(
            normalized,
            0.0,
            1.0,
        )
        * 255.0
    ).astype(
        np.uint8
    )


    mask = Image.fromarray(
        mask_array,
        mode="L",
    )


    return mask.resize(
        image.size,
        Image.Resampling.LANCZOS,
    )


# ============================================================
# HEALTH CHECK
# ============================================================

@app.get("/api")
def health():
    return {
        "ok": True,
        "service": "MazeCut",
        "engine": "direct-onnx",
        "model": "u2netp",
        "model_present": MODEL_PATH.exists(),
        "max_upload_bytes": MAX_FILE_SIZE,
        "max_image_side": MAX_IMAGE_SIDE,
    }


# ============================================================
# BACKGROUND REMOVAL
# ============================================================

@app.post("/api")
async def remove_background(
    image: UploadFile = File(...)
):
    """
    Accept JPG / PNG / WEBP and return a transparent PNG.
    """

    # --------------------------------------------------------
    # Validate type
    # --------------------------------------------------------

    if image.content_type not in SUPPORTED_TYPES:
        raise HTTPException(
            status_code=400,
            detail=(
                "Only JPG, PNG, and WEBP images are supported."
            ),
        )


    # --------------------------------------------------------
    # Read upload
    # --------------------------------------------------------

    raw_bytes = await image.read()


    if not raw_bytes:
        raise HTTPException(
            status_code=400,
            detail="The uploaded image is empty.",
        )


    if len(raw_bytes) > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=413,
            detail=(
                "The image is too large. "
                "MazeCut supports files up to 3.5 MB."
            ),
        )


    # --------------------------------------------------------
    # Decode image
    # --------------------------------------------------------

    try:
        source_image = Image.open(
            io.BytesIO(
                raw_bytes
            )
        )


        source_image.load()


        # Correct camera orientation before segmentation.
        source_image = ImageOps.exif_transpose(
            source_image
        )


        source_image = source_image.convert(
            "RGBA"
        )

    except Exception as error:
        raise HTTPException(
            status_code=400,
            detail=(
                "The uploaded file could not be decoded "
                "as an image."
            ),
        ) from error


    # --------------------------------------------------------
    # Resize very large images before inference / output.
    # --------------------------------------------------------

    if max(source_image.size) > MAX_IMAGE_SIDE:
        source_image.thumbnail(
            (
                MAX_IMAGE_SIDE,
                MAX_IMAGE_SIDE
            ),
            Image.Resampling.LANCZOS,
        )


    # --------------------------------------------------------
    # Run ONNX segmentation
    # --------------------------------------------------------

    try:
        alpha_mask = predict_mask(
            source_image
        )

    except RuntimeError as error:
        raise HTTPException(
            status_code=503,
            detail=str(
                error
            ),
        ) from error

    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=(
                "The ONNX segmentation model failed to run. "
                "Check the Vercel function logs for the exact error."
            ),
        ) from error


    # --------------------------------------------------------
    # Apply mask
    # --------------------------------------------------------

    result_image = source_image.copy()


    result_image.putalpha(
        alpha_mask
    )


    # --------------------------------------------------------
    # Encode optimized PNG
    # --------------------------------------------------------

    output_buffer = io.BytesIO()


    result_image.save(
        output_buffer,
        format="PNG",
        optimize=True,
        compress_level=9,
    )


    output_bytes = (
        output_buffer
        .getvalue()
    )


    # Keep a margin under the response payload limit.
    if len(output_bytes) > 4_000_000:
        raise HTTPException(
            status_code=413,
            detail=(
                "The processed PNG is too large to return. "
                "Try a smaller image."
            ),
        )


    return Response(
        content=output_bytes,
        media_type="image/png",
        headers={
            "Cache-Control":
                "no-store",

            "Content-Disposition":
                'inline; filename="mazecut-result.png"',
        },
    )
