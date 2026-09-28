#!/usr/bin/env python3
"""
Whisper model-name resolution shared by voice.py and setup.sh.

Why this module exists
----------------------
The two transcription backends use different model identifiers:

  * **faster-whisper** (Linux/Windows) understands the short names itself
    (`large-v3-turbo`, `medium`, `tiny.en`, …).
  * **mlx-whisper** (macOS) wants a local path or a Hugging Face repo id such
    as `mlx-community/whisper-large-v3-turbo`.

This module maps the short, user-facing names to the MLX repos that actually
exist, so `MODEL=medium ./setup.sh` works identically on every platform.
Unknown names are passed through untouched (a full repo id or a local path is
always accepted as-is).
"""
from __future__ import annotations

import os

MLX_COMMUNITY = "mlx-community"

# Verified repositories under the `mlx-community` org (checked via the HF API).
_MLX_REPOS = {
    "tiny": "whisper-tiny-mlx",
    "tiny.en": "whisper-tiny.en-mlx",
    "base": "whisper-base-mlx",
    "base.en": "whisper-base.en-mlx",
    "small": "whisper-small-mlx",
    "small.en": "whisper-small.en-mlx",
    "medium": "whisper-medium-mlx",
    "medium.en": "whisper-medium.en-mlx",
    "large": "whisper-large-v3-mlx",
    "large-v1": "whisper-large-v1-mlx",
    "large-v2": "whisper-large-v2-mlx",
    "large-v3": "whisper-large-v3-mlx",
    "turbo": "whisper-large-v3-turbo",
    "large-v3-turbo": "whisper-large-v3-turbo",
    "large-turbo": "whisper-large-v3-turbo",
}

DEFAULT_MLX_MODEL = f"{MLX_COMMUNITY}/whisper-large-v3-turbo"


def resolve_mlx_model(name: str | None) -> str:
    """Return a path/repo id that `mlx_whisper.transcribe` understands."""
    if not name or not str(name).strip():
        return DEFAULT_MLX_MODEL

    name = str(name).strip()
    # A local directory or an explicit repo id ("org/name") wins over aliases.
    if os.path.isdir(name) or "/" in name:
        return name

    key = name.lower()
    if key.startswith("whisper-"):
        key = key[len("whisper-"):]
    repo = _MLX_REPOS.get(key)
    return f"{MLX_COMMUNITY}/{repo}" if repo else name


if __name__ == "__main__":  # small helper usable from setup.sh
    import sys

    print(resolve_mlx_model(sys.argv[1] if len(sys.argv) > 1 else None))
