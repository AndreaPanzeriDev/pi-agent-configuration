/**
 * pi-banner — estensione per Pi
 * ==============================
 * Mostra, a ogni sessione, il titolo/descrizione della sessione:
 *
 *   Creare sito React con Vite
 *
 * Il titolo viene generato automaticamente dal primo messaggio dell'utente
 * *prima* che il modello inizi a rispondere, ed è salvato nella sessione
 * (session_info): lo ritrovi anche riaprendo la sessione più tardi.
 *
 * La descrizione compare:
 *   1. come header in alto nella chat, preceduta dal logo π (mode TUI);
 *   2. come riga sticky sopra l'editor, sempre visibile senza scorrere;
 *   3. nel titolo della finestra/terminale.
 *
 * Il logo π dell'header può essere grande (ASCII art su più righe)
 * oppure piccolo (simbolo su una riga) tramite la chiave "logo".
 *
 * Configurazione: ~/.pi/agent/pi-banner.json
 *   {
 *     "header": true,              // π + titolo in alto nella chat
 *     "widget": true,              // riga sticky sopra l'editor
 *     "widgetPlacement": "aboveEditor", // "aboveEditor" | "belowEditor"
 *     "terminalTitle": true,       // aggiorna il titolo del terminale
 *     "autoTitle": true,           // genera il titolo dal primo messaggio
 *     "autoTitleOnResume": true,   // genera il titolo riaprendo sessioni senza nome
 *     "titleModel": "",            // "provider/model" per il titolo; "" = modello corrente
 *     "titleMaxChars": 64,         // lunghezza massima del titolo
 *     "titleMaxTokens": 256,       // token massimi per la generazione del titolo
 *     "titleTimeoutMs": 20000      // timeout della generazione
 *   }
 *
 * Comandi:
 *   /title              mostra il titolo corrente
 *   /title <testo>      imposta il titolo a mano
 *   /title auto         rigenera il titolo dal primo messaggio della sessione
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Configurazione
// ---------------------------------------------------------------------------

interface BannerConfig {
	header: boolean;
	widget: boolean;
	widgetPlacement: "aboveEditor" | "belowEditor";
	terminalTitle: boolean;
	logo: "large" | "small";
	autoTitle: boolean;
	autoTitleOnResume: boolean;
	titleModel: string;
	titleMaxChars: number;
	titleMaxTokens: number;
	titleTimeoutMs: number;
}

const DEFAULT_CONFIG: BannerConfig = {
	header: true,
	widget: true,
	widgetPlacement: "aboveEditor",
	terminalTitle: true,
	logo: "large",
	autoTitle: true,
	autoTitleOnResume: true,
	titleModel: "",
	titleMaxChars: 64,
	titleMaxTokens: 256,
	titleTimeoutMs: 20000,
};

function loadConfig(): BannerConfig {
	const configPath = path.join(getAgentDir(), "pi-banner.json");
	const config: BannerConfig = { ...DEFAULT_CONFIG };

	try {
		if (!fs.existsSync(configPath)) return config;
		const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;

		for (const key of Object.keys(DEFAULT_CONFIG) as (keyof BannerConfig)[]) {
			const value = raw[key];
			if (value !== undefined && typeof value === typeof DEFAULT_CONFIG[key]) {
				(config as Record<string, unknown>)[key] = value;
			}
		}

		if (config.widgetPlacement !== "aboveEditor" && config.widgetPlacement !== "belowEditor") {
			config.widgetPlacement = "aboveEditor";
		}
		if (config.logo !== "large" && config.logo !== "small") {
			config.logo = "large";
		}
		if (typeof raw.titleMaxChars === "number") {
			config.titleMaxChars = Math.min(120, Math.max(24, Math.round(raw.titleMaxChars)));
		}
		if (typeof raw.titleMaxTokens === "number") {
			config.titleMaxTokens = Math.min(2048, Math.max(32, Math.round(raw.titleMaxTokens)));
		}
		if (typeof raw.titleTimeoutMs === "number") {
			config.titleTimeoutMs = Math.min(120000, Math.max(3000, Math.round(raw.titleTimeoutMs)));
		}
	} catch {
		// File mancante o non valido: usa i valori di default.
	}

	return config;
}

const CONFIG = loadConfig();

const WIDGET_KEY = "pi-banner-title";
const PLACEHOLDER_TITLE = "sessione senza titolo";

// ---------------------------------------------------------------------------
// Utilita' su testi e messaggi
// ---------------------------------------------------------------------------

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const candidate = block as { type?: unknown; text?: unknown };
		if (candidate.type === "text" && typeof candidate.text === "string") {
			parts.push(candidate.text);
		}
	}
	return parts.join("\n");
}

/** Primo messaggio utente del ramo corrente (per titoli di sessioni riprese). */
function readFirstUserMessage(ctx: ExtensionContext): string | undefined {
	try {
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "user") continue;
			const text = extractText(entry.message.content).trim();
			if (text) return text;
		}
	} catch {
		// La sessione potrebbe non essere ancora pronta: ignora.
	}
	return undefined;
}

