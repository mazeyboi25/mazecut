from __future__ import annotations

import hashlib
import sys
import urllib.request
from pathlib import Path


MODEL_URL = (
    "https://github.com/danielgatis/rembg/"
    "releases/download/v0.0.0/u2netp.onnx"
)

EXPECTED_MD5 = (
    "8e83ca70e441ab06c318d82300c84806"
)

ROOT = Path(__file__).resolve().parent

MODEL_DIRECTORY = (
    ROOT
    / "api"
    / "models"
)

MODEL_PATH = (
    MODEL_DIRECTORY
    / "u2netp.onnx"
)


def md5_for_file(
    path: Path
) -> str:
    digest = hashlib.md5()

    with path.open("rb") as handle:
        for block in iter(
            lambda:
                handle.read(
                    1024 * 1024
                ),
            b"",
        ):
            digest.update(
                block
            )

    return digest.hexdigest()


def main():
    MODEL_DIRECTORY.mkdir(
        parents=True,
        exist_ok=True,
    )


    if MODEL_PATH.exists():
        current_md5 = md5_for_file(
            MODEL_PATH
        )


        if current_md5 == EXPECTED_MD5:
            print(
                "u2netp.onnx is already downloaded "
                "and its checksum is valid."
            )

            return


        print(
            "Existing model has the wrong checksum. "
            "Downloading a fresh copy..."
        )


        MODEL_PATH.unlink()


    print(
        "Downloading lightweight U2NetP model..."
    )

    print(
        MODEL_URL
    )


    try:
        urllib.request.urlretrieve(
            MODEL_URL,
            MODEL_PATH,
        )

    except Exception as error:
        if MODEL_PATH.exists():
            MODEL_PATH.unlink()

        print(
            f"Download failed: {error}",
            file=sys.stderr,
        )

        raise SystemExit(
            1
        )


    downloaded_md5 = md5_for_file(
        MODEL_PATH
    )


    if downloaded_md5 != EXPECTED_MD5:
        MODEL_PATH.unlink(
            missing_ok=True
        )

        print(
            "Downloaded model checksum did not match.",
            file=sys.stderr,
        )

        raise SystemExit(
            1
        )


    size_mb = (
        MODEL_PATH.stat().st_size
        / 1024
        / 1024
    )


    print(
        f"Model ready: {MODEL_PATH}"
    )

    print(
        f"Size: {size_mb:.2f} MB"
    )


if __name__ == "__main__":
    main()
