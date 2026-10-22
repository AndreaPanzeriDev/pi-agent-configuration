#!/usr/bin/env bash
#
# setup.sh — reproduce this Pi configuration on a new machine (Linux / macOS).
#
# It will:
#   1. link every extension and skill into the Pi agent directory
#   2. install the example config files (only if not already present)
#   3. offer to run each extension's own setup.sh (native deps: Python, PortAudio, …)
#      (only for extensions that actually contain a setup.sh file)
#   4. validate MCP servers with `pi mcp list` (first run downloads Chromium)
#
# Usage:
#   git clone <repo> ~/pi-agent-config
#   ~/pi-agent-config/setup.sh             # full setup (asks per extension)
#   ~/pi-agent-config/setup.sh --no-native # skip system/Python deps
#   ~/pi-agent-config/setup.sh --skills-only # link skills without other setup
#   ~/pi-agent-config/setup.sh --yes       # run every extension setup without asking
#   ~/pi-agent-config/setup.sh --update    # pull the latest version from the
#                                          # remote repo, re-link extensions and
#                                          # refresh the already-installed setups
#
# Options:
#   --skills-only link only the skills; skip extensions, configs and MCP checks
#   --update      fetch the newest version of this repo (git pull), re-link the
#                 extensions/skills and re-run the setup of every extension that is
#                 already installed on this machine (no questions asked)
#   --no-native   link extensions/skills + install configs, but do NOT offer/run the
#                 per-extension native setup (Python venv, PortAudio, model…)
#   -y, --yes     run every per-extension setup.sh without asking
#                 (useful for automation)
#   -h, --help    show this help
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
DEST_DIR="$AGENT_DIR/extensions"

SKIP_NATIVE=0
AUTO_YES=0
DO_UPDATE=0
SKILLS_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --no-native|--skip-native) SKIP_NATIVE=1 ;;
    --skills-only) SKILLS_ONLY=1 ;;
    -y|--yes) AUTO_YES=1 ;;
    -u|--update) DO_UPDATE=1 ;;
    -h|--help)
      sed -n '3,/^set -euo pipefail/p' "$0" | sed '$d; s/^# \{0,1\}//'
      exit 0 ;;
    *) printf '\033[1;33m[!]\033[0m Ignored argument: %s\n' "$arg" ;;
  esac
done