/** Titolo immediato (provvisorio) ricavato dalla prima riga del messaggio. */
function provisionalTitle(text: string): string {
	const firstLine =
		text
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find((line) => line.length > 0) ?? "";

	let clean = firstLine
		.replace(/^[#>*+\-\s]+/, "")
		.replace(/\s+/g, " ")
		.trim();

	if (!clean) return PLACEHOLDER_TITLE;
	if (clean.length > CONFIG.titleMaxChars) {
		clean = `${clean.slice(0, CONFIG.titleMaxChars - 1).trimEnd()}…`;
	}
	return clean;
}

/** Pulisce il titolo restituito dal modello. */
function sanitizeTitle(raw: string): string | undefined {
	const firstLine = raw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (!firstLine) return undefined;

	let title = firstLine
		.replace(/^(titolo|title|nome|name|sessione|session)\s*[:\-–—]\s*/i, "")
		.replace(/^["'`«»“”‘’]+|["'`«»“”‘’]+$/g, "")
		.replace(/^[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\s]+|[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\s]+$/gu, "")
		.replace(/\s+/g, " ")
		.trim();
	title = title.replace(/[.!?,;:。！？]+$/g, "").trim();

	if (!title) return undefined;
	if (title.length > CONFIG.titleMaxChars) {
		title = `${title.slice(0, CONFIG.titleMaxChars - 1).trimEnd()}…`;
	}
	return title;
}

// ---------------------------------------------------------------------------
// Generazione del titolo con il modello
// ---------------------------------------------------------------------------

type TitleModel = ReturnType<ExtensionContext["modelRegistry"]["getAvailable"]>[number];

function pickTitleModel(ctx: ExtensionContext): TitleModel | undefined {
	const registry = ctx.modelRegistry;

	// 1. Modello indicato esplicitamente nella configurazione.
	if (CONFIG.titleModel) {
		const slash = CONFIG.titleModel.indexOf("/");
		if (slash > 0) {
			const model = registry.find(CONFIG.titleModel.slice(0, slash), CONFIG.titleModel.slice(slash + 1));
			if (model && registry.hasConfiguredAuth(model)) return model;
		}
	}

	// 2. Modello corrente della sessione.
	if (ctx.model && registry.hasConfiguredAuth(ctx.model)) return ctx.model;

	// 3. Primo modello disponibile con credenziali configurate.
	return registry.getAvailable().find((model) => registry.hasConfiguredAuth(model));
}

async function generateTitle(ctx: ExtensionContext, userText: string): Promise<string | undefined> {
	const model = pickTitleModel(ctx);
	if (!model) return undefined;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), CONFIG.titleTimeoutMs);
	const onAbort = () => controller.abort();
	ctx.signal?.addEventListener("abort", onAbort, { once: true });

	try {
		const prompt = [
			"Give this coding session a short title based on the user's first message.",
			"Rules:",
			`- Maximum ${CONFIG.titleMaxChars} characters, 3 to 8 words.`,
			"- Use the same language as the user's message.",
			"- No quotes, no emoji, no trailing punctuation, no labels like 'Title:'.",
			"- Describe the concrete task or topic.",
			"- Reply with the title only.",
			"",
			"<first_message>",
			userText.slice(0, 1500),
			"</first_message>",
		].join("\n");

		const response = await ctx.modelRegistry.complete(
			model,
			{
				messages: [
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: prompt }],
						timestamp: Date.now(),
					},
				],
			},
			{
				maxTokens: CONFIG.titleMaxTokens,
				temperature: 0.2,
				cacheRetention: "none",
				sessionId: randomUUID(),
				signal: controller.signal,
			},
		);

		const text = response.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");

		return sanitizeTitle(text);
	} catch {
		// Timeout, abort o provider senza auth: si tiene il titolo provvisorio.
		return undefined;
	} finally {
		clearTimeout(timeout);
		ctx.signal?.removeEventListener("abort", onAbort);
	}
}

// ---------------------------------------------------------------------------
// Componente TUI: π + titolo
// ---------------------------------------------------------------------------

interface BannerState {
	title: string;
	hasTitle: boolean;
}

function currentState(pi: ExtensionAPI): BannerState {
	const name = pi.getSessionName();
	return {
		title: name ?? PLACEHOLDER_TITLE,
		hasTitle: Boolean(name),
	};
}

/** Logo π grande in ASCII art, colorato con il colore "accent" del tema. */
function getLargeLogo(theme: Theme): string[] {
	const accent = (text: string) => theme.fg("accent", text);
	return [
		accent("   ███████████████████████████╗  "),
		accent("   ╚══██████╔════════██████╔══╝  "),
		accent("      ██████║        ██████║     "),
		accent("      ██████║        ██████║     "),
		accent("      ██████║        ██████║     "),
		accent("      ██████║        ██████║     "),
		accent("      ██████║        ██████║     "),
		accent("      ██████║        ██████║     "),
		accent("   ████████████╗  ████████████╗  "),
		accent("   ╚═══════════╝  ╚═══════════╝  "),
	];
}

