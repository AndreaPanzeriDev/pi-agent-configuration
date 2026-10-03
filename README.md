# pi-agent-config

My personal **[Pi coding agent](https://pi.dev)** configuration: cross-platform
extensions, automatic setup, and config files, in a single repo reproducible on
**Linux** and **macOS (Apple Silicon)**.

## Contents

| Path | What it is |
|------|------------|
| `extensions/voice-to-chat/` | **100% local** voice dictation. macOS → **MLX**, Linux/Windows → **faster-whisper** (CUDA when available). Cross-platform recording via `sounddevice`/PortAudio. |
| `extensions/btw/` | Side question (`/btw`), like in Claude Code: asks the same model with the current conversation as context, no tools, single answer in an overlay panel, without disturbing the main agent. |
| `extensions/pi-banner/` | Shows the session title (auto-generated from the first message) in the header, sticky line, and terminal title. `/title` command. |
| `extensions/token-stats/` | Token and cost counts per session, model, and project, with a daily chart. `/stats`, `/stats export`, `/stats prune`, `/stats reset` commands. |
| `extensions/response-sound/` | Plays a short sound when Pi finishes answering. `/sound` commands. Already cross-platform (`afplay`, `paplay`, …). |
| `setup.sh` | Reproduces the whole configuration on a new machine. |
| `examples/` | Example config files (`settings.json`, `models.json`, `mcp.json`, `response-sound.json`, `pi-banner.json`). |

## Browsing (MCP)

Two MCP servers in `examples/mcp.json`, installed by `setup.sh` (never
overwrites an existing `mcp.json`) and validated with `pi mcp list`:

| Server | Use it for |
|--------|------------|
| `fetch` | Backend lookups: fetch a URL, get clean markdown back, no browser window. |
| `playwright` | Full Chromium: navigate, click, type, DOM snapshot, **screenshots** — UI verification. |

The first `pi mcp list` downloads Playwright's Chromium (~200 MB, one time,
needs network) into `~/.cache/ms-playwright/`. Afterwards it works offline.

## Install on a new machine

```bash
git clone <your-URL> ~/pi-agent-config
~/pi-agent-config/setup.sh
```

The script:
1. links every extension into `~/.pi/agent/extensions/` (symlinks);
2. installs the example config files **only if they don't already exist**;
3. runs each extension's own `setup.sh` (for `voice-to-chat`: creates the Python
   venv, installs PortAudio + ffmpeg on macOS, and the Whisper model).

If you only want the links and configs, without installing native dependencies:

```bash
~/pi-agent-config/setup.sh --no-native
```

Then:
```bash
pi          # and inside:  /login   (API keys are NOT versioned)
```

### Alternative: as a Pi Package

The repo is also a valid **Pi Package**:

```bash
pi install git:github.com/<your-user>/<repo>
```

> Note: installing as a package does not run the native Python setup; for voice
> dictation you still need to run
> `extensions/voice-to-chat/setup.sh`.

## ⚠️ Security

- **`auth.json` is not in the repo** (it holds the API keys). On each machine
  redo `/login`, or copy it over manually in a secure way.
- `models.json` / `models-store.json` point to **local** endpoints (e.g.
  `http://localhost:8888`) — adjust them for your machines.

## Updating

```bash
cd ~/pi-agent-config && git pull
# if you added/modified extensions:
./setup.sh
```

## Structure

```
pi-agent-config/
├── package.json          # Pi Package manifest
├── setup.sh              # master installer (Linux/macOS), optional --no-native
├── .gitignore            # excludes auth.json, venv, __pycache__
├── extensions/
│   ├── voice-to-chat/
│   │   ├── index.ts        # Pi extension
│   │   ├── voice.py        # cross-platform Python backend (MLX / faster-whisper)
│   │   ├── voice_models.py # model name → MLX repo mapping
│   │   ├── setup.sh        # installs venv + PortAudio/ffmpeg + model
│   │   ├── README.md
│   │   └── .gitignore
│   ├── btw/              # side question panel (/btw)
│   │   └── index.ts
│   ├── pi-banner/          # session title + header
│   │   └── index.ts
│   ├── token-stats/      # token/cost stats (/stats)
│   │   └── index.ts
│   └── response-sound/     # answer sound (/sound)
│       └── index.ts
└── examples/
    ├── settings.json
    ├── models.json
    ├── response-sound.json
    └── pi-banner.json
```

## Quick test of the voice extension

```bash
~/.pi/voice-venv/bin/python ~/.pi/agent/extensions/voice-to-chat/voice.py \
    --wav my_recording.wav
```
