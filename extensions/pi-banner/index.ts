/**
 * pi-banner — extension for Pi
 * ==============================
 * Shows, on every session, the title and the original text:
 *
 *   Header (under the π logo): the full original text of the first
 *   user message, without truncation, wrapped to the available width.
 *
 *   Widget (sticky line above the editor): a short description generated
 *   by the AI in use (same model as the session, with vision for the
 *   attached screenshots), always shown in full with wrapping instead of
 *   truncating with ….
 *
 * The title is generated automatically from the user's first message
 * *before* the model starts replying, and is saved in the session
 * (session_info): you'll find it again by reopening the session later.
 * The description instead lives in memory (regenerated from the first
 * message when you reopen the session).
 *
 * The description appears:
 *   1. as a header at the top of the chat, under the π logo (TUI mode);
 *   2. the short title stays as a sticky line above the editor;
 *   3. in the window/terminal title (short title).
 *
 * The π logo in the header can be large (ASCII art on multiple lines)
 * or small (a symbol on one line) via the "logo" key.
 *
 * Configuration: ~/.pi/agent/pi-banner.json
 *   {
 *     "header": true,              // π + description at the top of the chat
 *     "widget": true,              // short title sticky above the editor
 *     "widgetPlacement": "aboveEditor", // "aboveEditor" | "belowEditor"
 *     "terminalTitle": true,       // update the terminal title
 *     "autoTitle": true,           // generate title+description from the first message
 *     "autoTitleOnResume": true,   // generate title/description when reopening unnamed sessions
 *     "titleModel": "",            // "provider/model" for title/description; "" = current model
 *     "titleMaxChars": 64,         // max length of the short title
 *     "descriptionMaxChars": 280,  // max length of the extended description
 *     "titleMaxTokens": 256,       // max tokens for generation (title+description)
 *     "titleTimeoutMs": 20000      // timeout for generation
 *   }
 *
 * Commands:
 *   /title              shows the current title (and description)
 *   /title <text>       sets the title by hand
 *   /title auto         regenerates title+description from the first message
 *   /desc               shows the current description
 *   /desc <text>        sets the description by hand
 *   /desc auto          regenerates the description from the first message
 *   /desc clear         hides the description
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
// Configuration
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
		// Missing or invalid file: use the default values.
	}

	return config;
}

const CONFIG = loadConfig();

const WIDGET_KEY = "pi-banner-title";
const PLACEHOLDER_TITLE = "session without title";

// ---------------------------------------------------------------------------
// Description state (in memory, per session)
// ---------------------------------------------------------------------------

const descriptionBySession = new Map<string, string>();
let currentDescription: string | undefined;

// Full original text of the first message (in memory, per session).
// The header under the logo shows this text, with no length limit.
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
// Helpers for text and messages
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

/** If the text is only a list of attachments (@/path, /path, escaped path), extract the basenames. */
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

/** First user message of the current branch (text + attached images). */
function readFirstUserMessage(ctx: ExtensionContext): FirstMessage | undefined {
	try {
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "user") continue;
			const text = extractText(entry.message.content).trim();
			const images = extractImages(entry.message.content);
			if (text || images.length > 0) return { text, images };
		}
	} catch {
		// The session may not be ready yet: ignore.
	}
	return undefined;
}

/** Immediate (provisional) title taken from the first line of the message. */
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

