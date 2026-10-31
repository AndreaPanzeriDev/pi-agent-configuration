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
SKILLS_DIR="$AGENT_DIR/skills"
DONE_DIR="$AGENT_DIR/.setup-done"
SKIPPED_DIR="$AGENT_DIR/.setup-skipped"
BACKUP_DIR="$AGENT_DIR/extension-backups"
SKILL_BACKUP_DIR="$AGENT_DIR/skill-backups"

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
    *)
      printf '\033[1;31m[✗]\033[0m Unknown argument: %s\n' "$arg" >&2
      printf 'Try: %s --help\n' "$0" >&2
      exit 2 ;;
  esac
done

log()  { printf '\033[1;34m[setup]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[✓]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[✗]\033[0m %s\n' "$*" >&2; exit 1; }

log "Pi agent dir: $AGENT_DIR"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Print the installed Node major version, or 0 when Node is unavailable.
node_major() {
  command -v node >/dev/null 2>&1 || { echo 0; return; }
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

# Validate a JSON file when Node is available (best effort).
json_valid() {
  command -v node >/dev/null 2>&1 || return 0
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$1" >/dev/null 2>&1
}

# True when the extension is already configured on this machine.
# voice-to-chat is special: a marker is not enough if the venv or model is gone.
native_configured() {
  local name="$1"
  if [ "$name" = "voice-to-chat" ]; then
    voice_installed
  else
    [ -e "$DONE_DIR/$name" ]
  fi
}

# is_voice_installed: venv + runtime + the exact Whisper model on this machine?
voice_installed() {
  local venv_dir="${VOICE_VENV_DIR:-$HOME/.pi/voice-venv}" venv_py model repo
  if [ -x "$venv_dir/bin/python" ]; then venv_py="$venv_dir/bin/python"
  elif [ -x "$venv_dir/Scripts/python.exe" ]; then venv_py="$venv_dir/Scripts/python.exe"
  else return 1; fi

  # PortAudio is loaded when sounddevice is imported.
  "$venv_py" -c "import sounddevice" >/dev/null 2>&1 || return 1

  # The backend must be importable too (MLX on Apple Silicon, faster-whisper
  # everywhere else). MLX additionally shells out to ffmpeg.
  case "$(uname -s)/$(uname -m)" in
    Darwin/arm64|Darwin/aarch64)
      "$venv_py" -c "import mlx_whisper" >/dev/null 2>&1 || return 1
      command -v ffmpeg >/dev/null 2>&1 || return 1 ;;
    *)
      "$venv_py" -c "import faster_whisper" >/dev/null 2>&1 || return 1 ;;
  esac

  # The setup writes the chosen model to voice-to-chat.json. Validate that
  # exact model: a marker (or some other cached model) is not enough.
  model=""
  if [ -f "$AGENT_DIR/voice-to-chat.json" ]; then
    model="$("$venv_py" - "$AGENT_DIR/voice-to-chat.json" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as f:
        value = json.load(f).get("model", "")
    print(value if isinstance(value, str) else "")
except Exception:
    print("")
PY
)" || model=""
  fi

  # No config yet (legacy install): check the model the runtime would pick by
  # default, so a CPU-only machine with only large-v3-turbo cached is not
  # mistaken for a complete install (and vice versa).
  if [ -z "$model" ]; then
    case "$(uname -s)/$(uname -m)" in
      Darwin/arm64|Darwin/aarch64)
        model="large-v3-turbo" ;;
      *)
        if "$venv_py" - <<'PY' >/dev/null 2>&1
import ctranslate2
ctranslate2.get_supported_compute_types("cuda")
PY
        then
          model="large-v3-turbo"
        else
          model="medium"
        fi
        ;;
    esac
  fi

  # A local model directory is ready as-is.
  [ -d "$model" ] && return 0

  # Ask the same libraries the runtime uses to resolve the model from the local
  # cache only (no network). This handles aliases and repo ids exactly.
  case "$(uname -s)/$(uname -m)" in
    Darwin/arm64|Darwin/aarch64)
      repo="$("$venv_py" "$SCRIPT_DIR/extensions/voice-to-chat/voice_models.py" "$model" 2>/dev/null || true)"
      [ -n "$repo" ] || return 1
      if "$venv_py" - "$repo" <<'PY' >/dev/null 2>&1
import sys
from huggingface_hub import snapshot_download

snapshot_download(repo_id=sys.argv[1], local_files_only=True)
PY
      then
        return 0
      fi
      ;;
    *)
      if "$venv_py" - "$model" <<'PY' >/dev/null 2>&1
import sys
from faster_whisper.utils import download_model

download_model(sys.argv[1], local_files_only=True)
PY
      then
        return 0
      fi
      ;;
  esac
  return 1
}

