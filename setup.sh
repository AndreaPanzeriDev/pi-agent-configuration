#!/usr/bin/env bash
#
# setup.sh — reproduce this Pi configuration on a new machine (Linux / macOS).
#
# It will:
#   1. link every extension in ./extensions into the Pi agent directory
#   2. install the example config files (only if not already present)
#   3. run each extension's own setup.sh (native deps: Python, PortAudio, …)
#
# Usage:
#   git clone <repo> ~/pi-agent-config
#   ~/pi-agent-config/setup.sh             # full setup
#   ~/pi-agent-config/setup.sh --no-native # skip system/Python deps
#
# Options:
#   --no-native   link extensions + install configs, but do NOT run the
#                 per-extension native setup (Python venv, PortAudio, model…)
#   -h, --help    show this help
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
DEST_DIR="$AGENT_DIR/extensions"

SKIP_NATIVE=0
for arg in "$@"; do
  case "$arg" in
    --no-native|--skip-native) SKIP_NATIVE=1 ;;
    -h|--help)
      sed -n '3,18p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) printf '\033[1;33m[!]\033[0m Argomento ignorato: %s\n' "$arg" ;;
  esac
done

log()  { printf '\033[1;34m[setup]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[✓]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }

log "Pi agent dir: $AGENT_DIR"
mkdir -p "$DEST_DIR"

# --- 1. link extensions ----------------------------------------------------
log "Collegamento delle estensioni…"
for src in "$SCRIPT_DIR"/extensions/*; do
  [ -e "$src" ] || continue
  name="$(basename "$src")"
  target="$DEST_DIR/$name"

  # Already the same file (e.g. symlink) -> nothing to do.
  if [ -e "$target" ] && [ "$target" -ef "$src" ]; then
    ok "già presente: $name"
    continue
  fi

  # Back up an existing, different entry so nothing is lost.
  if [ -e "$target" ] || [ -L "$target" ]; then
    warn "esiste già '$name': ne faccio un backup (*.bak)"
    mv "$target" "$target.bak.$(date +%s)"
  fi

  ln -s "$src" "$target"
  ok "collegata: $name -> $src"
done

# --- 2. install example config files (never overwrite) ---------------------
if [ -d "$SCRIPT_DIR/examples" ]; then
  log "File di configurazione…"
  for f in "$SCRIPT_DIR"/examples/*.json; do
    [ -e "$f" ] || continue
    base="$(basename "$f")"
    if [ -e "$AGENT_DIR/$base" ]; then
      warn "config esistente, non tocco: $base"
    else
      cp "$f" "$AGENT_DIR/$base"
      ok "config installata: $base"
    fi
  done
fi

# --- 3. run each extension's native setup ----------------------------------
if [ "$SKIP_NATIVE" -eq 0 ]; then
  for s in "$SCRIPT_DIR"/extensions/*/setup.sh; do
    [ -e "$s" ] || continue
    log "Setup dipendenze: $(basename "$(dirname "$s")")"
    bash "$s"
  done
else
  warn "--no-native: salto il setup delle dipendenze native"
fi

# --- done ------------------------------------------------------------------
echo
echo -e "\033[1;32m[✓] Configurazione Pi riprodotta.\033[0m"
echo
echo "Prossimi passi:"
echo "  • Autentica i provider:  pi   →   /login   (le chiavi in auth.json non sono versionate)"
echo "  • In pi:  /reload   per caricare le estensioni"
echo "  • Dettatura vocale:  Ctrl+Shift+M"
echo
