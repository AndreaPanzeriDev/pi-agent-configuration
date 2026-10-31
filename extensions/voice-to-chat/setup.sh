#!/usr/bin/env bash
#
# setup.sh — install the voice-to-chat backend on THIS machine.
# Cross-platform: works on Linux, macOS and (WSL) Windows.
#
#   - macOS (Apple Silicon) -> MLX Whisper  (uses the GPU / Neural Engine)
#   - macOS (Intel)         -> faster-whisper (CPU)
#   - Linux/Windows          -> faster-whisper (CUDA on NVIDIA, else CPU)
#   - recording everywhere   -> sounddevice (PortAudio)
#   - decoding on macOS      -> ffmpeg (installed with Homebrew when missing)
#
# Usage:
#   ./setup.sh
#
# It will:
#   1. create a Python venv in $HOME/.pi/voice-venv (or $VOICE_VENV_DIR)
#   2. install the required Python packages (bootstrapping pip if needed)
#   3. (when needed) install the system audio library with your package manager
#   4. download the Whisper model that the runtime will actually use
#   5. verify PortAudio/ffmpeg and save the choice in voice-to-chat.json
#
# The default model follows the detected backend: `medium` on CPU (including
# Intel macOS), `large-v3-turbo` on CUDA and Apple Silicon (MLX).
# Set MODEL (or VOICE_MODEL) to choose a different one, e.g.:
#   MODEL=medium ./setup.sh
#   VOICE_DEVICE=cpu ./setup.sh
set -euo pipefail

# --- locate this script (works even if invoked through a symlink) ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
cd "$SCRIPT_DIR"

log()  { printf '\033[1;34m[voice-to-chat]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[✓]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[✗]\033[0m %s\n' "$*" >&2; exit 1; }

# --- detect the platform BEFORE using $UNAME (set -u would abort otherwise) --
UNAME="$(uname -s)"
ARCH="$(uname -m)"
IS_WINDOWS=0
case "$UNAME" in
  Darwin)
    if [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then
      BACKEND="mlx";            PLATFORM="macOS (Apple Silicon)"; PYTHON_BIN="python3"
    else
      BACKEND="faster-whisper"; PLATFORM="macOS (Intel)";         PYTHON_BIN="python3"
    fi ;;
  Linux)
    BACKEND="faster-whisper";   PLATFORM="Linux";                 PYTHON_BIN="python3" ;;
  *MINGW*|*MSYS*|*CYGWIN*)
    BACKEND="faster-whisper";   PLATFORM="Windows";               PYTHON_BIN="python"
    IS_WINDOWS=1 ;;
  *)
    BACKEND="faster-whisper";   PLATFORM="unknown ($UNAME)";      PYTHON_BIN="python3" ;;
esac

# Pick an interpreter that actually exists: on macOS `python` often does not.
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  if command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="python3"
  elif command -v python >/dev/null 2>&1; then
    PYTHON_BIN="python"
  else
    die "Python 3 not found. Install Python 3.10+ (macOS: brew install python; Ubuntu: sudo apt install python3 python3-venv) and try again."
  fi
fi

# Keep an explicit MODEL=... (or VOICE_MODEL=...) override; the machine-specific
# default is chosen later, after the backend is installed and we know whether
# CUDA works.
MODEL_OVERRIDE="${MODEL:-${VOICE_MODEL:-}}"

# --- 1. create the venv -----------------------------------------------------
# The venv is machine-local (NOT committed to git). Default to the conventional
# shared location so it is reused across clones; override with VOICE_VENV_DIR.
VENV_DIR="${VOICE_VENV_DIR:-$HOME/.pi/voice-venv}"
if [ "$IS_WINDOWS" -eq 1 ]; then
  VENV_PY="$VENV_DIR/Scripts/python.exe"
else
  VENV_PY="$VENV_DIR/bin/python"
fi

log "Virtual environment in: $VENV_DIR"
if [ ! -x "$VENV_PY" ]; then
  "$PYTHON_BIN" -m venv "$VENV_DIR" ||
    die "Unable to create the venv. On Ubuntu install 'python3-venv' (sudo apt install python3-venv)."
fi
[ -x "$VENV_PY" ] || die "venv interpreter not found in $VENV_PY"
"$VENV_PY" --version

# Some venv creators (e.g. `uv venv`) do not install pip: bootstrap it.
if ! "$VENV_PY" -m pip --version >/dev/null 2>&1; then
  log "pip not found in the virtual environment: installing it…"
  "$VENV_PY" -m ensurepip --upgrade >/dev/null 2>&1 || true