# Old versions of this script created backups inside extensions/ (for example
# "btw.bak.1690000000"). Pi discovers every subdirectory containing index.ts,
# so move those leftovers out before linking.
migrate_old_extension_backups() {
  local entry base dest
  for entry in "$DEST_DIR"/*.bak.[0-9]*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    base="$(basename "$entry")"
    dest="$BACKUP_DIR/$base"
    warn "moving old extension backup out of extensions/: $base"
    mkdir -p "$BACKUP_DIR"
    mv "$entry" "$dest"
  done
}

# Remove broken symlinks that point into one of our source trees.
prune_stale_links() {
  local dir="$1" root="$2" link target
  [ -d "$dir" ] || return 0
  while IFS= read -r -d '' link; do
    target="$(readlink "$link" 2>/dev/null || true)"
    case "$target" in
      "$root"/*)
        if [ ! -e "$target" ]; then
          warn "removing stale link: ${link#"$AGENT_DIR"/} -> $target"
          rm -f "$link"
        fi
        ;;
    esac
  done < <(find "$dir" -type l -print0 2>/dev/null)
}

# True when a directory is an extension Pi can load.
is_extension_dir() {
  [ -d "$1" ] && { [ -f "$1/index.ts" ] || [ -f "$1/index.js" ]; }
}

# True when a file is a standalone extension Pi can load.
is_extension_file() {
  [ -f "$1" ] || return 1
  case "$1" in
    *.ts|*.js) return 0 ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# Preflight: report missing runtime dependencies early.
# ---------------------------------------------------------------------------

check_preflight() {
  local major

  if command -v pi >/dev/null 2>&1; then
    ok "pi: $(pi --version 2>/dev/null || echo 'found')"
  else
    warn "pi not found in PATH: links/configs will be created, but MCP validation is skipped."
  fi

  major="$(node_major)"
  if [ "$major" -ge 20 ] 2>/dev/null; then
    ok "node: $(node --version 2>/dev/null)"
  elif [ "$major" -gt 0 ] 2>/dev/null; then
    warn "Node.js >= 20 is required by the learning skills (found $(node --version 2>/dev/null))."
  else
    warn "Node.js not found: the learning skills require node >= 20."
  fi

  if [ "$SKILLS_ONLY" -eq 1 ]; then
    return 0
  fi

  if ! command -v npx >/dev/null 2>&1; then
    warn "npx not found: the MCP servers in mcp.json need Node/npm (npx)."
  fi

  if ! command -v python3 >/dev/null 2>&1 && ! command -v python >/dev/null 2>&1; then
    warn "Python 3 not found: voice-to-chat cannot be installed."
  fi
}

check_preflight

# --- 0. optional: pull the latest version from the online repo ---------------
# A per-extension "already installed" marker lives in the agent dir (machine
# local, never committed), so a fresh clone still asks for everything.
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

# --- 1. link extensions ----------------------------------------------------
if [ "$SKILLS_ONLY" -eq 0 ]; then
  mkdir -p "$DEST_DIR"
  migrate_old_extension_backups
  prune_stale_links "$DEST_DIR" "$SCRIPT_DIR/extensions"
  log "Linking extensions…"
  for src in "$SCRIPT_DIR"/extensions/*; do
    [ -e "$src" ] || continue

    if [ -d "$src" ]; then
      if ! is_extension_dir "$src"; then
        warn "skipping non-extension directory: $(basename "$src")"
        continue
      fi
    elif is_extension_file "$src"; then
      :
    else
      warn "skipping non-extension entry: $(basename "$src")"
      continue
    fi

    name="$(basename "$src")"
    target="$DEST_DIR/$name"

    # Already the same file (e.g. symlink) -> nothing to do.
    if [ -e "$target" ] && [ "$target" -ef "$src" ]; then
      ok "already present: $name"
      continue
    fi

    # Back up an existing, different entry so nothing is lost. Backups live
    # OUTSIDE extensions/ so Pi never discovers and loads them.
    if [ -e "$target" ] || [ -L "$target" ]; then
      backup="$BACKUP_DIR/$name.$(date +%s).$$"
      warn "'$name' already exists: moving it to $backup"
      mkdir -p "$BACKUP_DIR"
      mv "$target" "$backup"
    fi

    ln -s "$src" "$target"
    ok "linked: $name -> $src"
  done
fi

# --- 1b. link skills (keep sibling paths intact for shared resources) --------
# Link skill roots only. If a skill contains nested skills, linking the root is
# enough because Pi discovers SKILL.md recursively.
mkdir -p "$SKILLS_DIR"
prune_stale_links "$SKILLS_DIR" "$SCRIPT_DIR/skills"
log "Linking skills…"
while IFS= read -r -d '' skill_md; do
  src="$(dirname "$skill_md")"
  rel="${src#"$SCRIPT_DIR/skills/"}"
  [ -n "$rel" ] || continue

  # Skip a nested skill when one of its ancestors is already a skill root.
  skip_nested=0
  ancestor="$(dirname "$src")"
  while [ "$ancestor" != "$SCRIPT_DIR/skills" ] && [ "$ancestor" != "/" ]; do
    if [ -f "$ancestor/SKILL.md" ]; then
      skip_nested=1
      break
    fi
    ancestor="$(dirname "$ancestor")"
  done
  [ "$skip_nested" -eq 0 ] || continue

  name="$(basename "$src")"
  target="$SKILLS_DIR/$rel"
  if [ -e "$target" ] && [ "$target" -ef "$src" ]; then
    ok "already present: $rel"
    continue
  fi
  if [ -e "$target" ] || [ -L "$target" ]; then
    warn "skill '$rel' already exists: making a backup in skill-backups/"
    # Keep the backup outside skills/ so Pi does not discover it twice.
    mkdir -p "$SKILL_BACKUP_DIR"
    backup_name="$(printf '%s' "$rel" | tr '/' '_')"
    backup="$SKILL_BACKUP_DIR/$backup_name.$(date +%s).$$"
    mv "$target" "$backup"
  fi
  mkdir -p "$(dirname "$target")"
  ln -s "$src" "$target"
  ok "linked skill: $rel -> $src"
done < <(find "$SCRIPT_DIR/skills" -type f -name SKILL.md -print0 2>/dev/null)

if [ "$SKILLS_ONLY" -eq 1 ]; then
  ok "Skills linked. In Pi, run /reload to load them."
  exit 0
fi

mkdir -p "$DONE_DIR" "$SKIPPED_DIR"

# --- 2. install example config files (never overwrite) ---------------------
COPIED_LOCAL_CONFIG=0
if [ -d "$SCRIPT_DIR/examples" ]; then
  log "Config files…"
  for f in "$SCRIPT_DIR"/examples/*.json; do
    [ -e "$f" ] || continue
    base="$(basename "$f")"

    if ! json_valid "$f"; then
      warn "example config is not valid JSON, skipping: $base"
      continue
    fi

    if [ -e "$AGENT_DIR/$base" ]; then
      if ! json_valid "$AGENT_DIR/$base"; then
        warn "existing config is not valid JSON: $base"
      else
        warn "config already exists, leaving it as is: $base"
      fi
    else
      cp "$f" "$AGENT_DIR/$base"
      ok "config installed: $base"
      case "$base" in
        settings.json|models.json) COPIED_LOCAL_CONFIG=1 ;;
      esac
    fi
  done
fi

if [ "$COPIED_LOCAL_CONFIG" -eq 1 ]; then
  warn "settings.json/models.json point to local endpoints (localhost)."
  warn "Adjust them, or Pi may start with a model that is not reachable."
fi

# --- 3. offer each extension's native setup ----------------------------------
# Ask for confirmation only for extensions that actually contain a setup.sh,
# using the folder name as the extension name.
SKIPPED_SETUPS=""
FAILED_SETUPS=""
VOICE_READY=0

for s in "$SCRIPT_DIR"/extensions/*/setup.sh; do
  [ -e "$s" ] || continue
  name="$(basename "$(dirname "$s")")"

  if [ "$name" = "voice-to-chat" ] && voice_installed; then
    VOICE_READY=1
  fi

  # --no-native never runs a setup, but it should not call an already
  # configured extension "incomplete".
  if [ "$SKIP_NATIVE" -eq 1 ]; then
    if native_configured "$name"; then
      ok "$name: already configured"
      touch "$DONE_DIR/$name" 2>/dev/null || true
    else
      warn "$name: native setup not installed (--no-native)"
      SKIPPED_SETUPS="$SKIPPED_SETUPS $name"
    fi
    continue
  fi

  # Already configured on this machine: in update mode refresh it silently,
  # otherwise don't ask again. voice-to-chat is validated by native_configured
  # so a deleted venv/model is repaired instead of trusted blindly.
  if native_configured "$name"; then
    touch "$DONE_DIR/$name" 2>/dev/null || true
    if [ "$DO_UPDATE" -eq 1 ]; then
      log "Updating setup: $name"
      if bash "$s"; then
        touch "$DONE_DIR/$name"
        rm -f "$SKIPPED_DIR/$name"
        ok "$name: setup updated"
      else
        warn "setup of '$name' not completed"
        FAILED_SETUPS="$FAILED_SETUPS $name"
      fi
    else
      ok "$name: already configured (update with: $0 --update)"
    fi
    continue
  fi

  answer=""
  if [ "$AUTO_YES" -eq 1 ]; then
    answer="y"
  elif [ "$DO_UPDATE" -eq 1 ]; then
    # Do not silently run a setup the user explicitly skipped before.
    if [ -e "$SKIPPED_DIR/$name" ]; then
      warn "$name: previously skipped, leaving it skipped (run: bash extensions/$name/setup.sh)"
      SKIPPED_SETUPS="$SKIPPED_SETUPS $name"
      continue
    fi
    # New extension arrived with the update: set it up without prompting.
    log "New extension from the update: $name"
    answer="y"
  elif [ ! -t 0 ]; then
    warn "non-interactive input: skipping setup of '$name'"
    touch "$SKIPPED_DIR/$name"
    SKIPPED_SETUPS="$SKIPPED_SETUPS $name"
    continue
  else
    printf '\033[1;34m[setup]\033[0m Do you want to set up %s too? (Y/n): ' "$name"
    read -r answer || answer="n"
  fi

  case "${answer:-Y}" in
    [Nn]|[Nn][Oo])
      warn "skipping setup of '$name' (you can run it later with: bash extensions/$name/setup.sh)"
      touch "$SKIPPED_DIR/$name"
      SKIPPED_SETUPS="$SKIPPED_SETUPS $name"
      ;;
    *)
      log "Setting up dependencies: $name"
      if bash "$s"; then
        touch "$DONE_DIR/$name"
        rm -f "$SKIPPED_DIR/$name"
        ok "$name: setup completed"
        [ "$name" = "voice-to-chat" ] && VOICE_READY=1
      else
        warn "setup of '$name' not completed"
        FAILED_SETUPS="$FAILED_SETUPS $name"
      fi
      ;;
  esac
