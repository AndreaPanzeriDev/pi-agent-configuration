/**
 * response-sound extension
 * -------------------------
 * Plays a short sound every time Pi finishes a turn (i.e. when it gives you
 * its final answer). The sound is fully configurable.
 *
 * Configuration (in priority order):
 *   1. Environment variable  PI_RESPONSE_SOUND  (path to an audio file or a
 *      built-in name such as "blip" / "ding")
 *   2. Config file           ~/.pi/agent/response-sound.json
 *        {
 *          "enabled":  true,
 *          "sound":    "blip",
 *          "volume":   0.8
 *        }
 *   3. Built-in defaults:  sound = "blip", volume = 0.8, enabled = true
 *
 * Commands (available in the interactive UI):
 *   /sound              Show the current configuration
 *   /sound test         Play the current sound once (to test it)
 *   /sound list         List built-in sounds
 *   /sound set <name>   Set the sound (built-in name or path to an audio file)
 *   /sound vol <0-1>    Set the volume
 *   /sound on | off     Enable / disable the feature
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { execFile, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Config = { enabled: boolean; sound: string; volume: number };

const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "response-sound.json");

const BUILTIN_SOUNDS: Record<string, () => string> = {
	// Each returns the path to a generated WAV file (16-bit PCM, playable by
	// aplay / pw-play / paplay / afplay).
	blip: makeBlip,
	ding: makeDing,
};

function playWav(wavPath: string, volume: number): void {
	try {
		if (!fs.existsSync(wavPath)) {
			return;
		}
		const vol = Math.max(0, Math.min(1, volume));
		const player = detectPlayer();
		if (!player) {
			return;
		}
		const [args, extra] = player.args(wavPath, vol);
		new Promise((resolve) => {
			execFile(player.cmd, [...args, ...extra], { timeout: 4000, stdio: "ignore" }, () => resolve());
		}).catch(() => {});
	} catch {
		// Never let a sound failure break Pi.
	}
}

function detectPlayer(): { cmd: string; args(wavPath: string, vol: number): [string[], string[]] } | undefined {
	const which = (name: string): string | undefined => {
		try {
			const out = execSync(`command -v ${name}`, { encoding: "utf8" }).trim();
			return out ? out : undefined;
		} catch {
			return undefined;
		}
	};

	if (process.platform === "darwin") {
		const afplay = which("afplay");
		if (afplay) {
			return { cmd: afplay, args: (wav) => [[wav], []] };
		}
	}

	if (process.platform === "win32") {
		return {
			cmd: "powershell.exe",
			args: (wav) => [["-NoProfile", "-Command", `([System.Media.SoundPlayer]::new('${wav.replace(/'/g, "''")}')).Play()`], []],
		};
	}

	// Linux / other Unix.
	const candidates: Array<[string, (wav: string, vol: number) => string[]]> = [
		["pw-play", (wav, vol) => [wav, `--volume=${Math.round(vol * 100)}`]],
		["paplay", (wav) => [wav]],
		["aplay", (wav, vol) => [wav, `--volume=${Math.round(vol * 100)}`]],
		["ffplay", (wav) => [wav, "-nodisp", "-autoexit"]],
		["mplayer", (wav) => [wav]],
		["play", (wav) => [wav]],
	];

	for (const [name, makeArgs] of candidates) {
		const found = which(name);
		if (found) {
			return { cmd: found, args: (wav, vol) => [[`${wav}`, ...makeArgs(wav, vol)], []] };
		}
	}
	return undefined;
}

function writeWav(samples: number[], sampleRate: number, bits = 16): string {
	const numChannels = 1;
	const byteRate = sampleRate * numChannels * (bits / 8);
	const blockAlign = numChannels * (bits / 8);
	const dataSize = samples.length * (bits / 8);

	const buffer = Buffer.alloc(44 + dataSize);
	buffer.write("RIFF", 0);
	buffer.writeUInt32LE(36 + dataSize, 4);
	buffer.write("WAVE", 8);
	buffer.write("fmt ", 12);
	buffer.writeUInt32LE(16, 16);
	buffer.writeUInt16LE(1, 20); // PCM
	buffer.writeUInt16LE(numChannels, 22);
	buffer.writeUInt32LE(sampleRate, 24);
	buffer.writeUInt32LE(byteRate, 28);
	buffer.writeUInt16LE(blockAlign, 32);
	buffer.writeUInt16LE(bits, 34);
	buffer.write("data", 36);
	buffer.writeUInt32LE(dataSize, 40);

	let offset = 44;
	const max = Math.pow(2, bits - 1);
	for (const s of samples) {
		const clamped = Math.max(-1, Math.min(1, s));
		buffer.writeInt16LE(Math.round(clamped * max), offset);
		offset += 2;
	}
	return buffer;
}

/** A short rising "blip" — the default response sound. */
function makeBlip(): string {
	const sampleRate = 22050;
	const dur = 0.14;
	const n = Math.floor(sampleRate * dur);
	const startF = 660;
	const endF = 990;
	const samples: number[] = [];
	for (let i = 0; i < n; i++) {
		const t = i / n;
		const env = Math.sin(Math.PI * t); // fade in/out
		const freq = startF + (endF - startF) * t;
		samples.push(env * 0.6 * Math.sin(2 * Math.PI * freq * t));
	}
	return saveTempWav(samples, sampleRate);
}