/** Immediate (provisional) description: first sentences of the message, compacted. */
function provisionalDescription(text: string): string {
	let clean = humanizeAttachmentText(text).replace(/\s+/g, " ").trim();
	if (!clean) return "";
	if (clean.length > CONFIG.descriptionMaxChars) {
		const cut = clean.slice(0, CONFIG.descriptionMaxChars - 1);
		// Cut at the last space so as not to break words.
		const lastSpace = cut.lastIndexOf(" ");
		clean = `${(lastSpace > CONFIG.descriptionMaxChars * 0.5 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
	}
	return clean;
}

/** Cleans the title returned by the model. */
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

/** Cleans the description returned by the model. */
function sanitizeDescription(raw: string): string | undefined {
	let text = raw
		.replace(/^["'`«»“”‘’]+|["'`«»“”‘’]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();
	// If the model added a label, remove it.
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
// Generating title + description with the model (a single call)
// ---------------------------------------------------------------------------

type TitleModel = ReturnType<ExtensionContext["modelRegistry"]["getAvailable"]>[number];

function pickTitleModel(ctx: ExtensionContext): TitleModel | undefined {
	const registry = ctx.modelRegistry;

	// 1. Model explicitly set in the configuration.
	if (CONFIG.titleModel) {
		const slash = CONFIG.titleModel.indexOf("/");
		if (slash > 0) {
			const model = registry.find(CONFIG.titleModel.slice(0, slash), CONFIG.titleModel.slice(slash + 1));
			if (model && registry.hasConfiguredAuth(model)) return model;
		}
	}

	// 2. Current model of the session.
	if (ctx.model && registry.hasConfiguredAuth(ctx.model)) return ctx.model;

	// 3. First available model with configured credentials.
	return registry.getAvailable().find((model) => registry.hasConfiguredAuth(model));
}

function parseTitleAndDescription(raw: string, fallbackText: string): { title?: string; description?: string } {
	// The model should reply with JSON: {"title": "...", "description": "..."}
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
			// Below: fallback to free text.
		}
	}

	// Fallback: try "title: ...\ndescription: ..." or use the text as the title.
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
		// Use the current model (vision when available): if the first message
		// is only an attachment (@/path/screenshot.png) the text alone is not
		// enough — the model must look at the images to make a short title that
		// fits in full in the top bar, with no truncation.
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
			// Model without vision or provider that rejects images: retry with text only.
			if (!hasImages) throw err;
			response = await send(false);
		}

		const text = response.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");

			return parseTitleAndDescription(text, displayText);
	} catch {
		// Timeout, abort or provider without auth: keep the provisional values.
		return {};
	} finally {
		clearTimeout(timeout);
		ctx.signal?.removeEventListener("abort", onAbort);
	}
}

// ---------------------------------------------------------------------------
// TUI components: header (logo + description) and widget (short title)
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

/** Large π logo in ASCII art, colored with the theme "accent" color. */
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
 * Header: logo + full original text of the first message (under the logo).
 * No truncation: the text is only wrapped to the available
 * width, in full.
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
	// Avoid infinite headers with huge messages: show everything, but without
	// the accumulated trailing empty lines.
	while (out.length > 1 && out[out.length - 1] === "") out.pop();
	return out;
}