fi
if ! "$VENV_PY" -m pip --version >/dev/null 2>&1; then
  die "pip not available in $VENV_DIR. Remove the venv (rm -rf \"$VENV_DIR\") and try again."
fi

# --- 2. install Python packages ---------------------------------------------
log "Installing Python dependencies…"
"$VENV_PY" -m pip install --upgrade pip >/dev/null

if [ "$BACKEND" = "mlx" ]; then
  # Apple Silicon: mlx-whisper runs on Metal / the Neural Engine.
  "$VENV_PY" -m pip install mlx mlx-whisper sounddevice
else
  # Linux/Windows: faster-whisper. PyTorch is installed only when a CUDA GPU
  # is present, because it supplies the CUDA runtime libraries and is huge on
  # CPU-only machines (faster-whisper itself uses CTranslate2, not PyTorch).
  WANT_TORCH=0
  if [ "$UNAME" != "Darwin" ] && [ "${VOICE_DEVICE:-auto}" != "cpu" ]; then
    # Respect CUDA_VISIBLE_DEVICES="" (explicitly hide all GPUs): don't pull
    # the multi-gigabyte PyTorch/CUDA stack just to fall back to CPU.
    if { [ -z "${CUDA_VISIBLE_DEVICES+x}" ] || [ -n "${CUDA_VISIBLE_DEVICES}" ]; } &&
       command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
      WANT_TORCH=1
    fi
  fi
  if [ "$WANT_TORCH" -eq 1 ]; then
    "$VENV_PY" -m pip install faster-whisper torch sounddevice
  else
    "$VENV_PY" -m pip install faster-whisper sounddevice
  fi
fi
ok "Python dependencies installed."

# --- 2b. choose the same model/device the runtime will use ------------------
if [ "$BACKEND" = "mlx" ]; then
  DEVICE="mps"
  DEFAULT_MODEL="large-v3-turbo"
else
  DEVICE="${VOICE_DEVICE:-auto}"
  case "$DEVICE" in
    cuda|cpu) ;;
    *) DEVICE="auto" ;;
  esac

  if [ "$DEVICE" = "auto" ]; then
    if "$VENV_PY" - <<'PY' >/dev/null 2>&1
import ctranslate2
ctranslate2.get_supported_compute_types("cuda")
PY
    then
      DEVICE="cuda"
    else
      DEVICE="cpu"
    fi
  elif [ "$DEVICE" = "cuda" ]; then
    if ! "$VENV_PY" - <<'PY' >/dev/null 2>&1
import ctranslate2
ctranslate2.get_supported_compute_types("cuda")
PY
    then
      warn "CUDA requested but not available: using CPU."
      DEVICE="cpu"
    fi
  fi

  if [ "$DEVICE" = "cuda" ]; then
    DEFAULT_MODEL="large-v3-turbo"
  else
    DEFAULT_MODEL="medium"
  fi
fi

# Persist the model choice so the extension uses exactly what setup downloaded.
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
CONFIG_PATH="$AGENT_DIR/voice-to-chat.json"
EXISTING_MODEL=""
if [ -z "$MODEL_OVERRIDE" ] && [ -f "$CONFIG_PATH" ]; then
  EXISTING_MODEL="$("$VENV_PY" - "$CONFIG_PATH" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as f:
        value = json.load(f).get("model", "")
    print(value if isinstance(value, str) else "")
except Exception:
    print("")
PY
)"
fi
MODEL="${MODEL_OVERRIDE:-${EXISTING_MODEL:-$DEFAULT_MODEL}}"

log "Platform: $PLATFORM  •  backend: $BACKEND  •  device: $DEVICE  •  model: $MODEL"

# --- 3. install system libraries (PortAudio, and ffmpeg on macOS) -----------
if [ "$BACKEND" = "mlx" ]; then
  # mlx-whisper shells out to ffmpeg to decode the recorded audio, and
  # sounddevice needs PortAudio to record from the microphone.
  if command -v brew >/dev/null 2>&1; then
    log "Installing portaudio and ffmpeg via Homebrew…"
    brew list portaudio >/dev/null 2>&1 || brew install portaudio
    brew list ffmpeg >/dev/null 2>&1 || brew install ffmpeg
    ok "PortAudio and ffmpeg installed."
  else
    warn "Homebrew not found. Install https://brew.sh and then:"
    warn "  brew install portaudio ffmpeg"
  fi