/** A simple "ding". */
function makeDing(): string {
	const sampleRate = 22050;
	const dur = 0.3;
	const n = Math.floor(sampleRate * dur);
	const samples: number[] = [];
	for (let i = 0; i < n; i++) {
		const t = i / n;
		const env = Math.exp(-t * 6);
		samples.push(0.5 * env * Math.sin(2 * Math.PI * 880 * t));
	}
	return saveTempWav(samples, sampleRate);
}

function saveTempWav(samples: number[], sampleRate: number): string {
	const dir = path.join(os.tmpdir(), "pi-response-sound");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${Math.random().toString(36).slice(2)}.wav`);
	fs.writeFileSync(file, writeWav(samples, sampleRate));
	return file;
}

function loadConfig(): Config {
	const base: Config = { enabled: true, sound: "blip", volume: 0.8 };

	// Environment variable overrides everything.
	const env = process.env.PI_RESPONSE_SOUND;
	if (env && env.trim().length > 0) {
		return { ...base, sound: env.trim() };
	}

	// Config file.
	try {
		if (fs.existsSync(CONFIG_PATH)) {
			const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
			return {
				enabled: parsed.enabled ?? base.enabled,
				sound: parsed.sound ?? base.sound,
				volume: parsed.volume ?? base.volume,
			};
		}
	} catch {
		// ignore malformed config, fall back to defaults
	}

	return base;
}

function resolveWavPath(sound: string): string | undefined {
	if (BUILTIN_SOUNDS[sound]) {
		return BUILTIN_SOUNDS[sound]();
	}
	if (fs.existsSync(sound)) {
		return sound;
	}
	return undefined;
}

function listBuiltins(): string[] {
	return Object.keys(BUILTIN_SOUNDS);
}

export default function (pi: ExtensionAPI) {
	// Play a sound once, when the agent is truly done (agent_settled): Pi will not
	// continue automatically, so this is the signal that the response is ready to read.
	pi.on("agent_settled", (_event, _ctx) => {
		const config = loadConfig();
		if (!config.enabled) {
			return;
		}
		const wav = resolveWavPath(config.sound);
		if (!wav) {
			return;
		}
		playWav(wav, config.volume);
	});

	// Convenience command to test and change the sound.
	pi.registerCommand("sound", {
		description: "Play or configure the response sound (blip, ding, or a path to an audio file)",
		handler: async (args: string, ctx) => {
			const config = loadConfig();
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const verb = parts[0]?.toLowerCase();

			switch (verb) {
				case "test":
				case undefined:
				case "": {
					const wav = resolveWavPath(config.sound);
					if (!wav) {
						ctx.ui.notify(`Sound "${config.sound}" not found. Try "/sound list".`, "warning");
					} else {
						playWav(wav, config.volume);
						ctx.ui.notify(`Playing "${config.sound}".`, "info");
					}
					break;
				}
				case "list":
					ctx.ui.notify(`Built-in sounds: ${listBuiltins().join(", ")}.`, "info");
					break;
				case "set": {
					const next = parts[1];
					if (!next) {
						ctx.ui.notify('Usage: /sound set <name-or-path>', "warning");
						return;
					}
					const wav = resolveWavPath(next);
					if (!wav) {
						ctx.ui.notify(`Sound "${next}" not found. Try "/sound list".`, "warning");
						return;
					}
					writeConfig({ ...config, sound: next });
					ctx.ui.notify(`Response sound set to "${next}".`, "info");
					break;
				}
				case "vol":
				case "volume": {
					const next = Number(parts[1]);
					if (!Number.isFinite(next) || next < 0 || next > 1) {
						ctx.ui.notify("Usage: /sound vol <0-1>", "warning");
						return;
					}
					writeConfig({ ...config, volume: next });
					ctx.ui.notify(`Volume set to ${next}.`, "info");
					break;
				}
				case "on":
					writeConfig({ ...config, enabled: true });
					ctx.ui.notify("Response sound enabled.", "info");
					break;
				case "off":
					writeConfig({ ...config, enabled: false });
					ctx.ui.notify("Response sound disabled.", "info");
					break;
				default:
					ctx.ui.notify(
						`Current: sound="${config.sound}", volume=${config.volume}, enabled=${config.enabled}. ` +
							`Use /sound test|list|set <name>|vol <0-1>|on|off.`,
						"info",
					);
			}
		},
	});

	function writeConfig(next: Config): void {
		try {
			fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
			fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
		} catch {
			// non-fatal
		}
	}
}
