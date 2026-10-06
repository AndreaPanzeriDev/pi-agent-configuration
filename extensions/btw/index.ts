/**
 * btw — side question con pieni poteri, senza mai lasciare la sessione.
 *
 * /btw <domanda> apre un pannello overlay SOPRA la chat corrente (nessun
 * cambio di schermata, nessun fork). La domanda viene girata a un processo
 * `pi` completamente fresco e isolato:
 *   - contesto pulito: parte dalla repo (cwd corrente), NON dalla chat;
 *   - TUTTI i tool: built-in, estensioni, MCP server, skill — tutto quello
 *     che carica un pi normale è disponibile anche lì;
 *   - stesso modello e stesso thinking level della sessione corrente;
 *   - sessione effimera (--no-session): non tocca le sessioni salvate,
 *     le statistiche né il report giornaliero.
 *
 * /btw -c <domanda>  come sopra, ma include anche il testo della
 *                    conversazione corrente nel prompt (stile Claude Code).
 *
 * Il pannello mostra in streaming testo, tool in esecuzione e risultato
 * finale in Markdown. q/Esc interrompe; quando è finito Esc/Enter chiude.
 *
 * /btw senza argomenti mostra l'utilizzo.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Key,
	Markdown,
	ScrollView,
	Text,
	type TUI,
	matchesKey,
	truncateToWidth,
} from "@earendil-works/pi-tui";

// ─────────────────────────────── Stato ────────────────────────────────

type BtwPhase = "running" | "done" | "aborted" | "error";

type DisplayItem = { kind: "text"; text: string } | { kind: "tool"; label: string; isError: boolean };

interface BtwUsage {
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

interface BtwState {
	question: string;
	withContext: boolean;
	phase: BtwPhase;
	items: DisplayItem[];
	liveText: string;
	status: string;
	statusIsError: boolean;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	stderr: string;
	usage: BtwUsage;
}

function freshState(question: string, withContext: boolean): BtwState {
	return {
		question,
		withContext,
		phase: "running",
		items: [],
		liveText: "",
		status: "",
		statusIsError: false,
		stderr: "",
		usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
	};
}

// ─────────────────────────── Formattazione ────────────────────────────

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsage(usage: BtwUsage, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (model) parts.push(model);
	return parts.join(" · ");
}

function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function formatToolCall(toolName: string, args: Record<string, unknown>): string {
	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			return `$ ${command}`;
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = shortenPath(rawPath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += `:${startLine}${endLine ? `-${endLine}` : ""}`;
			}
			return `read ${text}`;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			return `write ${shortenPath(rawPath)}${lines > 1 ? ` (${lines} righe)` : ""}`;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return `edit ${shortenPath(rawPath)}`;
		}
		case "find": {
			return `find ${(args.pattern as string) || "*"} in ${shortenPath((args.path as string) || ".")}`;
		}
		case "grep": {
			return `grep /${(args.pattern as string) || ""}/ in ${shortenPath((args.path as string) || ".")}`;
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 60 ? `${argsStr.slice(0, 60)}…` : argsStr;
			return `${toolName} ${preview}`;
		}
	}
}

// ─────────────────────── Contesto conversazione (-c) ──────────────────

type ContentBlock = { type?: string; text?: string; name?: string; arguments?: Record<string, unknown> };
type SessionEntry = { type: string; message?: { role?: string; content?: unknown } };

const CONTEXT_CHAR_CAP = 15000;

function extractTextParts(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	const parts: string[] = [];
	for (const block of content) {
		const b = block as ContentBlock;
		if (b && typeof b === "object" && b.type === "text" && typeof b.text === "string") parts.push(b.text);
	}
	return parts;
}

function extractToolCallLines(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const lines: string[] = [];
	for (const block of content) {
		const b = block as ContentBlock;
		if (b && typeof b === "object" && b.type === "toolCall" && typeof b.name === "string") {
			lines.push(`  → ${formatToolCall(b.name, b.arguments ?? {})}`);
		}
	}
	return lines;
}

function buildConversationContext(entries: SessionEntry[]): string {
	const sections: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message?.role) continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = extractTextParts(entry.message.content).join("\n").trim();
		const lines: string[] = [];
		if (text) lines.push(`${role === "user" ? "Utente" : "Assistente"}: ${text}`);
		if (role === "assistant") lines.push(...extractToolCallLines(entry.message.content));
		if (lines.length > 0) sections.push(lines.join("\n"));
	}
	let context = sections.join("\n\n").trim();
	if (context.length > CONTEXT_CHAR_CAP) {
		context = `[…contesto troncato: mostro solo la parte finale…]\n\n${context.slice(-CONTEXT_CHAR_CAP)}`;
	}
	return context;
}

// ──────────────────────── Prompt di sistema (btw) ─────────────────────

const BTW_SYSTEM_PROMPT = `You are answering a one-off side question ("/btw") shown in an overlay panel on top of the user's main Pi session.

- This is a FRESH conversation: you have no memory of the main chat. Your context is the current repository/working directory.
- You have the FULL tool set available (bash, read, edit, write, find, grep, MCP servers, skills, extensions). Use tools freely whenever they help — including making requests or running commands.
- The panel is small: be direct and concise. Compact markdown. Show only the relevant parts of code or output.
- Answer in the same language as the question. No greetings, no preamble.`;

// ───────────────────────── Runner del subprocess ──────────────────────

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

const activeProcs = new Set<ReturnType<typeof spawn>>();

function killSoon(proc: ReturnType<typeof spawn>): void {
	proc.kill("SIGTERM");
	setTimeout(() => {
		try {
			proc.kill("SIGKILL");
		} catch {
			/* già morto */
		}
	}, 2000).unref?.();
}

