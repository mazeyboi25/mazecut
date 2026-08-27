from __future__ import annotations

import io
import os

from fastapi import FastAPI
from fastapi import File
from fastapi import HTTPException
from fastapi import UploadFile

from fastapi.responses import Response

from PIL import Image


# ============================================================
# FASTAPI APP
# ============================================================

app = FastAPI(
    title="MazeCut API",
    description="Lightweight Python background-removal endpoint.",
)


# ============================================================
# VERCEL / MODEL CONFIGURATION
# ============================================================

# Vercel Functions have a limited request/response payload.
# Keep a safe margin under the platform limit.
MAX_FILE_SIZE = 3_500_000

# Resize large images BEFORE AI inference. This reduces RAM,
# CPU time, model latency, and output size.
MAX_IMAGE_SIDE = 1400

# Keep model files in a writable location on serverless runtimes.
#
# rembg reads U2NET_HOME when it initializes. /tmp is writable
# inside Vercel Functions.
os.environ.setdefault(
    "U2NET_HOME",
    "/tmp/.u2net",
)

SUPPORTED_TYPES = {
    "image/jpeg",
    "image/png",
    "image/webp",
}


# ============================================================
# LAZY REMBG SESSION
# ============================================================

# Do not import rembg / ONNX at module startup.
#
# This allows /api/health to start with a much lighter import
# path and avoids initializing the model until an image is
# actually submitted.
_rembg_session = None


def get_rembg_session():
    """
    Create the lightweight u2netp model session on first use.

    Vercel can reuse a warm function instance, so later requests
    handled by the same instance can reuse this session.
    """

    global _rembg_session

    if _rembg_session is None:
        from rembg import new_session

        _rembg_session = new_session(
            "u2netp"
        )

    return _rembg_session


# ============================================================
# HEALTH CHECK
# Important: Vercel's api/index.py receives the FULL /api path.
# ============================================================

@app.get("/api/health")
def health():
    return {
        "ok": True,
        "service": "MazeCut",
        "model": "u2netp",
        "max_upload_bytes": MAX_FILE_SIZE,
        "max_image_side": MAX_IMAGE_SIDE,
    }


# ============================================================
# BACKGROUND REMOVAL
# ============================================================

@app.post("/api/remove")
async def remove_background(
    image: UploadFile = File(...)
):
    """
    Remove the image background and return a transparent PNG.

    Optimizations for a serverless deployment:
    - Small upload ceiling
    - Decode validation with Pillow
    - Resize before inference
    - Lazy rembg / ONNX import
    - Lightweight u2netp model
    - No alpha matting
    - Compressed PNG response
    """

    # --------------------------------------------------------
    # Validate upload type
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
            io.BytesIO(raw_bytes)
        )

        source_image.load()

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
    # Resize BEFORE segmentation
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
    # Convert input to PNG bytes
    # --------------------------------------------------------

    source_buffer = io.BytesIO()

    source_image.save(
        source_buffer,
        format="PNG",
        optimize=True,
    )


    # --------------------------------------------------------
    # Lazy-load rembg only for a real processing request
    # --------------------------------------------------------

    try:
        from rembg import remove

        output_bytes = remove(
            source_buffer.getvalue(),
            session=get_rembg_session(),
            alpha_matting=False,
            post_process_mask=False,
        )

    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=(
                "The background-removal model could not run "
                "on this server instance. Please try again."
            ),
        ) from error


    # --------------------------------------------------------
    # Compress result PNG
    # --------------------------------------------------------

    try:
        result_image = Image.open(
            io.BytesIO(output_bytes)
        )

        result_image.load()

        result_buffer = io.BytesIO()

        result_image.save(
            result_buffer,
            format="PNG",
            optimize=True,
            compress_level=9,
        )

        output_bytes = result_buffer.getvalue()

    except Exception:
        # rembg already returns valid PNG bytes. If secondary
        # compression fails, return the original result.
        pass


    # --------------------------------------------------------
    # Keep response below the serverless payload ceiling
    # --------------------------------------------------------

    if len(output_bytes) > 4_000_000:
        raise HTTPException(
            status_code=413,
            detail=(
                "The processed PNG is too large to return. "
                "Try a smaller image."
            ),
        )


    # --------------------------------------------------------
    # Return PNG
    # --------------------------------------------------------

    return Response(
        content=output_bytes,
        media_type="image/png",
        headers={
            "Cache-Control": "no-store",
            "Content-Disposition": (
                'inline; filename="mazecut-result.png"'
            ),
        },
    )
