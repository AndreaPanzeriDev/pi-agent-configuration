#!/usr/bin/env python3
"""
Voice-to-chat recorder + transcriber — CROSS-PLATFORM, 100% local.

Records from the default audio input until it receives SIGINT (the user
presses the toggle key again), then transcribes the whole recording locally.
No external services (no OpenAI/Google/Azure): everything runs on-device.

Backend selection is automatic:

  * macOS (Apple Silicon, `darwin`) -> **MLX Whisper** (`mlx-whisper`) which
    runs on the Metal/Neural-Engine GPU. This is the fastest option on Mac.
  * Linux / Windows -> **faster-whisper** (CTranslate2). Uses CUDA on NVIDIA
    GPUs, and transparently falls back to CPU when no GPU is available.

Recording is done with `sounddevice` (PortAudio) so the *same* code path works
on Linux, macOS and Windows.

Usage:
    voice.py [--model NAME] [--language auto|it|en|...]
             [--device cuda|cpu|mps] [--compute-type T]
             [--initial-prompt TEXT] [--max-duration SECS] [--rate HZ]
             [--output FILE] [--wav FILE]   # --wav: transcribe a file (test)

While recording, prints a "REC" heartbeat to stderr every second.
Stop it with SIGINT (Ctrl-C / kill -INT).

On stop: prints the transcription to stdout and writes it to --output.
Exit code 0 on success, 3 if nothing was recorded or the transcription was
empty.
"""
from __future__ import annotations

import argparse
import os
import signal
import sys
import threading
import time

# --------------------------------------------------------------------------- #
# Backend detection
# --------------------------------------------------------------------------- #

PLATFORM = sys.platform  # "linux" | "darwin" | "win32"
IS_MAC = PLATFORM == "darwin"


def detect_backend() -> str:
    return "mlx" if IS_MAC else "faster-whisper"


try:
    if IS_MAC:
        import mlx_whisper  # noqa: F401  (import fails early if not installed)
    else:
        from faster_whisper import WhisperModel  # noqa: F401
except Exception as e:  # pragma: no cover
    name = "mlx-whisper" if IS_MAC else "faster-whisper"
    print(
        f"ERROR: {name} not available ({e}). "
        f"Run ./setup.sh to install it.",
        file=sys.stderr,
    )
    sys.exit(2)

try:
    import sounddevice as sd  # cross-platform recording (PortAudio)
except Exception as e:  # pragma: no cover
    # `sounddevice` imports fine, but needs the system PortAudio library
    # (libportaudio) which is loaded lazily. Surface the real reason.
    print(
        "ERROR: audio recording unavailable "
        f"({e}). Install PortAudio and run ./setup.sh.",
        file=sys.stderr,
    )
    sys.exit(2)


# --------------------------------------------------------------------------- #
# Whisper model defaults per backend
# --------------------------------------------------------------------------- #

# Best-quality model on every platform. On CPU-only machines the caller can
# downgrade it with VOICE_MODEL (see below).
DEFAULT_MODELS = {
    "mlx": "large-v3-turbo",          # Apple Silicon (MLX)
    "faster-whisper": "large-v3-turbo",  # CUDA
}

# Smaller, faster model used when the big one is auto-selected but we are on
# CPU (the big model would be painfully slow).
DEFAULT_CPU_MODEL = "medium"


def _resolve_language(value):
    """Return a Whisper language code, or None to auto-detect."""
    if not value or value.strip().lower() == "auto":
        return None
    value = value.strip().lower()
    aliases = {
        "afrikaans": "af", "arabic": "ar", "chinese": "zh", "czech": "cs",
        "danish": "da", "dutch": "nl", "english": "en", "finnish": "fi",
        "french": "fr", "german": "de", "greek": "el", "hebrew": "he",
        "hungarian": "hu", "italian": "it", "japanese": "ja", "korean": "ko",
        "norwegian": "no", "polish": "pl", "portuguese": "pt", "romanian": "ro",
        "russian": "ru", "spanish": "es", "swedish": "sv", "turkish": "tr",
        "ukrainian": "uk",
    }
    if value in aliases:
        value = aliases[value]
    # Fail fast with a clear message instead of crashing inside Whisper.
    known = {
        "af", "ar", "zh", "cs", "da", "nl", "en", "fi", "fr", "de", "el",
        "he", "hu", "it", "ja", "ko", "no", "pl", "pt", "ro", "ru", "es",
        "sv", "tr", "uk",
    }
    if known and value not in known:
        raise SystemExit(
            f"ERROR: invalid language '{value}'. Use 'auto', a code "
            "(it, en, ...) or a name (italian, english, ...)."
        )
    return value