interface BtwRun {
	done: Promise<void>;
	kill: () => void;
}

/**
 * Lancia `pi --mode json` e aggiorna `state` man mano che arrivano gli
 * eventi JSONL. `schedule()` è la callback di invalidazione dell'overlay.
 */
function runBtw(state: BtwState, argv: string[], cwd: string, schedule: () => void): BtwRun {
	let proc: ReturnType<typeof spawn> | undefined;
	let resolved = false;

	const done = new Promise<void>((resolve) => {
		const finish = () => {
			if (resolved) return;
			resolved = true;
			resolve();
		};

		let child: ReturnType<typeof spawn>;
		try {
			const invocation = getPiInvocation(argv);
			child = spawn(invocation.command, invocation.args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (err) {
			state.phase = "error";
			state.errorMessage = err instanceof Error ? err.message : String(err);
			schedule();
			finish();
			return;
		}
		proc = child;

		activeProcs.add(child);

		let buffer = "";

		const processLine = (line: string) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			let event: any;
			try {
				event = JSON.parse(trimmed);
			} catch {
				return;
			}

			switch (event.type) {
				case "message_update": {
					const ev = event.assistantMessageEvent;
					if (ev?.type === "text_delta" && typeof ev.delta === "string") {
						state.liveText += ev.delta;
						schedule();
					}
					break;
				}
				case "message_end": {
					const msg = event.message;
					if (!msg || msg.role !== "assistant") break;
					const texts = extractTextParts(msg.content);
					if (texts.length > 0) state.items.push({ kind: "text", text: texts.join("\n").trim() });
					state.liveText = "";
					state.usage.turns++;
					const usage = msg.usage;
					if (usage) {
						state.usage.input += usage.input || 0;
						state.usage.output += usage.output || 0;
						state.usage.cacheRead += usage.cacheRead || 0;
						state.usage.cacheWrite += usage.cacheWrite || 0;
						state.usage.cost += usage.cost?.total || 0;
					}
					if (!state.model && msg.model) state.model = msg.model;
					if (msg.stopReason) state.stopReason = msg.stopReason;
					if (msg.errorMessage) state.errorMessage = msg.errorMessage;
					schedule();
					break;
				}
				case "tool_execution_start": {
					state.status = formatToolCall(event.toolName, event.args ?? {});
					state.statusIsError = false;
					schedule();
					break;
				}
				case "tool_execution_end": {
					state.items.push({
						kind: "tool",
						label: state.status || (event.toolName as string) || "tool",
						isError: Boolean(event.isError),
					});
					state.status = "";
					state.statusIsError = Boolean(event.isError);
					schedule();
					break;
				}
				default:
					break;
			}
		};

		child.stdout?.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});

		child.stderr?.on("data", (data) => {
			state.stderr += data.toString();
		});

		child.on("close", (code) => {
			if (buffer.trim()) processLine(buffer);
			if (state.liveText.trim()) {
				state.items.push({ kind: "text", text: state.liveText.trim() });
				state.liveText = "";
			}
			if (state.phase === "running") {
				const ok = code === 0 && state.stopReason !== "error" && state.stopReason !== "aborted";
				state.phase = ok ? "done" : "error";
				if (!ok && !state.errorMessage) {
					state.errorMessage =
						state.stderr.trim() || `processo pi terminato con exit code ${code} (stop: ${state.stopReason})`;
				}
			}
			activeProcs.delete(child);
			schedule();
			finish();
		});

		child.on("error", (err) => {
			if (state.phase === "running") {
				state.phase = "error";
				state.errorMessage = err.message;
			}
			activeProcs.delete(child);
			schedule();
			finish();
		});
	});

	return {
		done,
		kill: () => {
			if (state.phase === "running") {
				state.phase = "aborted";
				if (proc) killSoon(proc);
			}
		},
	};
}