done

# --- 4. validate MCP servers (downloads Playwright Chromium once) ---------------
if [ -e "$AGENT_DIR/mcp.json" ]; then
  if ! command -v pi >/dev/null 2>&1; then
    warn "pi not found: skipping MCP validation"
  elif ! command -v npx >/dev/null 2>&1; then
    warn "npx not found: skipping MCP validation"
  else
    log "Checking MCP servers (first run downloads Chromium, needs network)…"
    # Run from $HOME so a project-local .pi/mcp.json is not validated by mistake.
    if command -v timeout >/dev/null 2>&1; then
      mcp_ok=0
      (cd "$HOME" && timeout 180 pi mcp list) || mcp_ok=$?
    elif command -v gtimeout >/dev/null 2>&1; then
      mcp_ok=0
      (cd "$HOME" && gtimeout 180 pi mcp list) || mcp_ok=$?
    else
      mcp_ok=0
      (cd "$HOME" && pi mcp list) || mcp_ok=$?
    fi
    if [ "$mcp_ok" -eq 0 ]; then
      ok "MCP servers reachable"
    else
      warn "'pi mcp list' reported problems (see above); retry with network enabled"
    fi
  fi
fi

# --- done ------------------------------------------------------------------
echo
if [ -n "$FAILED_SETUPS" ]; then
  warn "Native setup failed for:$FAILED_SETUPS"