/** Riga con il titolo della sessione; con `withLogo` mostra il logo π in grande. */
function makeTitleComponent(state: BannerState, theme: Theme, withLogo = false) {
	return {
		render(width: number): string[] {
			const title = state.hasTitle
				? theme.bold(state.title)
				: theme.italic(theme.fg("dim", state.title));
			const titleLine = truncateToWidth(title, width, "…");

			if (!withLogo) return [titleLine];

			if (CONFIG.logo === "large") {
				const lines = getLargeLogo(theme).map((line) => truncateToWidth(line, width, "…"));
				lines.push(`  ${titleLine}`);
				return lines;
			}

			return [truncateToWidth(`${theme.fg("accent", "π")}  ${title}`, width, "…")];
		},
		invalidate() {
			// Il tema arriva da un Proxy "live": il contenuto si ricalcola a ogni render.
		},
	};
}

/** Aggiorna header, widget e titolo del terminale in base allo stato corrente. */
function refreshUI(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const state = currentState(pi);

	if (ctx.mode === "tui" && CONFIG.header) {
		ctx.ui.setHeader((_tui, theme) => makeTitleComponent(state, theme, true));
	}
	if (CONFIG.widget) {
		ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => makeTitleComponent(state, theme), {
			placement: CONFIG.widgetPlacement,
		});
	}
	if (CONFIG.terminalTitle) {
		ctx.ui.setTitle(state.title);
	}
}

// ---------------------------------------------------------------------------
// Estensione
// ---------------------------------------------------------------------------

export default function piBannerExtension(pi: ExtensionAPI) {
	let titleInFlight = false;

	/**
	 * Raffina il titolo con una chiamata al modello.
	 * `force` serve a /title auto, che deve funzionare anche con autoTitle=false.
	 */
	async function refineTitle(ctx: ExtensionContext, userText: string, force = false): Promise<void> {
		if (titleInFlight) return;
		if (!force && !CONFIG.autoTitle) return;
		if (!ctx.hasUI) return;

		const expected = pi.getSessionName();
		titleInFlight = true;
		try {
			const generated = await generateTitle(ctx, userText);
			if (!generated || generated === expected) return;
			// Non sovrascrivere un titolo cambiato nel frattempo (es. /title o /name).
			if (pi.getSessionName() !== expected) return;
			pi.setSessionName(generated);
			refreshUI(pi, ctx);
		} finally {
			titleInFlight = false;
		}
	}

	// All'avvio: mostra il titolo e, se la sessione ripresa non ha titolo, crealo.
	pi.on("session_start", (_event, ctx) => {
		titleInFlight = false;
		refreshUI(pi, ctx);

		if (!CONFIG.autoTitle || !CONFIG.autoTitleOnResume || !ctx.hasUI) return;
		if (pi.getSessionName()) return;

		const first = readFirstUserMessage(ctx);
		if (!first) return;

		pi.setSessionName(provisionalTitle(first));
		refreshUI(pi, ctx);
		void refineTitle(ctx, first);
	});

	// Titolo cambiato (dall'estensione, da /name o da /title): aggiorna la UI.
	pi.on("session_info_changed", (_event, ctx) => {
		refreshUI(pi, ctx);
	});

	// Prima che l'agente parta: assegna il titolo (provvisorio e poi raffinato).
	pi.on("before_agent_start", async (event, ctx) => {
		if (!ctx.hasUI || !event.prompt.trim()) return;
		if (pi.getSessionName()) return;

		pi.setSessionName(provisionalTitle(event.prompt));
		refreshUI(pi, ctx);

		if (CONFIG.autoTitle) {
			await refineTitle(ctx, event.prompt);
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		if (ctx.mode === "tui") ctx.ui.setHeader(undefined);
	});

	// Comando manuale: /title, /title <testo>, /title auto
	pi.registerCommand("title", {
		description: "Mostra o imposta il titolo della sessione (uso: /title [testo | auto])",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const input = args.trim();

			if (!input) {
				const current = pi.getSessionName();
				if (ctx.hasUI) {
					ctx.ui.notify(
						current
							? `Titolo sessione: ${current}`
							: "Nessun titolo impostato. Usa /title <testo> oppure /title auto.",
						"info",
					);
				}
				return;
			}

			if (input === "auto" || input === "rigenera" || input === "regen") {
				const first = readFirstUserMessage(ctx);
				if (!first) {
					if (ctx.hasUI) ctx.ui.notify("Nessun messaggio utente su cui basare il titolo.", "warning");
					return;
				}
				if (titleInFlight) {
					if (ctx.hasUI) ctx.ui.notify("Generazione del titolo già in corso…", "warning");
					return;
				}
				pi.setSessionName(provisionalTitle(first));
				refreshUI(pi, ctx);
				await refineTitle(ctx, first, true);
				if (ctx.hasUI) {
					ctx.ui.notify(`Titolo sessione: ${pi.getSessionName() ?? "—"}`, "info");
				}
				return;
			}

			pi.setSessionName(input);
			if (ctx.hasUI) {
				ctx.ui.notify(`Titolo sessione: ${pi.getSessionName() ?? input}`, "info");
			}
		},
	});
}
