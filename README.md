# pi-agent-config

My personal **[Pi coding agent](https://pi.dev)** configuration: cross-platform
extensions, automatic setup, and config files, in a single repo reproducible on
**Linux** and **macOS (Apple Silicon and Intel)**.

## Contents

| Path | What it is |
|------|------------|
| `extensions/voice-to-chat/` | **100% local** voice dictation. macOS Apple Silicon → **MLX**, macOS Intel / Linux / Windows → **faster-whisper** (CUDA when available). Cross-platform recording via `sounddevice`/PortAudio. |
| `extensions/btw/` | Side question (`/btw`): answer in an overlay panel above the current chat, without leaving the session. Fresh context (repo only, no chat history) with **all tools** — built-ins, extensions, MCP servers, skills. Same model and thinking level, ephemeral (`--no-session`). `/btw -c <question>` also includes the current conversation as reference. |
| `extensions/auto-compact/` | Compacts the session at a configurable percentage of the context window (default 85%), earlier than Pi's built-in guard. `/autocompact` command. |
| `extensions/pi-banner/` | Shows the session title (auto-generated from the first message) in the header, sticky line, and terminal title. `/title` command. |
| `extensions/token-stats/` | Token and cost counts per session, model, and project, with a daily chart. `/stats`, `/stats export`, `/stats prune`, `/stats reset` commands. |
| `extensions/tok-speed/` | Replaces the footer stats line with the output tokens-per-second rate of the last assistant response, inline next to the token/cost numbers.
| `extensions/response-sound/` | Plays a short sound when Pi finishes answering. `/sound` commands. Already cross-platform (`afplay`, `paplay`, …). |
| `extensions/daily-report/` | Day report (`/report`, `/daily`): fast table of the day sessions + AI summary of done/not-finished work, with markdown export. |
| `setup.sh` | Reproduces the whole configuration on a new machine. |
| `skills/learn-plan/`, `skills/learn-study/`, `skills/learn-quiz/` | Adaptive learning paths, a local interactive roadmap, and Markdown lessons/quizzes for Obsidian. Shared Node.js runtime, no extra dependencies. |
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
1. checks the required tools (`pi`, Node.js >= 20, `npx`, Python 3) and warns
   early about anything missing;
2. links every extension into `~/.pi/agent/extensions/` and every skill into
   `~/.pi/agent/skills/` (symlinks), removing stale links and keeping backups
   outside the directories Pi scans;
3. installs the example config files **only if they don't already exist**;
4. runs each extension's own `setup.sh` (for `voice-to-chat`: creates the Python
   venv, installs PortAudio + ffmpeg when needed, downloads the model matching
   the detected CPU/CUDA/MLX backend, and verifies the runtime).

Existing configs are never overwritten. If `settings.json` or `models.json` is
newly copied, the script warns that the examples point to **local endpoints**
(`localhost`) and must be adjusted for the current machine.

If you only want the links and configs, without installing native dependencies:

```bash
~/pi-agent-config/setup.sh --no-native
```

Other options: `--skills-only` links only the learning skills, `--yes` runs
every native setup without asking, and `--update` pulls the latest version and
refreshes the extensions already configured on this machine.

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

## Learning skills

Run `./setup.sh --skills-only` to link the three skills, then `/reload` in Pi.
The full setup and `--no-native` also link them.
Installing this repository as a Pi package also discovers `skills/` automatically.
Keep all three `learn-*` folders together: study and quiz use the runtime and
format reference bundled with `learn-plan`. Node.js >= 20 is the only runtime
requirement; there is no npm install step for these skills.

```text
/skill:learn-plan Voglio imparare algebra, ho tre ore a settimana
/skill:learn-study percorso "/absolute/path/apprendimento/algebra" nodo equazioni
/skill:learn-quiz percorso "/absolute/path/apprendimento/algebra" nodo equazioni
```

`learn-plan` asks one question at a time, diagnoses prerequisites, and builds a
path tailored to your goal. `learn-study` saves explanations, examples and your
attempts in Markdown; `learn-quiz` records actual answers, feedback and review
dates. The skills cover any subject supported by your Pi model and tools.
Mermaid/UML diagrams work directly in Obsidian; generated images require an
image tool available to your Pi session.

