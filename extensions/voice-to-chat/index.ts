import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// Resolve everything relative to THIS file so the extension works from any
// machine / clone location (no hardcoded absolute paths).
const EXT_DIR = dirname(fileURLToPath(import.meta.url));

type State = "idle" | "recording" | "transcribing";

const SPINNER = ["⠋", "⠙", "⠹", "⸸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// 9 levels from a thin sliver (▁) to a full block (█).
const METER = "▁▂▃▄▅▆▇█";
const BAR_COUNT = 14;   // keep it SMALL — just a tiny red bar strip
const RED = "\x1b[91m"; // ANSI: bright red foreground
const RESET = "\x1b[0m"; // ANSI: reset
let wave = 0;           // phase for the traveling wave

// A tiny, random-looking red wave animation. Each bar wobbles around a
// traveling sine wave so the strip looks like moving water. It only needs to
// make it obvious that recording is live, so it does NOT reflect the actual
// microphone level — it's just a minimal visual cue. Rendered in red using
// ANSI codes (the widget renderer interprets them).
function renderWave(): string {
  wave += 0.5;
  let s = "";
  for (let i = 0; i < BAR_COUNT; i++) {
    const base = 0.5 + 0.4 * Math.sin(wave / 4 + i * 0.6);
    const jitter = (Math.random() - 0.5) * 0.35;
    const v = Math.max(0, Math.min(1, base + jitter));
    s += METER[Math.min(METER.length - 1, Math.floor(v * METER.length))];
  }
  return `${RED}${s}${RESET}`;
}

let state: State = "idle";
let proc: ReturnType<typeof spawn> | null = null;
let resultFile = "";
let logFile = "";
let startedAt = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let frame = 0;

const isRunning = () => !!proc && proc.exitCode === null && proc.signalCode === null;

// Surface the child's real error (from its stderr log) when it exits abnormally.
function errorHint(): string {
  try {
    if (logFile && existsSync(logFile)) {
      const lines = readFileSync(logFile, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      // Prefer an explicit ERROR line, otherwise the last log line.
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].startsWith("ERROR:")) return lines[i].slice("ERROR:".length).trim();
      }
      return lines[lines.length - 1];
    }
  } catch {
    /* ignore */
  }
  return "";
}

/**
 * Locate the Python interpreter that should run voice.py.
 *
 * Resolution order (first existing wins):
 *   1. `$VOICE_PYTHON` (explicit override)
 *   2. `.venv` (next to this extension) or the conventional `~/.pi/voice-venv`
 *      created by ./setup.sh — both `bin/` (Unix) and `Scripts/` (Windows).
 *   3. the system `python3` / `python` (resolved through PATH by spawn).
 */
function resolvePython(): string {
  const envPy = process.env.VOICE_PYTHON?.trim();
  if (envPy) return envPy;

  const isWin = process.platform === "win32";
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const venvDirs = [join(EXT_DIR, ".venv"), join(home, ".pi", "voice-venv")];
  const layouts: string[][] = isWin
    ? [["Scripts", "python.exe"], ["bin", "python.exe"]]
    : [["bin", "python3"], ["bin", "python"], ["Scripts", "python.exe"]];

  for (const dir of venvDirs) {
    for (const parts of layouts) {
      const candidate = join(dir, ...parts);
      if (existsSync(candidate)) return candidate;
    }
  }
  return isWin ? "python" : "python3";
}

const SCRIPT = join(EXT_DIR, "voice.py");

/**
 * Read the model/device chosen by extensions/voice-to-chat/setup.sh.
 *
 * setup.sh writes $AGENT_DIR/voice-to-chat.json after downloading the model,
 * so the runtime uses exactly the model that is already on disk (CPU -> medium,
 * CUDA/MLX -> large-v3-turbo, or the user's MODEL override). Environment
 * variables still take precedence.
 */
