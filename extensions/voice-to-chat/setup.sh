#!/usr/bin/env bash
#
# setup.sh — install the voice-to-chat backend on THIS machine.
# Cross-platform: works on Linux, macOS and (WSL) Windows.
#
#   - macOS  (Apple Silicon) -> MLX Whisper  (uses the GPU / Neural Engine)
#   - Linux/Windows            -> faster-whisper (CUDA on NVIDIA, else CPU)
#   - recording everywhere     -> sounddevice (PortAudio)
#
# Usage:
#   ./setup.sh
#
# It will:
#   1. create a Python venv in ./.venv (next to this script)
#   2. install the required Python packages
#   3. (when needed) install a system audio library with your package manager
#   4. download the best-quality Whisper model for this platform
#
# Set MODEL to choose a different one, e.g.  MODEL=medium ./setup.sh
set -euo pipefail

# --- locate this script (works even if invoked through a symlink) ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
cd "$SCRIPT_DIR"

# The venv is machine-local (NOT committed to git). Default to the conventional
# shared location so it is reused across clones; override with VOICE_VENV_DIR.
VENV_DIR="${VOICE_VENV_DIR:-$HOME/.pi/voice-venv}"
PYTHON_BIN=""
case "$UNAME" in
  *MINGW*|*MSYS*|*CYGWIN*) PYTHON_BIN="python" ;;
  *) PYTHON_BIN="python3" ;;
esac

MODEL="${MODEL:-large-v3-turbo}"
export VOICE_MODEL="$MODEL"

log()  { printf '\033[1;34m[voice-to-chat]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[✓]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }

# --- detect platform (uname is reliable everywhere, incl. macOS) -----------
UNAME="$(uname -s)"
case "$UNAME" in
  Darwin)   BACKEND="mlx";           PLATFORM="macOS (Apple Silicon)" ;;
  Linux)    BACKEND="faster-whisper"; PLATFORM="Linux" ;;
  *MINGW*|*MSYS*|*CYGWIN*) BACKEND="faster-whisper"; PLATFORM="Windows" ;;
  *)        BACKEND="faster-whisper"; PLATFORM="unknown ($UNAME)" ;;
esac

log "Piattaforma: $PLATFORM  •  backend: $BACKEND  •  modello: $MODEL"

# --- 1. create the venv -----------------------------------------------------
log "Ambiente virtuale in: $VENV_DIR"
if [ ! -x "$VENV_DIR/bin/python" ]; then
  "$PYTHON_BIN" -m venv "$VENV_DIR"
fi
if [ "$UNAME" = *MINGW* ] || [ "$UNAME" = *MSYS* ] || [ "$UNAME" = *CYGWIN* ]; then
  VENV_PY="$VENV_DIR/Scripts/python.exe"
else
  VENV_PY="$VENV_DIR/bin/python"
fi
[ -x "$VENV_PY" ] || VENV_PY="$VENV_DIR/bin/python"
"$VENV_PY" --version

# --- 2. install Python packages ---------------------------------------------
log "Installazione delle dipendenze Python…"
"$VENV_PY" -m pip install --upgrade pip >/dev/null

if [ "$BACKEND" = "mlx" ]; then
  # Apple Silicon: mlx-whisper runs on Metal / the Neural Engine.
  "$VENV_PY" -m pip install mlx mlx-whisper sounddevice
else
  # Linux/Windows: faster-whisper (+ PyTorch for CUDA on NVIDIA GPUs).
  "$VENV_PY" -m pip install faster-whisper torch sounddevice
fi
ok "Dipendenze Python installate."

# --- 3. install a system audio library (PortAudio) --------------------------
# sounddevice needs PortAudio to record from the microphone.
if command -v apt-get >/dev/null 2>&1; then
  log "Installazione di PortAudio tramite apt…"
  if sudo -v; then
    sudo apt-get update -qq
    sudo apt-get install -y libportaudio2
    ok "PortAudio installato."
  else
    warn "sudo richiesto per 'apt-get install libportaudio2'. Fallo quando puoi:"
    warn "    sudo apt-get update && sudo apt-get install -y libportaudio2"
  fi
elif command -v brew >/dev/null 2>&1; then
  log "Installazione di PortAudio tramite Homebrew…"
  brew list portaudio >/dev/null 2>&1 || brew install portaudio
  ok "PortAudio installato."
else
  warn "Gestore pacchetti non riconosciuto. Installa PortAudio manualmente:"
  warn "  • macOS:     brew install portaudio"
  warn "  • Linux:     sudo apt-get install -y libportaudio2"
  warn "  • Windows:   conda install -c conda-forge portaudio"
fi

# --- 4. download the model --------------------------------------------------
log "Scaricamento del modello '$MODEL'…"
if [ "$BACKEND" = "mlx" ]; then
  "$VENV_PY" -c "import mlx_whisper; mlx_whisper.download_model('$MODEL')"
else
  # faster-whisper downloads the model lazily on first use; here we force it so
  # setup.sh clearly verifies the download works end-to-end.
  "$VENV_PY" -c "from faster_whisper import WhisperModel; WhisperModel('$MODEL')"
fi
ok "Modello pronto."

# --- done -------------------------------------------------------------------
echo
echo -e "\033[1;32m[✓] Tutto pronto!\033[0m"
echo
echo "Prossimi passi:"
echo "  • Trascrivi un file di test:"
echo "      $VENV_PY voice.py --wav tua_registrazione.wav"
echo "  • In pi, carica l'estensione (se già aperta):  /reload"
echo "  • Premi  Ctrl+Shift+M  per dettare a voce."
echo
echo "Variabili utili (opzionali):"
echo "  VOICE_DEVICE=cuda|cpu|mps      (default: cuda su Linux, mps su Mac)"
echo "  VOICE_LANGUAGE=italian         (default: auto)"
echo "  VOICE_PYTHON=/percorso/python  (sovrascrive l'interprete usato)"
echo