fi
if [ -n "$SKIPPED_SETUPS" ]; then
  warn "Native setup still to complete:$SKIPPED_SETUPS"
fi

if [ -n "$FAILED_SETUPS$SKIPPED_SETUPS" ]; then
  for _name in $FAILED_SETUPS $SKIPPED_SETUPS; do
    echo "  • bash \"$SCRIPT_DIR/extensions/$_name/setup.sh\""
  done
  echo
  echo -e "\033[1;33m[!] Links and configs are in place; native setup is incomplete.\033[0m"
else
  echo -e "\033[1;32m[✓] Pi configuration reproduced.\033[0m"
fi

echo
echo "Next steps:"
echo "  • Log in to the providers:  pi   →   /login   (the keys in auth.json are not versioned)"
if [ "$COPIED_LOCAL_CONFIG" -eq 1 ]; then
  echo "  • Check settings.json/models.json: the example uses local endpoints (localhost)"
fi
echo "  • In pi:  /reload   to load the extensions and skills"
echo "  • Learning: /skill:learn-plan followed by what you want to learn"
if [ -d "$SCRIPT_DIR/extensions/voice-to-chat" ] &&
   { [ "$VOICE_READY" -eq 1 ] || voice_installed; }; then
  echo "  • Voice dictation:  Ctrl+Shift+M  (or /voice)"
fi
echo

# A failed native setup must be visible to automation too.
if [ -n "$FAILED_SETUPS" ]; then
  exit 1
fi