log()  { printf '\033[1;34m[setup]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[✓]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }

log "Pi agent dir: $AGENT_DIR"

# --- 0. optional: pull the latest version from the online repo ---------------
# A per-extension "already installed" marker lives in the agent dir (machine
# local, never committed), so a fresh clone still asks for everything.
DONE_DIR="$AGENT_DIR/.setup-done"

if [ "$DO_UPDATE" -eq 1 ]; then
  if [ -d "$SCRIPT_DIR/.git" ] && command -v git >/dev/null 2>&1; then
    log "Updating repository from $(git -C "$SCRIPT_DIR" remote get-url origin 2>/dev/null || echo 'origin')…"
    if git -C "$SCRIPT_DIR" pull --ff-only; then
      ok "Repository updated."
    else
      warn "git pull failed (conflicts or no network): continuing with the local version"
    fi
  else
    warn "Not a git clone (or git is missing): skipping the update, using the local version"
  fi
fi

# is_voice_installed: venv + Whisper model already on this machine?
voice_installed() {
  local venv_dir="${VOICE_VENV_DIR:-$HOME/.pi/voice-venv}" venv_py hf_cache
  if [ -x "$venv_dir/bin/python" ]; then venv_py="$venv_dir/bin/python"
  elif [ -x "$venv_dir/Scripts/python.exe" ]; then venv_py="$venv_dir/Scripts/python.exe"
  else return 1; fi
  # faster-whisper / MLX whisper models all land in the Hugging Face cache.
  hf_cache="${HF_HOME:-$HOME/.cache/huggingface}/hub"
  [ -d "$hf_cache" ] && ls "$hf_cache" 2>/dev/null | grep -qi 'models--.*whisper'
}

# --- 1. link extensions ----------------------------------------------------
if [ "$SKILLS_ONLY" -eq 0 ]; then
mkdir -p "$DEST_DIR" "$DONE_DIR"
log "Linking extensions…"
for src in "$SCRIPT_DIR"/extensions/*; do
  [ -e "$src" ] || continue
  name="$(basename "$src")"
  target="$DEST_DIR/$name"

  # Already the same file (e.g. symlink) -> nothing to do.
  if [ -e "$target" ] && [ "$target" -ef "$src" ]; then
    ok "already present: $name"
    continue
  fi

  # Back up an existing, different entry so nothing is lost.
  if [ -e "$target" ] || [ -L "$target" ]; then
    warn "'$name' already exists: making a backup (*.bak)"
    mv "$target" "$target.bak.$(date +%s)"
  fi

  ln -s "$src" "$target"
  ok "linked: $name -> $src"
done
fi

# --- 1b. link skills (keep sibling paths intact for shared resources) --------
log "Linking skills…"
mkdir -p "$AGENT_DIR/skills"
for src in "$SCRIPT_DIR"/skills/*; do
  [ -f "$src/SKILL.md" ] || continue
  name="$(basename "$src")"
  target="$AGENT_DIR/skills/$name"
  if [ -e "$target" ] && [ "$target" -ef "$src" ]; then
    ok "already present: $name"
    continue
  fi
  if [ -e "$target" ] || [ -L "$target" ]; then
    warn "skill '$name' already exists: making a backup in skill-backups/"
    # Keep the backup outside skills/ so Pi does not discover it twice.
    mkdir -p "$AGENT_DIR/skill-backups"
    backup="$AGENT_DIR/skill-backups/$name.$(date +%s).$$"
    mv "$target" "$backup"
  fi
  ln -s "$src" "$target"
  ok "linked skill: $name -> $src"
done

if [ "$SKILLS_ONLY" -eq 1 ]; then
  ok "Skills linked. In Pi, run /reload to load them."
  exit 0
fi

# --- 2. install example config files (never overwrite) ---------------------
if [ -d "$SCRIPT_DIR/examples" ]; then
  log "Config files…"
  for f in "$SCRIPT_DIR"/examples/*.json; do
    [ -e "$f" ] || continue
    base="$(basename "$f")"
    if [ -e "$AGENT_DIR/$base" ]; then
      warn "config already exists, leaving it as is: $base"
    else
      cp "$f" "$AGENT_DIR/$base"
      ok "config installed: $base"
    fi
  done
fi

# --- 3. offer each extension's native setup ----------------------------------
# Ask for confirmation only for extensions that actually contain a setup.sh,
# using the folder name as the extension name.
SKIPPED_SETUPS=""
if [ "$SKIP_NATIVE" -eq 1 ]; then
  warn "--no-native: skipping native dependency setup"
  for s in "$SCRIPT_DIR"/extensions/*/setup.sh; do
    [ -e "$s" ] || continue
    SKIPPED_SETUPS="$SKIPPED_SETUPS $(basename "$(dirname "$s")")"
  done
else
  for s in "$SCRIPT_DIR"/extensions/*/setup.sh; do
    [ -e "$s" ] || continue
    name="$(basename "$(dirname "$s")")"
    answer=""

    # Already configured on this machine (marker from a previous successful
    # setup, or — for voice-to-chat — venv + model already present): in update
    # mode refresh it silently, otherwise don't ask again.
    if [ -e "$DONE_DIR/$name" ] || { [ "$name" = "voice-to-chat" ] && voice_installed; }; then
      if [ "$DO_UPDATE" -eq 1 ]; then
        log "Updating setup: $name"
        bash "$s" && touch "$DONE_DIR/$name" || warn "setup of '$name' not completed"
      else
        ok "$name: already configured (update with: $0 --update)"
      fi
      continue
    fi

    if [ "$AUTO_YES" -eq 1 ]; then
      answer="y"
    elif [ "$DO_UPDATE" -eq 1 ]; then
      # New extension arrived with the update: set it up without prompting.
      log "New extension from the update: $name"
      answer="y"
    elif [ ! -t 0 ]; then
      warn "non-interactive input: skipping setup of '$name'"
      SKIPPED_SETUPS="$SKIPPED_SETUPS $name"
      continue
    else
      printf '\033[1;34m[setup]\033[0m Do you want to set up %s too? (Y/n): ' "$name"
      read -r answer || answer="n"
    fi
    case "${answer:-Y}" in
      [Nn]|[Nn][Oo])
        warn "skipping setup of '$name' (you can run it later with: bash extensions/$name/setup.sh)"
        SKIPPED_SETUPS="$SKIPPED_SETUPS $name"
        ;;
      *)
        log "Setting up dependencies: $name"
        if bash "$s"; then touch "$DONE_DIR/$name"; else warn "setup of '$name' not completed"; fi
        ;;
    esac
  done
fi

# --- 4. validate MCP servers (downloads Playwright Chromium once) ---------------
if command -v pi >/dev/null 2>&1 && [ -e "$AGENT_DIR/mcp.json" ]; then
  log "Checking MCP servers (first run downloads Chromium, needs network)…"
  if pi mcp list; then
    ok "MCP servers reachable"
  else
    warn "'pi mcp list' reported problems (see above); retry with network enabled"
  fi
fi

# --- done ------------------------------------------------------------------
echo
if [ -n "$SKIPPED_SETUPS" ]; then
  warn "Initial setup not yet finished: still need to complete the setup of:$SKIPPED_SETUPS"
  for _name in $SKIPPED_SETUPS; do
    echo "  • bash extensions/$_name/setup.sh"
  done
  echo
fi
echo -e "\033[1;32m[✓] Pi configuration reproduced.\033[0m"
echo
echo "Next steps:"
echo "  • Log in to the providers:  pi   →   /login   (the keys in auth.json are not versioned)"
echo "  • In pi:  /reload   to load the extensions and skills"
echo "  • Learning: /skill:learn-plan followed by what you want to learn"
echo "  • Voice dictation:  Ctrl+Shift+M"
echo
