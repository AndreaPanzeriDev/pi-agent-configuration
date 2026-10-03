/**
 * pi-banner — estensione per Pi
 * ==============================
 * Mostra, a ogni sessione, il titolo e il testo originale:
 *
 *   Header (sotto il logo π): testo originale completo del primo
 *   messaggio dell'utente, senza troncamenti, mandato a capo
 *   sulla larghezza disponibile.
 *
 *   Widget (riga sticky sopra l'editor): descrizione corta generata
 *   dall'AI in uso (stesso modello della sessione, con vision per gli
 *   screenshot allegati), sempre mostrata per intero con wrap su piu'
 *   righe invece di troncare con ….
 *
 * Il titolo viene generato automaticamente dal primo messaggio dell'utente
 * *prima* che il modello inizi a rispondere, ed è salvato nella sessione
 * (session_info): lo ritrovi anche riaprendo la sessione più tardi.
 * La descrizione invece vive in memoria (rigenerata dal primo messaggio
 * quando riapri la sessione).
 *
 * La descrizione compare:
 *   1. come header in alto nella chat, sotto il logo π (mode TUI);
 *   2. il titolo corto resta come riga sticky sopra l'editor;
 *   3. nel titolo della finestra/terminale (titolo corto).
 *
 * Il logo π dell'header può essere grande (ASCII art su più righe)
 * oppure piccolo (simbolo su una riga) tramite la chiave "logo".
 *
 * Configurazione: ~/.pi/agent/pi-banner.json
 *   {
 *     "header": true,              // π + descrizione in alto nella chat
 *     "widget": true,              // titolo corto sticky sopra l'editor
 *     "widgetPlacement": "aboveEditor", // "aboveEditor" | "belowEditor"
 *     "terminalTitle": true,       // aggiorna il titolo del terminale
 *     "autoTitle": true,           // genera titolo+descrizione dal primo messaggio
 *     "autoTitleOnResume": true,   // genera titolo/descrizione riaprendo sessioni senza nome
 *     "titleModel": "",            // "provider/model" per titolo/descrizione; "" = modello corrente
 *     "titleMaxChars": 64,         // lunghezza massima del titolo corto
 *     "descriptionMaxChars": 280,  // lunghezza massima della descrizione estesa
 *     "titleMaxTokens": 256,       // token massimi per la generazione (titolo+descrizione)
 *     "titleTimeoutMs": 20000      // timeout della generazione
 *   }
 *
 * Comandi:
 *   /title              mostra il titolo corrente (e la descrizione)
 *   /title <testo>      imposta il titolo a mano
 *   /title auto         rigenera titolo+descrizione dal primo messaggio
 *   /desc               mostra la descrizione corrente
 *   /desc <testo>       imposta la descrizione a mano
 *   /desc auto          rigenera la descrizione dal primo messaggio
 *   /desc clear         nasconde la descrizione
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
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

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
	descriptionMaxChars: number;
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
	descriptionMaxChars: 280,
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
		if (typeof raw.descriptionMaxChars === "number") {
			config.descriptionMaxChars = Math.min(600, Math.max(80, Math.round(raw.descriptionMaxChars)));
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
// Stato della descrizione (in memoria, per sessione)
// ---------------------------------------------------------------------------

const descriptionBySession = new Map<string, string>();
let currentDescription: string | undefined;

// Testo originale completo del primo messaggio (in memoria, per sessione).
// L'header sotto il logo mostra questo testo, senza limiti di lunghezza.
const originalBySession = new Map<string, string>();
let currentOriginal: string | undefined;

function getSessionId(ctx: ExtensionContext): string | undefined {
	try {
		const sm = ctx.sessionManager as unknown as { getSessionId?: () => string };
		return typeof sm.getSessionId === "function" ? sm.getSessionId() : undefined;
	} catch {
		return undefined;
	}
}

function getDescription(ctx?: ExtensionContext): string | undefined {
	if (currentDescription) return currentDescription;
	if (ctx) {
		const sid = getSessionId(ctx);
		if (sid) return descriptionBySession.get(sid);
	}
	return undefined;
}

function setDescription(text: string | undefined, ctx?: ExtensionContext): void {
	currentDescription = text && text.trim() ? text.trim() : undefined;
	if (ctx) {
		const sid = getSessionId(ctx);
		if (sid) {
			if (currentDescription) descriptionBySession.set(sid, currentDescription);
			else descriptionBySession.delete(sid);
		}
	}
}

function getOriginal(ctx?: ExtensionContext): string | undefined {
	if (currentOriginal) return currentOriginal;
	if (ctx) {
		const sid = getSessionId(ctx);
		if (sid) return originalBySession.get(sid);
	}
	return undefined;
}

function setOriginal(text: string | undefined, ctx?: ExtensionContext): void {
	currentOriginal = text && text.trim() ? text.trim() : undefined;
	if (ctx) {
		const sid = getSessionId(ctx);
		if (sid) {
			if (currentOriginal) originalBySession.set(sid, currentOriginal);
			else originalBySession.delete(sid);
		}
	}
}

// ---------------------------------------------------------------------------
// Utilita' su testi e messaggi
// ---------------------------------------------------------------------------

interface AttachedImage {
	type: "image";
	data: string;
	mimeType: string;
}

interface FirstMessage {
	text: string;
	images: AttachedImage[];
}

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

function extractImages(content: unknown): AttachedImage[] {
	if (!Array.isArray(content)) return [];
	const out: AttachedImage[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const candidate = block as { type?: unknown; data?: unknown; mimeType?: unknown };
		if (
			candidate.type === "image" &&
			typeof candidate.data === "string" &&
			typeof candidate.mimeType === "string"
		) {
			out.push({ type: "image", data: candidate.data, mimeType: candidate.mimeType });
		}
	}
	return out;
}

/** Se il testo e' solo un elenco di allegati (@/path, /path, path escaped), ricava i basename. */
function humanizeAttachmentText(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return text;
	const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	const looksLikePath = (token: string): boolean => {
		const t = token.replace(/^["'`«»“”‘’]+|["'`«»“”‘’.,;:]+$/g, "").trim();
		if (!t) return false;
		if (t.startsWith("@")) return true;
		if (t.includes("/")) return true;
		if (/\.(png|jpe?g|gif|webp|bmp|mp4|mov|pdf|txt|md|ts|js|py|json|tsx|jsx)$/i.test(t)) return true;
		return false;
	};
	const allPaths = lines.every((line) => {
		const tokens = line.split(/\s+/).filter(Boolean);
		return tokens.length > 0 && tokens.every(looksLikePath);
	});
	if (!allPaths) return text;
	const basenames = lines
		.flatMap((line) => line.split(/\s+/))
		.map((token) =>
			token
				.replace(/^["'`«»“”‘’@]+|["'`«»“”‘’.,;:]+$/g, "")
				.replace(/\\( )/g, "$1")
				.trim(),
		)
		.filter(Boolean)
		.map((p) => {
			const parts = p.split("/");
			return parts[parts.length - 1] || p;
		})
		.filter(Boolean);
	if (!basenames.length) return text;
	return basenames.join(", ");
}

/** Primo messaggio utente del ramo corrente (testo + immagini allegate). */
function readFirstUserMessage(ctx: ExtensionContext): FirstMessage | undefined {
	try {
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "user") continue;
			const text = extractText(entry.message.content).trim();
			const images = extractImages(entry.message.content);
			if (text || images.length > 0) return { text, images };
		}
	} catch {
		// La sessione potrebbe non essere ancora pronta: ignora.
	}
	return undefined;
}

/** Titolo immediato (provvisorio) ricavato dalla prima riga del messaggio. */
function provisionalTitle(text: string): string {
	const humanized = humanizeAttachmentText(text);
	const firstLine =
		humanized
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

/** Descrizione immediata (provvisoria): prime frasi del messaggio, compattate. */
function provisionalDescription(text: string): string {
	let clean = humanizeAttachmentText(text).replace(/\s+/g, " ").trim();
	if (!clean) return "";
	if (clean.length > CONFIG.descriptionMaxChars) {
		const cut = clean.slice(0, CONFIG.descriptionMaxChars - 1);
		// Taglia sull'ultimo spazio per non spezzare le parole.
		const lastSpace = cut.lastIndexOf(" ");
		clean = `${(lastSpace > CONFIG.descriptionMaxChars * 0.5 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
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

/** Pulisce la descrizione restituita dal modello. */
function sanitizeDescription(raw: string): string | undefined {
	let text = raw
		.replace(/^["'`«»“”‘’]+|["'`«»“”‘’]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();
	// Se il modello ha aggiunto un'etichetta, toglila.
	text = text.replace(/^(descrizione|description|task|compito)\s*[:\-–—]\s*/i, "").trim();
	if (!text) return undefined;
	if (text.length > CONFIG.descriptionMaxChars) {
		const cut = text.slice(0, CONFIG.descriptionMaxChars - 1);
		const lastSpace = cut.lastIndexOf(" ");
		text = `${(lastSpace > CONFIG.descriptionMaxChars * 0.5 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
	}
	return text;
}

// ---------------------------------------------------------------------------
// Generazione di titolo + descrizione con il modello (una sola chiamata)
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

function parseTitleAndDescription(raw: string, fallbackText: string): { title?: string; description?: string } {
	// Il modello dovrebbe rispondere con JSON: {"title": "...", "description": "..."}
	const cleaned = raw
		.replace(/```(?:json)?\s*/gi, "")
		.replace(/```\s*/g, "")
		.trim();
	const start = cleaned.indexOf("{");
	const end = cleaned.lastIndexOf("}");
	if (start >= 0 && end > start) {
		try {
			const parsed = JSON.parse(cleaned.slice(start, end + 1)) as {
				title?: unknown;
				description?: unknown;
			};
			const title = typeof parsed.title === "string" ? sanitizeTitle(parsed.title) : undefined;
			const description =
				typeof parsed.description === "string" ? sanitizeDescription(parsed.description) : undefined;
			if (title || description) return { title, description };
		} catch {
			// Sotto: fallback sul testo libero.
		}
	}

	// Fallback: prova "title: ...\ndescription: ..." oppure usa il testo come titolo.
	const lines = cleaned.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	let title: string | undefined;
	let description: string | undefined;
	for (const line of lines) {
		const m = line.match(/^(titolo|title)\s*[:\-–—]\s*(.+)$/i);
		if (m && !title) {
			title = sanitizeTitle(m[2]);
			continue;
		}
		const d = line.match(/^(descrizione|description)\s*[:\-–—]\s*(.+)$/i);
		if (d && !description) {
			description = sanitizeDescription(d[2]);
		}
	}
	if (!title && lines.length > 0) title = sanitizeTitle(lines[0]);
	if (!description) description = sanitizeDescription(provisionalDescription(fallbackText));
	return { title, description };
}

async function generateTitleAndDescription(
	ctx: ExtensionContext,
	userText: string,
	images: AttachedImage[] = [],
): Promise<{ title?: string; description?: string }> {
	const model = pickTitleModel(ctx);
	if (!model) return {};

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), CONFIG.titleTimeoutMs);
	const onAbort = () => controller.abort();
	ctx.signal?.addEventListener("abort", onAbort, { once: true });

	try {
		// Usa il modello corrente (vision quando disponibile): se il primo messaggio
		// e' solo un allegato (@/path/screenshot.png) il testo da solo non basta —
		// il modello deve guardare le immagini per fare un titolo corto che stia
		// per intero nella barra in alto, senza troncamenti.
		const hasImages = images.length > 0;
		const displayText = humanizeAttachmentText(userText).slice(0, 1500);
		const prompt = [
			"Describe this coding session based on the user's first message.",
			hasImages
				? "The message includes attached images (e.g. screenshots): look at them carefully."
				: "No images attached.",
			"If the text is only file paths (e.g. @/path/to/screenshot.png), describe what is visible in the images and what the user likely wants.",
			"Reply with JSON only, no code fences, no extra text:",
			'{"title": "...", "description": "..."}',
			"Rules for \"title\":",
			`- Maximum ${CONFIG.titleMaxChars} characters, 3 to 8 words. Keep it SHORT so it fits in the top bar in full, without truncation.`,
			"- NEVER use a raw file path as title; describe the content instead.",
			"- Use the same language as the user's message.",
			"- No quotes, no emoji, no trailing punctuation, no labels like 'Title:'.",
			"- Describe the concrete task or topic.",
			"Rules for \"description\":",
			`- One or two sentences, maximum ${CONFIG.descriptionMaxChars} characters.`,
			"- Use the same language as the user's message.",
			"- Describe the concrete task, goal and relevant context.",
			"- No quotes, no emoji, no labels like 'Description:'.",
			"",
			"<first_message>",
			displayText,
			"</first_message>",
		].join("\n");

		const textPart = { type: "text" as const, text: prompt };
		const imageParts = images.slice(0, 4).map((img) => ({
			type: "image" as const,
			data: img.data,
			mimeType: img.mimeType,
		}));

		const send = async (withImages: boolean) =>
			ctx.modelRegistry.complete(
				model,
			{
				messages: [
					{
						role: "user" as const,
						content: withImages ? [textPart, ...imageParts] : [textPart],
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

		let response;
		try {
			response = await send(hasImages);
		} catch (err) {
			// Modello senza vision o provider che rifiuta le immagini: riprova solo testo.
			if (!hasImages) throw err;
			response = await send(false);
		}

		const text = response.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");

			return parseTitleAndDescription(text, displayText);
	} catch {
		// Timeout, abort o provider senza auth: si tengono i valori provvisori.
		return {};
	} finally {
		clearTimeout(timeout);
		ctx.signal?.removeEventListener("abort", onAbort);
	}
}

// ---------------------------------------------------------------------------
// Componenti TUI: header (logo + descrizione) e widget (titolo corto)
// ---------------------------------------------------------------------------

interface BannerState {
	title: string;
	hasTitle: boolean;
	description?: string;
	originalText?: string;
}

function currentState(pi: ExtensionAPI, ctx?: ExtensionContext): BannerState {
	const name = pi.getSessionName();
	return {
		title: name ?? PLACEHOLDER_TITLE,
		hasTitle: Boolean(name),
		description: getDescription(ctx),
		originalText: getOriginal(ctx),
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

/**
 * Header: logo + testo originale completo del primo messaggio (sotto il logo).
 * Nessun troncamento: il testo viene solo mandato a capo sulla larghezza
 * disponibile, per intero.
 */
function wrapFullText(text: string, width: number): string[] {
	const out: string[] = [];
	const w = Math.max(20, width);
	for (const paragraph of text.split(/\r?\n/)) {
		if (!paragraph.trim()) {
			out.push("");
			continue;
		}
		out.push(...wrapTextWithAnsi(paragraph.trim(), w));
	}
	// Evita header infiniti con messaggi enormi: mostra tutto, ma senza
	// righe vuote finali accumulate.
	while (out.length > 1 && out[out.length - 1] === "") out.pop();
	return out;
}

function makeHeaderComponent(state: BannerState, theme: Theme) {
	return {
		render(width: number): string[] {
			if (CONFIG.logo === "large") {
				const lines = getLargeLogo(theme).map((line) => truncateToWidth(line, width, "…"));
				// Sotto il logo: testo originale completo, senza limiti.
				const body = (state.originalText ?? state.description ?? "").trim();
				if (body) {
					for (const line of wrapFullText(body, width - 2)) {
						lines.push(line ? `  ${line}` : "");
					}
				} else {
					const title = state.hasTitle
						? theme.bold(state.title)
						: theme.italic(theme.fg("dim", state.title));
					lines.push(`  ${title}`);
				}
				return lines;
			}

			const logoMark = theme.fg("accent", "π");
			const body = (state.originalText ?? state.description ?? state.title).trim();
			if (!body) return [`${logoMark}`];
			// Versione piccola: comunque testo intero, mandato a capo.
			const full = wrapFullText(body, width - 4);
			const lines: string[] = full.map((line) => (line ? `${logoMark}  ${line}` : ""));
			return lines;
		},
		invalidate() {
			// Il tema arriva da un Proxy "live": il contenuto si ricalcola a ogni render.
		},
	};
}

/** Widget: descrizione corta AI, sticky sopra l'editor — sempre per intero, mai troncata. */
function makeWidgetComponent(state: BannerState, theme: Theme) {
	return {
		render(width: number): string[] {
			const styled = state.hasTitle
				? theme.bold(state.title)
				: theme.italic(theme.fg("dim", state.title));
			// Mostra il titolo corto per intero: wrap su piu' righe invece di troncare con …
			// Il titolo e' generato corto dall'AI apposta per stare in 1 riga; il wrap
			// garantisce comunque la visibilita' completa su terminali stretti.
			const lines = wrapTextWithAnsi(styled, Math.max(20, width));
			return lines.length > 0 ? lines : [styled];
		},
		invalidate() {
			// Il tema arriva da un Proxy "live": il contenuto si ricalcola a ogni render.
		},
	};
}

/** Aggiorna header, widget e titolo del terminale in base allo stato corrente. */
function refreshUI(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const state = currentState(pi, ctx);

	if (ctx.mode === "tui" && CONFIG.header) {
		ctx.ui.setHeader((_tui, theme) => makeHeaderComponent(state, theme));
	}
	if (CONFIG.widget) {
		ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => makeWidgetComponent(state, theme), {
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
	 * Raffina titolo + descrizione con una chiamata al modello.
	 * `force` serve a /title auto e /desc auto, che devono funzionare
	 * anche con autoTitle=false.
	 * Se la sessione ha già un titolo (es. impostato con /title), aggiorna
	 * solo la descrizione per non sovrascriverlo.
	 */
	async function refineTitleAndDescription(
		ctx: ExtensionContext,
		userText: string,
		force = false,
		images: AttachedImage[] = [],
	): Promise<void> {
		if (titleInFlight) return;
		if (!force && !CONFIG.autoTitle) return;
		if (!ctx.hasUI) return;

		const expected = pi.getSessionName();
		titleInFlight = true;
		try {
			const generated = await generateTitleAndDescription(ctx, userText, images);
			// Non sovrascrivere un titolo cambiato nel frattempo (es. /title o /name).
			if (pi.getSessionName() !== expected) {
				if (generated.description) {
					setDescription(generated.description, ctx);
					refreshUI(pi, ctx);
				}
				return;
			}
			let changed = false;
			if (generated.title && generated.title !== expected) {
				pi.setSessionName(generated.title);
				changed = true;
			}
			if (generated.description && generated.description !== getDescription(ctx)) {
				setDescription(generated.description, ctx);
				changed = true;
			}
			if (changed) refreshUI(pi, ctx);
		} finally {
			titleInFlight = false;
		}
	}

	// All'avvio: mostra subito il testo originale completo sotto il logo;
	// titolo corto + descrizione restano per widget e terminale.
	pi.on("session_start", (_event, ctx) => {
		titleInFlight = false;
		// Ripristina descrizione e originale già noti per questa sessione (stesso processo).
		const sid = getSessionId(ctx);
		currentDescription = (sid ? descriptionBySession.get(sid) : undefined) ?? undefined;
		currentOriginal = (sid ? originalBySession.get(sid) : undefined) ?? undefined;
		const first = readFirstUserMessage(ctx);
		if (first?.text) setOriginal(first.text, ctx);
		refreshUI(pi, ctx);

		if (!ctx.hasUI) return;
		if (!first?.text && !first?.images.length) return;

		const firstText = first?.text ?? "";
		const firstImages = first?.images ?? [];

		if (!pi.getSessionName()) {
			if (!CONFIG.autoTitle || !CONFIG.autoTitleOnResume) return;
			pi.setSessionName(provisionalTitle(firstText || "screenshot"));
			setDescription(provisionalDescription(firstText) || "Immagine allegata", ctx);
			refreshUI(pi, ctx);
			void refineTitleAndDescription(ctx, firstText, false, firstImages);
		} else if (!getDescription(ctx)) {
			if (!CONFIG.autoTitle || !CONFIG.autoTitleOnResume) return;
			setDescription(provisionalDescription(firstText) || "Immagine allegata", ctx);
			refreshUI(pi, ctx);
			void refineTitleAndDescription(ctx, firstText, false, firstImages);
		}
	});

	// Titolo cambiato (dall'estensione, da /name o da /title): aggiorna la UI.
	pi.on("session_info_changed", (_event, ctx) => {
		refreshUI(pi, ctx);
	});

	// Prima che l'agente parta: salva il testo originale completo per l'header
	// e assegna titolo + descrizione (provvisori e poi raffinati) per widget/terminale.
	pi.on("before_agent_start", async (event, ctx) => {
		const evt = event as { prompt: string; images?: AttachedImage[] };
		if (!ctx.hasUI || !evt.prompt.trim()) return;
		// L'header mostra il primo messaggio per intero: non sovrascriverlo
		// con i messaggi successivi.
		if (!getOriginal(ctx)) setOriginal(evt.prompt, ctx);
		if (pi.getSessionName() && getDescription(ctx)) {
			refreshUI(pi, ctx);
			return;
		}

		if (!pi.getSessionName()) {
			pi.setSessionName(provisionalTitle(evt.prompt));
		}
		if (!getDescription(ctx)) {
			setDescription(provisionalDescription(evt.prompt), ctx);
		}
		refreshUI(pi, ctx);

		if (CONFIG.autoTitle) {
			await refineTitleAndDescription(ctx, evt.prompt, false, evt.images ?? []);
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		if (ctx.mode === "tui") ctx.ui.setHeader(undefined);
	});

	// Comando manuale: /title, /title <testo>, /title auto
	pi.registerCommand("title", {
		description: "Mostra o imposta il titolo corto (uso: /title [testo | auto])",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const input = args.trim();

			if (!input) {
				const current = pi.getSessionName();
				const desc = getDescription(ctx);
				if (ctx.hasUI) {
					ctx.ui.notify(
						current
							? `Titolo: ${current}${desc ? `\nDescrizione: ${desc}` : ""}`
							: "Nessun titolo impostato. Usa /title <testo> oppure /title auto.",
						"info",
					);
				}
				return;
			}

			if (input === "auto" || input === "rigenera" || input === "regen") {
				const first = readFirstUserMessage(ctx);
				if (!first?.text && !first?.images.length) {
					if (ctx.hasUI) ctx.ui.notify("Nessun messaggio utente su cui basare il titolo.", "warning");
					return;
				}
				if (titleInFlight) {
					if (ctx.hasUI) ctx.ui.notify("Generazione del titolo già in corso…", "warning");
					return;
				}
				const firstText = first?.text ?? "";
				const firstImages = first?.images ?? [];
				pi.setSessionName(provisionalTitle(firstText || "screenshot"));
				setDescription(provisionalDescription(firstText) || "Immagine allegata", ctx);
				refreshUI(pi, ctx);
				await refineTitleAndDescription(ctx, firstText, true, firstImages);
				if (ctx.hasUI) {
					const desc = getDescription(ctx);
					ctx.ui.notify(
						`Titolo: ${pi.getSessionName() ?? "—"}${desc ? `\nDescrizione: ${desc}` : ""}`,
						"info",
					);
				}
				return;
			}

			pi.setSessionName(input);
			if (ctx.hasUI) {
				ctx.ui.notify(`Titolo sessione: ${pi.getSessionName() ?? input}`, "info");
			}
		},
	});

	// Comando manuale: /desc, /desc <testo>, /desc auto, /desc clear
	pi.registerCommand("desc", {
		description: "Mostra o imposta la descrizione estesa (uso: /desc [testo | auto | clear])",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const input = args.trim();

			if (!input) {
				const desc = getDescription(ctx);
				if (ctx.hasUI) {
					ctx.ui.notify(desc ? `Descrizione: ${desc}` : "Nessuna descrizione. Usa /desc <testo> oppure /desc auto.", "info");
				}
				return;
			}

			if (input === "clear" || input === "cancella" || input === "off") {
				setDescription(undefined, ctx);
				refreshUI(pi, ctx);
				if (ctx.hasUI) ctx.ui.notify("Descrizione nascosta.", "info");
				return;
			}

			if (input === "auto" || input === "rigenera" || input === "regen") {
				const first = readFirstUserMessage(ctx);
				if (!first?.text && !first?.images.length) {
					if (ctx.hasUI) ctx.ui.notify("Nessun messaggio utente su cui basare la descrizione.", "warning");
					return;
				}
				if (titleInFlight) {
					if (ctx.hasUI) ctx.ui.notify("Generazione già in corso…", "warning");
					return;
				}
				const firstText = first?.text ?? "";
				const firstImages = first?.images ?? [];
				setDescription(provisionalDescription(firstText) || "Immagine allegata", ctx);
				refreshUI(pi, ctx);
				await refineTitleAndDescription(ctx, firstText, true, firstImages);
				if (ctx.hasUI) {
					ctx.ui.notify(`Descrizione: ${getDescription(ctx) ?? "—"}`, "info");
				}
				return;
			}

			setDescription(sanitizeDescription(input) ?? input.slice(0, CONFIG.descriptionMaxChars), ctx);
			refreshUI(pi, ctx);
			if (ctx.hasUI) {
				ctx.ui.notify(`Descrizione: ${getDescription(ctx) ?? input}`, "info");
			}
		},
	});
}