function makeHeaderComponent(state: BannerState, theme: Theme) {
	return {
		render(width: number): string[] {
			if (CONFIG.logo === "large") {
				const lines = getLargeLogo(theme).map((line) => truncateToWidth(line, width, "…"));
				// Under the logo: full original text, with no limits.
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
			// Small version: still the full text, wrapped.
			const full = wrapFullText(body, width - 4);
			const lines: string[] = full.map((line) => (line ? `${logoMark}  ${line}` : ""));
			return lines;
		},
		invalidate() {
			// Il tema arriva da un Proxy "live": il contenuto si ricalcola a ogni render.
		},
	};
}

/** Widget: short AI description, sticky above the editor — always in full, never truncated. */
function makeWidgetComponent(state: BannerState, theme: Theme) {
	return {
		render(width: number): string[] {
			const styled = state.hasTitle
				? theme.bold(state.title)
				: theme.italic(theme.fg("dim", state.title));
			// Show the short title in full: wrap on multiple lines instead of truncating with …
			// The title is generated short by the AI on purpose to fit in one line; the wrap
			// still guarantees full visibility on narrow terminals.
			const lines = wrapTextWithAnsi(styled, Math.max(20, width));
			return lines.length > 0 ? lines : [styled];
		},
		invalidate() {
			// Il tema arriva da un Proxy "live": il contenuto si ricalcola a ogni render.
		},
	};
}

/** Updates the header, widget and terminal title based on the current state. */
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
// Extension
// ---------------------------------------------------------------------------

export default function piBannerExtension(pi: ExtensionAPI) {
	let titleInFlight = false;

	/**
	 * Refine title + description with a single call to the model.
	 * `force` is used by /title auto and /desc auto, which must work
	 * even with autoTitle=false.
	 * If the session already has a title (e.g. set with /title), update
	 * only the description so as not to overwrite it.
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
			// Don't overwrite a title changed in the meantime (e.g. /title or /name).
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

	// At startup: immediately show the full original text under the logo;
	// the short title + description remain for the widget and terminal.
	pi.on("session_start", (_event, ctx) => {
		titleInFlight = false;
		// Restore the already-known description and original text for this session (same process).
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
			setDescription(provisionalDescription(firstText) || "Attached image", ctx);
			refreshUI(pi, ctx);
			void refineTitleAndDescription(ctx, firstText, false, firstImages);
		} else if (!getDescription(ctx)) {
			if (!CONFIG.autoTitle || !CONFIG.autoTitleOnResume) return;
			setDescription(provisionalDescription(firstText) || "Attached image", ctx);
			refreshUI(pi, ctx);
			void refineTitleAndDescription(ctx, firstText, false, firstImages);
		}
	});

	// Title changed (from the extension, from /name or from /title): update the UI.
	pi.on("session_info_changed", (_event, ctx) => {
		refreshUI(pi, ctx);
	});

	// Before the agent starts: save the full original text for the header
	// and assign the title + description (provisional, then refined) for the widget/terminal.
	pi.on("before_agent_start", async (event, ctx) => {
		const evt = event as { prompt: string; images?: AttachedImage[] };
		if (!ctx.hasUI || !evt.prompt.trim()) return;
		// The header shows the first message in full: don't overwrite it
		// with subsequent messages.
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

	// Manual command: /title, /title <text>, /title auto
	pi.registerCommand("title", {
		description: "Shows or sets the short title (usage: /title [text | auto])",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const input = args.trim();

			if (!input) {
				const current = pi.getSessionName();
				const desc = getDescription(ctx);
				if (ctx.hasUI) {
					ctx.ui.notify(
						current
							? `Title: ${current}${desc ? `\nDescription: ${desc}` : ""}`
							: "No title set. Use /title <text> or /title auto.",
						"info",
					);
				}
				return;
			}

			if (input === "auto" || input === "regenerate" || input === "regen") {
				const first = readFirstUserMessage(ctx);
				if (!first?.text && !first?.images.length) {
					if (ctx.hasUI) ctx.ui.notify("No user message to base the title on.", "warning");
					return;
				}
				if (titleInFlight) {
					if (ctx.hasUI) ctx.ui.notify("Title generation already in progress…", "warning");
					return;
				}
				const firstText = first?.text ?? "";
				const firstImages = first?.images ?? [];
				pi.setSessionName(provisionalTitle(firstText || "screenshot"));
				setDescription(provisionalDescription(firstText) || "Attached image", ctx);
				refreshUI(pi, ctx);
				await refineTitleAndDescription(ctx, firstText, true, firstImages);
				if (ctx.hasUI) {
					const desc = getDescription(ctx);
					ctx.ui.notify(
						`Title: ${pi.getSessionName() ?? "—"}${desc ? `\nDescription: ${desc}` : ""}`,
						"info",
					);
				}
				return;
			}

			pi.setSessionName(input);
			if (ctx.hasUI) {
				ctx.ui.notify(`Session title: ${pi.getSessionName() ?? input}`, "info");
			}
		},
	});

	// Manual command: /desc, /desc <text>, /desc auto, /desc clear
	pi.registerCommand("desc", {
		description: "Shows or sets the extended description (usage: /desc [text | auto | clear])",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const input = args.trim();

			if (!input) {
				const desc = getDescription(ctx);
				if (ctx.hasUI) {
					ctx.ui.notify(desc ? `Description: ${desc}` : "No description. Use /desc <text> or /desc auto.", "info");
				}
				return;
			}

			if (input === "clear" || input === "off") {
				setDescription(undefined, ctx);
				refreshUI(pi, ctx);
				if (ctx.hasUI) ctx.ui.notify("Description hidden.", "info");
				return;
			}

			if (input === "auto" || input === "regenerate" || input === "regen") {
				const first = readFirstUserMessage(ctx);
				if (!first?.text && !first?.images.length) {
					if (ctx.hasUI) ctx.ui.notify("No user message to base the description on.", "warning");
					return;
				}
				if (titleInFlight) {
					if (ctx.hasUI) ctx.ui.notify("Generation already in progress…", "warning");
					return;
				}
				const firstText = first?.text ?? "";
				const firstImages = first?.images ?? [];
				setDescription(provisionalDescription(firstText) || "Attached image", ctx);
				refreshUI(pi, ctx);
				await refineTitleAndDescription(ctx, firstText, true, firstImages);
				if (ctx.hasUI) {
					ctx.ui.notify(`Description: ${getDescription(ctx) ?? "—"}`, "info");
				}
				return;
			}

			setDescription(sanitizeDescription(input) ?? input.slice(0, CONFIG.descriptionMaxChars), ctx);
			refreshUI(pi, ctx);
			if (ctx.hasUI) {
				ctx.ui.notify(`Description: ${getDescription(ctx) ?? input}`, "info");
			}
		},
	});
}
