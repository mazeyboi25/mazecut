from __future__ import annotations

import io
import os
from pathlib import Path

from fastapi import FastAPI
from fastapi import File
from fastapi import HTTPException
from fastapi import UploadFile

from fastapi.responses import FileResponse
from fastapi.responses import Response

from fastapi.staticfiles import StaticFiles

from PIL import Image

from rembg import new_session
from rembg import remove


# ============================================================
# PROJECT PATHS
# ============================================================

ROOT = Path(__file__).resolve().parent


# ============================================================
# FASTAPI APP
# ============================================================

app = FastAPI(
    title="MazeCut",
    description="Python-powered image background remover.",
)


# Serve the logo and any future static assets.

app.mount(
    "/assets",
    StaticFiles(directory=ROOT / "assets"),
    name="assets",
)


# ============================================================
# UPLOAD LIMITS
# ============================================================

MAX_FILE_SIZE = 10 * 1024 * 1024

SUPPORTED_CONTENT_TYPES = {
    "image/jpeg",
    "image/png",
    "image/webp",
}


# ============================================================
# REMBG MODEL SESSION
# ============================================================

_rembg_session = None


def get_rembg_session():
    """
    Load the lightweight U2-Net model once per Python process.

    The first request can take longer because rembg / ONNX
    needs to initialize the model.
    """

    global _rembg_session

    if _rembg_session is None:
        _rembg_session = new_session(
            "u2netp"
        )

    return _rembg_session


# ============================================================
# FRONTEND ROUTES
# ============================================================

@app.get("/")
def serve_index():
    return FileResponse(
        ROOT / "index.html"
    )


@app.get("/styles.css")
def serve_styles():
    return FileResponse(
        ROOT / "styles.css",
        media_type="text/css",
    )


@app.get("/script.js")
def serve_script():
    return FileResponse(
        ROOT / "script.js",
        media_type="application/javascript",
    )


# ============================================================
# HEALTH ENDPOINT
# ============================================================

@app.get("/api/health")
def health():
    return {
        "ok": True,
        "service": "MazeCut",
        "model": "u2netp",
    }


# ============================================================
# BACKGROUND REMOVAL ENDPOINT
# ============================================================

@app.post("/api/remove")
async def remove_background(
    image: UploadFile = File(...)
):
    """
    Accept a JPG / PNG / WEBP image and return a PNG
    containing an alpha channel with the background removed.
    """

    # --------------------------------------------------------
    # Validate MIME type
    # --------------------------------------------------------

    if image.content_type not in SUPPORTED_CONTENT_TYPES:
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
            detail="The image exceeds the 10 MB upload limit.",
        )


    # --------------------------------------------------------
    # Decode with Pillow
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
    # Resize very large images
    # --------------------------------------------------------

    max_side = int(
        os.getenv(
            "MAZECUT_MAX_SIDE",
            "2200",
        )
    )


    if max(source_image.size) > max_side:
        source_image.thumbnail(
            (max_side, max_side),
            Image.Resampling.LANCZOS,
        )


    # --------------------------------------------------------
    # Convert source to PNG bytes
    # --------------------------------------------------------

    source_buffer = io.BytesIO()


    source_image.save(
        source_buffer,
        format="PNG",
    )


    # --------------------------------------------------------
    # Run foreground segmentation
    # --------------------------------------------------------

    try:
        output_bytes = remove(
            source_buffer.getvalue(),
            session=get_rembg_session(),
            alpha_matting=False,
        )

    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=(
                "The segmentation model could not process "
                "this image. Try a smaller or clearer image."
            ),
        ) from error


    # --------------------------------------------------------
    # Return transparent PNG
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