# --------------------------------------------------------------------------- #
# Recording (cross-platform via PortAudio / sounddevice)
# --------------------------------------------------------------------------- #

FRAME_MS = 20
_recording = True


def _on_sigint(signum, frame):
    global _recording
    _recording = False


def _dev_get(dev, key, default=None):
    """Read a field from a sounddevice device entry.

    Newer sounddevice versions return plain dicts from query_devices(),
    older ones return Device objects. Support both.
    """
    if isinstance(dev, dict):
        return dev.get(key, default)
    return getattr(dev, key, default)


def _write_wav(path, audio, rate):
    """Pack raw PCM int16 mono into a WAV file (no external libs needed)."""
    audio = bytes(audio)
    with open(path, "wb") as f:
        f.write(b"RIFF")
        f.write((len(audio) + 36).to_bytes(4, "little"))
        f.write(b"WAVE")
        f.write(b"fmt ")
        f.write((16).to_bytes(4, "little"))          # PCM header size
        f.write((1).to_bytes(2, "little"))            # PCM format
        f.write((1).to_bytes(2, "little"))            # mono
        f.write((rate).to_bytes(4, "little"))
        f.write((rate * 2).to_bytes(4, "little"))     # byte rate
        f.write((2).to_bytes(2, "little"))            # block align
        f.write((16).to_bytes(2, "little"))           # bits per sample
        f.write(b"data")
        f.write((len(audio)).to_bytes(4, "little"))
        f.write(audio)


def record_audio(rate, max_duration):
    """Record until SIGINT or max_duration. Returns raw PCM bytes (int16)."""
    global _recording
    _recording = True
    signal.signal(signal.SIGINT, _on_sigint)

    # Accept ANY device that has at least one input channel. On Linux the
    # underlying host API is usually ALSA/PulseAudio/Jack (NOT "PortAudio"),
    # so we must not filter by host_api_name.
    devices = list(sd.query_devices())
    input_devices = [
        dev for dev in devices
        if int(_dev_get(dev, "max_input_channels", 0) or 0) > 0
    ]
    if not input_devices:
        available = ", ".join(
            f"#{i} {_dev_get(dev, 'name', '?')} "
            f"(in={_dev_get(dev, 'max_input_channels', 0)})"
            for i, dev in enumerate(devices)
        ) or "(nessuno)"
        print(
            "[voice] no audio input device found. "
            f"Devices: {available}. "
            "Check your microphone and alsamixer (F4 = capture).",
            file=sys.stderr,
        )
        return None, 0.0

    n_frames = rate * FRAME_MS // 1000  # frames per 20 ms block (mono, 16-bit)

    audio = bytearray()
    start = time.time()
    last_beat = 0.0
    stream = sd.RawInputStream(samplerate=rate, channels=1, dtype="int16")
    stream.start()
    try:
        while _recording and (time.time() - start) < max_duration:
            chunk, overflowed = stream.read(n_frames)
            if chunk is None:
                break
            audio += bytes(chunk)
            now = time.time() - start
            if now - last_beat >= 1.0:
                last_beat = now
                print(f"[voice] REC {now:.1f}s", file=sys.stderr)
                sys.stderr.flush()
    finally:
        stream.stop()
        stream.close()

    duration = len(audio) / (rate * 2)
    if duration < 0.3:
        print(f"[voice] recording too short ({duration:.2f}s).", file=sys.stderr)
        return None, duration
    return bytes(audio), duration


# --------------------------------------------------------------------------- #
# Transcription backends
# --------------------------------------------------------------------------- #

def _transcribe_faster_whisper(wav_path, args):
    device = args.device
    if device == "cuda":
        try:
            compute = args.compute_type or "float16"
            model = WhisperModel(args.model, device="cuda", compute_type=compute)
            print(f"[voice] device: cuda ({compute})", file=sys.stderr)
            return model, "cuda", compute
        except Exception as e:
            print(f"[voice] cuda unavailable ({e}); falling back to cpu.",
                  file=sys.stderr)
            if getattr(args, "model_was_auto", False):
                args.model = DEFAULT_CPU_MODEL
            device = "cpu"
    compute = args.compute_type or "int8"
    if compute not in ("int8", "int8_float32", "float32"):
        compute = "int8"
    print(f"[voice] device: cpu ({compute})", file=sys.stderr)
    return WhisperModel(args.model, device="cpu", compute_type=compute), "cpu", compute