elif [ "$UNAME" = "Darwin" ]; then
  # Intel Mac: faster-whisper uses PyAV, so ffmpeg is not required.
  if command -v brew >/dev/null 2>&1; then
    log "Installing PortAudio via Homebrew…"
    brew list portaudio >/dev/null 2>&1 || brew install portaudio
    ok "PortAudio installed."
  else
    warn "Homebrew not found. Install https://brew.sh and then: brew install portaudio"
  fi
elif command -v apt-get >/dev/null 2>&1; then
  log "Installing PortAudio via apt…"
  if sudo -v; then
    sudo apt-get update -qq
    sudo apt-get install -y libportaudio2
    ok "PortAudio installed."
  else
    warn "sudo required for 'apt-get install libportaudio2'. Run it when you can:"
    warn "    sudo apt-get update && sudo apt-get install -y libportaudio2"
  fi
elif command -v brew >/dev/null 2>&1; then
  log "Installing PortAudio via Homebrew…"
  brew list portaudio >/dev/null 2>&1 || brew install portaudio
  ok "PortAudio installed."
else
  warn "Unrecognized package manager. Install PortAudio manually:"
  warn "  • macOS:     brew install portaudio ffmpeg"
  warn "  • Linux:     sudo apt-get install -y libportaudio2"
  warn "  • Windows:   conda install -c conda-forge portaudio"
fi

# --- 4. download the model --------------------------------------------------
log "Downloading the '$MODEL' model…"
if [ "$BACKEND" = "mlx" ]; then
  # `mlx_whisper` has no download_model() helper: resolve the user-friendly
  # name to its mlx-community repo and fetch it with huggingface_hub.
  MODEL_REPO="$("$VENV_PY" voice_models.py "$MODEL")"
  "$VENV_PY" - "$MODEL_REPO" <<'PY'
from huggingface_hub import snapshot_download
import sys

path = snapshot_download(repo_id=sys.argv[1])
print(f"downloaded to {path}")
PY
  ok "Model '$MODEL_REPO' is ready."
else
  # faster-whisper downloads the model lazily on first use; here we force it so
  # setup.sh clearly verifies the download works end-to-end.
  "$VENV_PY" - "$MODEL" <<'PY'
from faster_whisper import WhisperModel
import sys

WhisperModel(sys.argv[1])
PY
  ok "Model '$MODEL' is ready."
fi

# --- 5. verify the runtime --------------------------------------------------
log "Verifying the runtime…"
if ! "$VENV_PY" -c "import sounddevice" >/dev/null 2>&1; then
  die "sounddevice/PortAudio is not available. Install PortAudio (see above) and retry."
fi
if [ "$BACKEND" = "mlx" ]; then
  if ! "$VENV_PY" -c "import mlx_whisper" >/dev/null 2>&1; then
    die "mlx-whisper is not importable."
  fi
  if ! command -v ffmpeg >/dev/null 2>&1; then
    die "ffmpeg is required by mlx-whisper. Install it (brew install ffmpeg) and retry."
  fi
else
  if ! "$VENV_PY" -c "import faster_whisper" >/dev/null 2>&1; then
    die "faster-whisper is not importable."
  fi
fi
ok "Runtime verified."

# Save the exact model/backend/device so the Pi extension uses the same ones.
mkdir -p "$AGENT_DIR"
"$VENV_PY" - "$CONFIG_PATH" "$MODEL" "$BACKEND" "$DEVICE" <<'PY'
import json
import sys

path, model, backend, device = sys.argv[1:5]
with open(path, "w", encoding="utf-8") as f:
    json.dump({"model": model, "backend": backend, "device": device}, f, indent=2)
    f.write("\n")
PY
ok "Configuration written: $CONFIG_PATH"

# --- done -------------------------------------------------------------------
echo
echo -e "\033[1;32m[✓] All set!\033[0m"
echo
echo "Next steps:"
echo "  • Transcribe a test file:"
echo "      $VENV_PY voice.py --wav your_recording.wav"
echo "  • In pi, load the extension (if already open):  /reload"
echo "  • Press  Ctrl+Shift+M  (or run /voice) to speak."
echo
echo "Useful variables (optional):"
echo "  VOICE_MODEL=<name>             overrides the model saved in voice-to-chat.json"
echo "  VOICE_DEVICE=cuda|cpu|mps      overrides the device saved in voice-to-chat.json"
echo "  VOICE_LANGUAGE=italian         (default: auto)"
echo "  VOICE_PYTHON=/path/to/python   (overrides the interpreter used)"