By default courses live under `./apprendimento/` (ignored by Git). Set
`PI_LEARN_ROOT` before starting Pi, or name an explicit folder, to use a vault:

```bash
export PI_LEARN_ROOT="/absolute/path/to/your/Obsidian vault/apprendimento"
pi
```

Each course has one authoritative `percorso.json` (plan, progress and history),
`mappa.html`, `indice.md`, and `lezioni/`, `esercizi/`, `quiz/`, `diario/`,
`allegati/` folders. Manual completion and quiz verification remain separate.
Markdown notes are preserved when paths are revised. Back up the whole course
folder to include notes and attachments.

The map needs the local service to save clicks to disk. A direct `file://` opening
is a read-only snapshot with the launch command displayed. The service binds to
`127.0.0.1`, prints its URL and runs until Ctrl+C. Use the browser on the same
computer as Pi (or forward the printed port if Pi runs remotely).
It saves atomically and detects competing browser/agent edits. The map polls
for changes and offers commands to copy back into Pi; it does not call an AI
model itself. Review dates are displayed in the path and do not send reminders.

Try the example in a disposable folder (it is demo data, not your actual level):

```bash
node skills/learn-plan/scripts/learn.mjs init /tmp/pi-learn-demo --from examples/learning/plan.json
node skills/learn-plan/scripts/learn.mjs serve /tmp/pi-learn-demo
```

Open the printed URL, click a node, choose its state and press **Salva
avanzamento**. Reload the browser or restart the service: the change remains
in `/tmp/pi-learn-demo/percorso.json`. `mappa.html` and the generated part of
`indice.md` are refreshed after each change. Use `render COURSE_FOLDER` to
rebuild those views if needed. `npm test` exercises persistence, quiz events,
plan revisions, conflicts and the local HTTP API. The data format and commands
are documented in [the shared reference](skills/learn-plan/references/workflow.md).

## Updating

```bash
cd ~/pi-agent-config
./setup.sh --update
```

`--update` does a `git pull --ff-only`, re-links all extensions and skills, and
re-runs the native setup of every extension that is already configured on this
machine (for example, to refresh the Python venv and Whisper model). It does
not silently run a setup you previously skipped: run that extension's
`setup.sh` manually when you want it.

If you prefer to pull manually:

```bash
cd ~/pi-agent-config && git pull
./setup.sh
```

A plain `./setup.sh` links new or changed resources and asks only for setups
that are still missing; it leaves already-configured native setups alone.

## Structure

```
pi-agent-config/
├── package.json          # Pi Package manifest
├── setup.sh              # master installer (Linux/macOS), optional --no-native
├── .gitignore            # excludes auth.json, venv, __pycache__
├── skills/
│   ├── learn-plan/       # interview, roadmap, shared runtime + HTML template
│   ├── learn-study/      # incremental Markdown lessons
│   └── learn-quiz/       # quizzes, evidence and review dates
├── extensions/
│   ├── voice-to-chat/
│   │   ├── index.ts        # Pi extension
│   │   ├── voice.py        # cross-platform Python backend (MLX / faster-whisper)
│   │   ├── voice_models.py # model name → MLX repo mapping
│   │   ├── setup.sh        # installs venv + PortAudio/ffmpeg + model
│   │   ├── README.md
│   │   └── .gitignore
│   ├── btw/                # side question panel (/btw)
│   │   └── index.ts
│   ├── auto-compact/       # earlier context-window compaction (/autocompact)
│   │   └── index.ts
│   ├── pi-banner/          # session title + header
│   │   └── index.ts
│   ├── token-stats/        # token/cost stats (/stats)
│   │   └── index.ts
│   ├── tok-speed/          # output tokens/sec in the footer
│   │   └── index.ts
│   ├── response-sound/     # answer sound (/sound)
│   │   └── index.ts
│   └── daily-report/       # day report (/report, /daily)
│       └── index.ts
└── examples/
    ├── settings.json
    ├── models.json
    ├── mcp.json
    ├── response-sound.json
    └── pi-banner.json
```

## Quick test of the voice extension

```bash
~/.pi/voice-venv/bin/python ~/.pi/agent/extensions/voice-to-chat/voice.py \
    --wav my_recording.wav
```