function resolveVoiceConfig(): { model?: string; device?: string } {
  try {
    const raw = readFileSync(join(getAgentDir(), "voice-to-chat.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const model =
      typeof parsed.model === "string" ? parsed.model.trim() : "";
    const device =
      typeof parsed.device === "string" ? parsed.device.trim() : "";
    return {
      model: model || undefined,
      device: device || undefined,
    };
  } catch {
    // No config (or unreadable): let voice.py pick its platform default.
    return {};
  }
}

function render(ctx: ExtensionContext) {
  if (state === "idle") {
    ctx.ui.setStatus("voice", undefined);
    ctx.ui.setWidget("voice", undefined);
    return;
  }
  if (state === "recording") {
    ctx.ui.setStatus("voice", "🎙 REC");
    ctx.ui.setWidget("voice", [renderWave()]);
  } else {
    // transcribing — brief spinner, no audio to visualize
    const spin = SPINNER[frame % SPINNER.length];
    ctx.ui.setStatus("voice", "✍ transcribing");
    ctx.ui.setWidget("voice", [`${spin} ✍ transcribing…`]);
  }
}

function safeRender(ctx: ExtensionContext) {
  try {
    render(ctx);
  } catch {
    /* the UI context may be gone; never let this crash pi */
  }
}

function reset(ctx: ExtensionContext) {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  proc = null;
  state = "idle";
  safeRender(ctx);
}

function putInEditor(ctx: ExtensionContext, text: string) {
  try {
    const existing = ctx.ui.getEditorText();
    const combined = existing.trim() ? `${existing.trimEnd()} ${text}` : text;
    ctx.ui.setEditorText(combined);
    ctx.ui.notify(
      "Voice-to-chat: transcription ready — press Enter to send",
      "success",
    );
  } catch (e) {
    ctx.ui.notify(`Voice-to-chat: unable to write to the editor: ${e}`, "error");
  }
}

function startRecording(ctx: ExtensionContext) {
  resultFile = join(tmpdir(), `pi_voice_${process.pid}_${Date.now()}.txt`);
  logFile = join(tmpdir(), `pi_voice_${process.pid}_${Date.now()}.log`);

  const python = resolvePython();
  const config = resolveVoiceConfig();
  // Environment variables win over the saved setup, matching voice.py.
  const model = process.env.VOICE_MODEL?.trim() || config.model;
  const device = process.env.VOICE_DEVICE?.trim() || config.device;
  const scriptArgs = [SCRIPT, "--output", resultFile];
  if (model) scriptArgs.push("--model", model);
  if (device) scriptArgs.push("--device", device);

  // Important: do NOT inherit stdio — the child must never write to pi's TTY,
  // otherwise it corrupts the TUI rendering.
  const log = createWriteStream(logFile, { flags: "a" });
  proc = spawn(python, scriptArgs, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.on("data", () => {});
  proc.stderr?.on("data", (d) => {
    try {
      log.write(d);
    } catch {
      /* ignore */
    }
  });
  proc.on("close", () => {
    try {
      log.end();
    } catch {
      /* ignore */
    }
  });

  state = "recording";
  startedAt = Date.now();
  frame = 0;
  ctx.ui.notify(`Voice-to-chat: registrazione avviata (${process.platform})`, "info");

  pollTimer = setInterval(() => {
    try {
      frame++;
      safeRender(ctx);

      if (isRunning()) return;

      // Process exited: collect the result (if any).
      // NOTE: read proc.exitCode BEFORE reset(), which nulls proc out.
      const exitCode = proc?.exitCode;
      const wasTranscribing = state === "transcribing";
      const text = existsSync(resultFile)
        ? readFileSync(resultFile, "utf8").trim()
        : "";
      rmSync(resultFile, { force: true });
      reset(ctx);

      if (text) {
        putInEditor(ctx, text);
      } else if (exitCode && exitCode !== 0) {
        // The child crashed (e.g. PortAudio missing, model unavailable).
        const hint = errorHint();
        ctx.ui.notify(
          `Voice-to-chat: ${hint || "error during recording"}`,
          "error",
        );
      } else if (wasTranscribing) {
        const hint = readLogHint();
        ctx.ui.notify(`Voice-to-chat: no transcribed text${hint}`, "warning");
      } else {
        ctx.ui.notify(
          "Voice-to-chat: recording ended without text " +
            "(silent microphone or max duration reached)",
          "error",
        );
      }
    } catch {
      // Never let a timer callback throw: an uncaught error would kill pi.
      reset(ctx);
      ctx.ui.notify("Voice-to-chat: internal error", "error");
    }
  }, 120);
}

function readLogHint(): string {
  try {
    if (logFile && existsSync(logFile)) {
      const lines = readFileSync(logFile, "utf8").trim().split("\n");
      const last = lines[lines.length - 1]?.trim();
      if (last) return ` (${last})`;
    }
  } catch {
    /* ignore */
  }
  return "";
}

function stopAndTranscribe(ctx: ExtensionContext) {
  if (!isRunning()) return;
  proc?.kill("SIGINT"); // graceful: voice.py finalizes and transcribes
  state = "transcribing";
  startedAt = Date.now();
  ctx.ui.notify("Voice-to-chat: recording stopped, transcribing…", "info");
}

export default function (pi: ExtensionAPI) {
  // NOTE: avoid ctrl+shift+<letter>. xterm-compatible terminals (GNOME
  // Terminal, etc.) drop the shift modifier for control letters, so
  // ctrl+shift+m arrives as plain ctrl+m and never fires. Function keys
  // (or alt+key) send a distinct escape sequence in every terminal.
  pi.registerShortcut("ctrl+shift+m", {
    description: "Voice-to-chat: start/stop recording (then transcribes)",
    handler: async (ctx: ExtensionContext) => {
      try {
        if (state === "idle") {
          startRecording(ctx);
        } else if (state === "recording") {
          stopAndTranscribe(ctx);
        } else {
          // transcribing -> cancel
          proc?.kill("SIGTERM");
          rmSync(resultFile, { force: true });
          reset(ctx);
          ctx.ui.notify("Voice-to-chat: cancelled", "warning");
        }
      } catch (e) {
        reset(ctx);
        ctx.ui.notify(`Voice-to-chat: error: ${e}`, "error");
      }
    },
  });

  // /voice slash command — a keyboard-independent trigger (handy in
  // terminals where Ctrl+Shift+M collapses to Ctrl+M) plus a way to
  // inject arbitrary text into the editor.
  //
  //   /voice            start/stop recording (same as Ctrl+Shift+M)
  //   /voice stop       cancel an in-progress recording
  //   /voice <text>     insert <text> into the editor (press Enter to send)
  pi.registerCommand("voice", {
    description:
      "Voice-to-chat: /voice toggles recording; /voice <text> inserts text; /voice stop cancels",
    handler: async (args: string, ctx: ExtensionContext) => {
      const input = (args ?? "").trim();

      // Cancel an in-progress recording.
      if (input === "stop" || input === "cancel") {
        if (state === "recording" || state === "transcribing") {
          proc?.kill("SIGTERM");
          rmSync(resultFile, { force: true });
          reset(ctx);
          ctx.ui.notify("Voice-to-chat: cancelled", "warning");
        } else {
          ctx.ui.notify("Voice-to-chat: nothing to cancel", "warning");
        }
        return;
      }

      // No argument → toggle recording, exactly like Ctrl+Shift+M.
      if (input === "") {
        if (state === "idle") {
          startRecording(ctx);
        } else if (state === "recording") {
          stopAndTranscribe(ctx);
        } else {
          ctx.ui.notify(
            "Voice-to-chat: already busy (recording or transcribing)",
            "warning",
          );
        }
        return;
      }

      // Otherwise treat the argument as text to inject into the editor.
      try {
        putInEditor(ctx, input);
      } catch (e) {
        ctx.ui.notify(
          `Voice-to-chat: unable to write to the editor: ${e}`,
          "error",
        );
      }
    },
  });

  pi.on("session_shutdown", () => {
    try {
      proc?.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    if (pollTimer) clearInterval(pollTimer);
  });
}
