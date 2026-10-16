#!/usr/bin/env bash
#
# setup.sh — install the voice-to-chat backend on THIS machine.
# Cross-platform: works on Linux, macOS and (WSL) Windows.
#
#   - macOS (Apple Silicon) -> MLX Whisper  (uses the GPU / Neural Engine)
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
#   4. download the best-quality Whisper model for this platform
#
# Set MODEL to choose a different one, e.g.  MODEL=medium ./setup.sh
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
IS_WINDOWS=0
case "$UNAME" in
  Darwin)
    BACKEND="mlx";            PLATFORM="macOS (Apple Silicon)"; PYTHON_BIN="python3" ;;
  Linux)
    BACKEND="faster-whisper"; PLATFORM="Linux";                 PYTHON_BIN="python3" ;;
  *MINGW*|*MSYS*|*CYGWIN*)
    BACKEND="faster-whisper"; PLATFORM="Windows";               PYTHON_BIN="python"
    IS_WINDOWS=1 ;;
  *)
    BACKEND="faster-whisper"; PLATFORM="unknown ($UNAME)";      PYTHON_BIN="python3" ;;
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

MODEL="${MODEL:-large-v3-turbo}"
export VOICE_MODEL="$MODEL"

log "Platform: $PLATFORM  •  backend: $BACKEND  •  model: $MODEL"

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
  # Linux/Windows: faster-whisper (+ PyTorch for CUDA on NVIDIA GPUs).
  "$VENV_PY" -m pip install faster-whisper torch sounddevice
fi
ok "Python dependencies installed."

# --- 3. install system libraries (PortAudio, and ffmpeg on macOS) -----------
if [ "$BACKEND" = "mlx" ]; then
  # mlx-whisper shells out to ffmpeg to decode the recorded audio, and
  # sounddevice needs PortAudio to record from the microphone.
  if command -v brew >/dev/null 2>&1; then
    log "Installing portaudio and ffmpeg via Homebrew…"
    brew list portaudio >/dev/null 2>&1 || brew install portaudio
    brew list ffmpeg >/dev/null 2>&1 || brew install ffmpeg
    ok "PortAudio e ffmpeg installati."
  else
    warn "Homebrew not found. Install https://brew.sh and then:"
    warn "  brew install portaudio ffmpeg"
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
  "$VENV_PY" -c "from huggingface_hub import snapshot_download; snapshot_download(repo_id='$MODEL_REPO')"
  ok "Model '$MODEL_REPO' is ready."
else
  # faster-whisper downloads the model lazily on first use; here we force it so
  # setup.sh clearly verifies the download works end-to-end.
  "$VENV_PY" -c "from faster_whisper import WhisperModel; WhisperModel('$MODEL')"
  ok "Model is ready."
fi

# --- done -------------------------------------------------------------------
echo
echo -e "\033[1;32m[✓] All set!\033[0m"
echo
echo "Next steps:"
echo "  • Transcribe a test file:"
echo "      $VENV_PY voice.py --wav your_recording.wav"
echo "  • In pi, load the extension (if already open):  /reload"
echo "  • Press  Ctrl+Shift+M  to speak."
echo
echo "Useful variables (optional):"
echo "  VOICE_DEVICE=cuda|cpu|mps      (default: cuda on Linux, mps on Mac)"
echo "  VOICE_LANGUAGE=italian         (default: auto)"
echo "  VOICE_PYTHON=/path/to/python   (overrides the interpreter used)"
echo