// ─────────────────────────── Overlay UI ───────────────────────────────

const REFRESH_MS = 80;

class BtwOverlay extends Container {
	private readonly tui: TUI;
	private readonly state: BtwState;
	private readonly content = new Container();
	private readonly scroll: ScrollView;
	private readonly header = new Text("", 1, 0);
	private readonly statusText = new Text("", 1, 0);
	private readonly footer = new Text("", 1, 0);
	private pendingTimer: ReturnType<typeof setTimeout> | undefined;
	private finished = false;

	constructor(
		tui: TUI,
		theme: Theme,
		state: BtwState,
		private readonly finish: (result: "closed" | "aborted") => void,
		private readonly kill: () => void,
	) {
		super();
		this.tui = tui;
		this.state = state;
		const border = (s: string) => theme.fg("border", s);

		this.scroll = new ScrollView(this.content, { follow: "end", scrollbar: "auto" });

		this.addChild(new DynamicBorder(border));
		this.addChild(this.header);
		this.addChild(new DynamicBorder(border));
		this.addChild(this.scroll);
		this.addChild(this.statusText);
		this.addChild(this.footer);
		this.addChild(new DynamicBorder(border));

		this.rebuild();
	}

	/** Aggiornamenti throttled dal runner. */
	schedule = (): void => {
		if (this.pendingTimer || this.finished) return;
		this.pendingTimer = setTimeout(() => {
			this.pendingTimer = undefined;
			this.rebuild();
		}, REFRESH_MS);
		this.pendingTimer.unref?.();
	};

	/** Redraw immediato (fine lavoro). */
	flush = (): void => {
		if (this.finished) return;
		if (this.pendingTimer) {
			clearTimeout(this.pendingTimer);
			this.pendingTimer = undefined;
		}
		this.rebuild();
	};

	private rebuild(): void {
		const state = this.state;
		const mdTheme = getMarkdownTheme();

		const title = state.phase === "running" ? "btw · side question" : "btw";
		const qPreview = truncateToWidth(state.question.replace(/\s+/g, " "), 110);
		this.header.setText(`${title}${state.withContext ? "  (+contesto chat)" : ""}\n${qPreview}`);

		this.content.clear();
		if (state.items.length === 0 && !state.liveText.trim() && state.phase === "running") {
			this.content.addChild(new Text("…", 1, 0));
		}
		for (const item of state.items) {
			if (item.kind === "text") {
				this.content.addChild(new Markdown(item.text, 1, 0, mdTheme));
			} else {
				const icon = item.isError ? "✗" : "✓";
				this.content.addChild(new Text(`→ ${icon} ${item.label}`, 1, 0));
			}
			// Separatore tra i blocchi per leggibilità
			this.content.addChild(new Text("", 0, 0));
		}
		if (state.liveText.trim()) {
			this.content.addChild(new Markdown(state.liveText, 1, 0, mdTheme));
		}

		if (state.phase === "running") {
			const activity = state.status
				? `${state.statusIsError ? "✗" : "·"} ${truncateToWidth(state.status, 120)}`
				: "in corso…";
			this.statusText.setText(activity);
			this.footer.setText("q/Esc interrompi · ↑↓ scorri");
		} else {
			const line =
				state.phase === "done"
					? `✓ completato · ${formatUsage(state.usage, state.model)}`
					: state.phase === "aborted"
						? "⏹ interrotto"
						: `✗ errore: ${state.errorMessage || state.stopReason || "sconosciuto"}`;
			this.statusText.setText(line);
			this.footer.setText("Esc/Enter chiudi · ↑↓ scorri");
		}

		this.content.invalidate();
		this.scroll.invalidate();
		this.invalidate();
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		const running = this.state.phase === "running";

		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			if (running) this.kill();
			this.closeOverlay("aborted");
			return;
		}
		if (running && (data === "q" || data === "Q")) {
			this.kill();
			this.closeOverlay("aborted");
			return;
		}
		if (!running && (matchesKey(data, "enter") || matchesKey(data, "return") || data === "q" || data === "Q")) {
			this.closeOverlay("closed");
			return;
		}

