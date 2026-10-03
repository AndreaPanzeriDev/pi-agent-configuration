#!/usr/bin/env bash
#
# setup.sh — reproduce this Pi configuration on a new machine (Linux / macOS).
#
# It will:
#   1. link every extension in ./extensions into the Pi agent directory
#   2. install the example config files (only if not already present)
#   3. offer to run each extension's own setup.sh (native deps: Python, PortAudio, …)
#      (only for extensions that actually contain a setup.sh file)
#   4. validate MCP servers with `pi mcp list` (first run downloads Chromium)
#
# Usage:
#   git clone <repo> ~/pi-agent-config
#   ~/pi-agent-config/setup.sh             # full setup (asks per extension)
#   ~/pi-agent-config/setup.sh --no-native # skip system/Python deps
#   ~/pi-agent-config/setup.sh --yes       # run every extension setup without asking
#
# Options:
#   --no-native   link extensions + install configs, but do NOT offer/run the
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
for arg in "$@"; do
  case "$arg" in
    --no-native|--skip-native) SKIP_NATIVE=1 ;;
    -y|--yes) AUTO_YES=1 ;;
    -h|--help)
      sed -n '3,22p' "$0" | sed 's/^# \{0,1\}//'
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

# --- 3. offer each extension's native setup ----------------------------------
# Chiede conferma solo per le estensioni che contengono davvero un setup.sh,
# usando il nome della cartella come nome dell'estensione.
SKIPPED_SETUPS=""
if [ "$SKIP_NATIVE" -eq 1 ]; then
  warn "--no-native: salto il setup delle dipendenze native"
  for s in "$SCRIPT_DIR"/extensions/*/setup.sh; do
    [ -e "$s" ] || continue
    SKIPPED_SETUPS="$SKIPPED_SETUPS $(basename "$(dirname "$s")")"
  done
else
  for s in "$SCRIPT_DIR"/extensions/*/setup.sh; do
    [ -e "$s" ] || continue
    name="$(basename "$(dirname "$s")")"
    answer=""
    if [ "$AUTO_YES" -eq 1 ]; then
      answer="y"
    elif [ ! -t 0 ]; then
      warn "input non interattivo: salto il setup di '$name'"
      SKIPPED_SETUPS="$SKIPPED_SETUPS $name"
      continue
    else
      printf '\033[1;34m[setup]\033[0m Vuoi impostare anche %s? (Y/n): ' "$name"
      read -r answer || answer="n"
    fi
    case "${answer:-Y}" in
      [Nn]|[Nn][Oo])
        warn "salto il setup di '$name' (puoi lanciarlo dopo con: bash extensions/$name/setup.sh)"
        SKIPPED_SETUPS="$SKIPPED_SETUPS $name"
        ;;
      *)
        log "Setup dipendenze: $name"
        bash "$s"
        ;;
    esac
  done
fi

# --- 4. validate MCP servers (downloads Playwright Chromium once) ---------------
if command -v pi >/dev/null 2>&1 && [ -e "$AGENT_DIR/mcp.json" ]; then
  log "Verifica dei server MCP (al primo avvio scarica Chromium, serve rete)…"
  if pi mcp list; then
    ok "server MCP raggiungibili"
  else
    warn "'pi mcp list' ha segnalato problemi (vedi sopra); riprova con la rete attiva"
  fi
fi

# --- done ------------------------------------------------------------------
echo
if [ -n "$SKIPPED_SETUPS" ]; then
  warn "Setup iniziale non ancora finito: resta da completare il setup di:$SKIPPED_SETUPS"
  for _name in $SKIPPED_SETUPS; do
    echo "  • bash extensions/$_name/setup.sh"
  done
  echo
fi
echo -e "\033[1;32m[✓] Configurazione Pi riprodotta.\033[0m"
echo
echo "Prossimi passi:"
echo "  • Autentica i provider:  pi   →   /login   (le chiavi in auth.json non sono versionate)"
echo "  • In pi:  /reload   per caricare le estensioni"
echo "  • Dettatura vocale:  Ctrl+Shift+M"
echo
