# voice-to-chat

**100% local** voice dictation for pi. Press a key to start recording, press
the **same key** again to stop: only then is the text transcribed and inserted
into pi's chat. No external services (no OpenAI/Google/Azure): everything runs
locally.

## Cross-platform

This extension works on **Linux**, **macOS (Apple Silicon)**, and
**(WSL)Windows** with a single codebase. The transcription backend is
**chosen automatically** based on the system:

| Platform         | Backend            | Hardware used                           |
|------------------|--------------------|-----------------------------------------|
| macOS (Apple)    | **MLX Whisper**    | Metal GPU / Neural Engine               |
| Linux + NVIDIA   | **faster-whisper** | **CUDA** (GPU)                          |
| Linux / Windows  | **faster-whisper** | CPU (automatic fallback when no GPU)    |

Recording uses **`sounddevice` (PortAudio)**: the same path on every system,
so we no longer depend on `arecord` (Linux-only).

## How it works

1. Press **`Ctrl+Shift+M`** → recording **starts**. The footer shows
   `🎙 REC` and, above the editor, a small **animated red bar** appears: a row
   of bars (`▁▂▃▄▅▆▇█`) rising and falling like a wave, just to signal that
   recording is active. No text (no "REC", no "Ctrl+Shift+M"), just the bars.
2. Speak calmly (Italian or English, language auto-detected).
3. Press **`Ctrl+Shift+M`** again → recording **stops** and transcription
   begins (`✍ transcribing…`).
4. The transcribed text is written into **pi's editor** (the input box),
   ready for review. **It is not sent automatically**: press **Enter** yourself
   when happy. If the editor already had text, the transcription is appended.

Pressing `Ctrl+Shift+M` again during transcription **cancels** it.

## Installation (on each machine)

The extension is plain **code** (`.ts` / `.py` / `.md`). The recommended way
is to use the `pi-agent-config` repo on GitHub:

```bash
git clone <your-repo> ~/pi-agent-config
~/pi-agent-config/setup.sh        # links extensions and installs the backend
```

Or manually:

```bash
# 1. clone the repo where pi looks for it
mkdir -p ~/.pi/agent/extensions
git clone <your-repo> ~/.pi/agent/extensions/estensioni
ln -s ~/.pi/agent/extensions/estensioni/extensions/voice-to-chat ~/.pi/agent/extensions/voice-to-chat

# 2. install backend + dependencies + model with ONE command
~/.pi/agent/extensions/voice-to-chat/setup.sh
```

> ⚠️ **Never** copy the `.venv` or downloaded models across machines:
> they are OS/architecture-specific. `setup.sh` recreates them locally.

Safety max duration: 120 seconds (`--max-duration`, configurable).

## Configuration

Environment variables (optional), read by `voice.py`:

| Variable | Default | Description |
|----------|---------|-------------|
| `VOICE_MODEL` | `large-v3-turbo` | Whisper model. `base` < `small` < `medium` < `large-v3` ≈ `large-v3-turbo`. |
| `VOICE_LANGUAGE` | `auto` | `auto`, a code (`it`, `en`, …) or a name (`italian`, `english`, …). |
| `VOICE_DEVICE` | `cuda` (Linux) / `mps` (Mac) | `cuda` (fast) / `cpu` / `mps`. Falls back to CPU on its own when CUDA is unavailable. |
| `VOICE_COMPUTE_TYPE` | `float16` (CUDA) / `int8` (CPU) | CTranslate2 compute type. |
| `VOICE_PROMPT` | *(empty)* | Text steering the transcription (proper nouns, technical terms…). |
| `VOICE_PYTHON` | *(empty)* | Python interpreter path to use (override). |

Example: forced Italian with the `medium` model on CPU:

```bash
export VOICE_MODEL=medium VOICE_LANGUAGE=italian VOICE_DEVICE=cpu
pi
```

## Test

Transcribe an existing audio file, no microphone needed:

```bash
# depends on where you created the venv (default: ~/.pi/voice-venv)
~/.pi/voice-venv/bin/python \
    ~/.pi/agent/extensions/voice-to-chat/voice.py --wav my_recording.wav
```

On macOS `mlx-whisper` uses **ffmpeg** to decode audio: `setup.sh` installs it
via Homebrew (`brew install ffmpeg`) if missing.

## Troubleshooting

- **No audio recorded / "no PortAudio device":** install PortAudio
  (`sudo apt-get install -y libportaudio2` on Linux, `brew install portaudio`
  on Mac) and check the input device.
- **macOS: "ffmpeg not found":** `brew install ffmpeg` (or re-run `setup.sh`).
- **Poor transcription:** use a bigger model (`VOICE_MODEL=medium`
  or `large-v3-turbo`) and force the language if needed.
- **CUDA unavailable:** the script automatically falls back to `cpu`.
- **Shortcut doesn't fire:** make sure the extension is loaded
  (`/reload`) and that `ctrl+shift+m` isn't used by another program.
- **Indicator not visible:** the footer is the one at the bottom; the widget
  appears above the editor. Both disappear when back to `idle`.

## Important note (anti-crash)

The child script **never writes to pi's terminal**: its `stderr` is captured
to a log file in the system temp directory (`pi_voice_*.log`). This is
essential, because writing directly to the TTY while pi's TUI is active
corrupts rendering ("crashed" screen). If something goes wrong, the log holds
the `voice.py` messages.

## Architecture

- `voice.py` — records (`sounddevice`/PortAudio) until it receives SIGINT, then
  transcribes with MLX on Mac or faster-whisper (CUDA/CPU) on Linux/Windows.
- `voice_models.py` — maps short model names (`large-v3-turbo`,
  `medium`, …) to the right Hugging Face repos for MLX
  (`mlx-community/whisper-…`). faster-whisper understands them natively.
- `index.ts` — pi extension. Handles the `idle → recording → transcribing`
  state machine, draws the animated indicator and, when done, puts the
  transcription in the editor via `ctx.ui.setEditorText()` (no auto-send).
  The visualizer above the editor is a small row of red bars (14, with ANSI
  color codes) animated by a sine wave + a bit of random jitter: purely a
  visual recording indicator, it does not reflect the real audio. All paths are
  resolved relative to the extension: **zero hardcoded paths**.
- `setup.sh` — creates the venv (even without pip, via `ensurepip`), installs
  dependencies + model, cross-platform.
- `.gitignore` — excludes `.venv/`, `__pycache__/`, and models from versioning.