def _transcribe_mlx(wav_path, args):
    """MLX Whisper (Apple Silicon GPU via Metal)."""
    model_name = args.model
    print(f"[voice] device: mps ({model_name})", file=sys.stderr)
    return model_name


def _run_transcribe(wav_path, args, backend):
    if backend == "mlx":
        model_ref = _transcribe_mlx(wav_path, args)
        result = mlx_whisper.transcribe(
            wav_path,
            model_name=model_ref,
            language=_resolve_language(args.language) or None,
            initial_prompt=args.initial_prompt or None,
        )
        text = "".join(seg["text"] for seg in result["segments"]).strip()
        lang = result.get("language", "?")
        lang_prob = result.get("language_probability", 1.0)
        return text, lang, lang_prob
    else:
        model, dev, compute = _transcribe_faster_whisper(wav_path, args)
        segments, info = model.transcribe(
            wav_path,
            language=_resolve_language(args.language),
            vad_filter=True,
            beam_size=args.beam_size,
            condition_on_previous_text=False,
            initial_prompt=args.initial_prompt or None,
        )
        text = "".join(s.text for s in segments).strip()
        return text, info.language, info.language_probability


def transcribe_wav(wav_path, args, backend):
    print(f"[voice] transcribing file {wav_path} (backend={backend})", file=sys.stderr)
    text, lang, lang_prob = _run_transcribe(wav_path, args, backend)
    if not text:
        print("[voice] transcription came out empty.", file=sys.stderr)
        return 3
    print(f"[voice] language: {lang} ({lang_prob:.2f}) on {backend}", file=sys.stderr)
    _emit(text, args)
    return 0


def record_and_transcribe(args, backend):
    global _recording
    audio, duration = record_audio(args.rate, args.max_duration)
    if audio is None:
        return 3

    print(f"[voice] stopped after {duration:.1f}s, transcribing...", file=sys.stderr)
    sys.stderr.flush()

    wav_path = os.path.join("/tmp", f"pi_voice_{os.getpid()}.wav")
    _write_wav(wav_path, audio, args.rate)

    text, lang, lang_prob = _run_transcribe(wav_path, args, backend)
    try:
        os.remove(wav_path)
    except OSError:
        pass

    if not text:
        print("[voice] transcription came out empty.", file=sys.stderr)
        return 3

    print(f"[voice] language: {lang} ({lang_prob:.2f})", file=sys.stderr)
    _emit(text, args)
    return 0


def _emit(text, args):
    output = args.output or os.path.join("/tmp", "pi_voice_result.txt")
    with open(output, "w", encoding="utf-8") as f:
        f.write(text)
    print(text)
    sys.stderr.flush()


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #

def main():
    try:
        _main()
    except SystemExit:
        raise
    except Exception as e:  # never leak a raw traceback into pi's log
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


def _main():
    p = argparse.ArgumentParser(description="Cross-platform local voice-to-chat")
    p.add_argument("--model", default=os.environ.get("VOICE_MODEL"),
                   help="Whisper model (per-backend default when omitted)")
    p.add_argument("--language", default=os.environ.get("VOICE_LANGUAGE", "auto"))
    p.add_argument("--device", default=os.environ.get("VOICE_DEVICE",
                   "mps" if IS_MAC else "cuda"))
    p.add_argument("--compute-type", default=os.environ.get("VOICE_COMPUTE_TYPE"))
    p.add_argument("--initial-prompt", default=os.environ.get("VOICE_PROMPT", ""))
    p.add_argument("--max-duration", type=float, default=120.0)
    p.add_argument("--rate", type=int, default=16000)
    p.add_argument("--beam-size", type=int, default=int(
        os.environ.get("VOICE_BEAM_SIZE", "5")))
    p.add_argument("--output")
    p.add_argument("--wav", help="Transcribe an existing WAV file instead of recording")
    args = p.parse_args()

    backend = detect_backend()

    if not args.model:
        args.model = DEFAULT_MODELS[backend]
        if backend == "faster-whisper" and args.device == "cpu":
            args.model = DEFAULT_CPU_MODEL
        args.model_was_auto = True

    if args.wav:
        sys.exit(transcribe_wav(args.wav, args, backend))
    sys.exit(record_and_transcribe(args, backend))


if __name__ == "__main__":
    main()