		// Scrolling
		if (matchesKey(data, "up")) this.scroll.scrollBy(-3);
		else if (matchesKey(data, "down")) this.scroll.scrollBy(3);
		else if (matchesKey(data, Key.pageUp)) this.scroll.scrollBy(-(this.scroll.viewportHeight || 20));
		else if (matchesKey(data, Key.pageDown)) this.scroll.scrollBy(this.scroll.viewportHeight || 20);
		else if (matchesKey(data, "home")) this.scroll.scrollToStart();
		else if (matchesKey(data, "end")) this.scroll.scrollToEnd();
		else return;

		this.scroll.invalidate();
		this.invalidate();
		this.tui.requestRender();
	}

	private closeOverlay(result: "closed" | "aborted"): void {
		if (this.finished) return;
		this.finished = true;
		if (this.pendingTimer) {
			clearTimeout(this.pendingTimer);
			this.pendingTimer = undefined;
		}
		this.finish(result);
	}

	dispose(): void {
		if (this.pendingTimer) {
			clearTimeout(this.pendingTimer);
			this.pendingTimer = undefined;
		}
	}
}

// ─────────────────────────── Estensione ───────────────────────────────

export default function (pi: ExtensionAPI) {
	// Se la sessione principale si chiude, non lasciare processi btw orfani.
	pi.on("session_shutdown", () => {
		for (const proc of activeProcs) {
			if (!proc.killed) killSoon(proc);
		}
		activeProcs.clear();
	});

	pi.registerCommand("btw", {
		description: "Side question in overlay: contesto fresco (repo) + tutti i tool. -c include la chat corrente",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/btw richiede la modalità interattiva (TUI)", "error");
				return;
			}

			// Parsing argomenti
			let rest = args.trim();
			let withContext = false;
			if (/^(-c|--chat)(\s|$)/.test(rest)) {
				withContext = true;
				rest = rest.replace(/^(-c|--chat)\s*/, "");
			}
			const question = rest.trim();
			if (!question) {
				ctx.ui.notify(
					"Utilizzo: /btw <domanda> — oppure /btw -c <domanda> per includere anche la conversazione corrente",
					"warning",
				);
				return;
			}

			// Prompt finale per il processo laterale
			let prompt = `[Side question via /btw]\n\n${question}`;
			if (withContext) {
				const branch = ctx.sessionManager.getBranch() as unknown as SessionEntry[];
				const conversation = buildConversationContext(branch);
				if (conversation) {
					prompt = `[Contesto della conversazione corrente, solo come riferimento — la domanda vera è alla fine.]\n\n<conversazione>\n${conversation}\n</conversazione>\n\n---\n\nDomanda: ${question}`;
				}
			}

			// Processo pi laterale: contesto fresco, tutti i tool (estensioni e
			// MCP comprese), stesso modello e thinking level della sessione.
			const argv: string[] = ["--mode", "json", "--no-session", "--append-system-prompt", BTW_SYSTEM_PROMPT];
			if (ctx.model) argv.push("--model", `${ctx.model.provider}/${ctx.model.id}`);
			if (ctx.thinkingLevel) argv.push("--thinking", String(ctx.thinkingLevel));
			argv.push(prompt);

			const state = freshState(question, withContext);
			let overlay: BtwOverlay | undefined;
			const run = runBtw(state, argv, ctx.cwd, () => overlay?.schedule());

			await ctx.ui.custom<"closed" | "aborted">(
				(tui, theme, _kb, done) => {
					overlay = new BtwOverlay(tui, theme, state, done, run.kill);
					void run.done.then(() => overlay?.flush());
					return overlay;
				},
				{
					overlay: true,
					overlayOptions: { width: "92%", maxHeight: "75%", anchor: "center" },
				},
			);
		},
	});
}
