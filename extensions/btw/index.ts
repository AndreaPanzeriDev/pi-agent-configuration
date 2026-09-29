/**
 * btw — domanda laterale ("side question"), come /btw di Claude Code
 *
 * /btw <domanda> pone una domanda allo *stesso modello* con in contesto la
 * conversazione corrente, SENZA strumenti e in un'unica risposta, mentre
 * l'agente principale continua a lavorare indisturbato. Non è un subagent:
 * nulla blocca il turno in corso.
 *
 * Pannello in overlay modellato su quello di Claude Code:
 *
 *   (+2 altre domande /btw)          <- cronologia nascosta
 *   /btw come funziona X?            <- scambi precedenti (in grassetto se selezionato)
 *   /btw cosa c'è in questo errore?  <- domanda corrente ("/btw" in evidenza)
 *
 *   ... risposta in markdown (scorrevole) ...
 *
 *   ⇧←/⇧→ sfoglia · ↑/↓ scorri · c copia · x azzera cronologia · esc chiudi
 *
 * Scorciatoie:
 *   /btw                riapre il pannello sull'ultima domanda/risposta
 *   ⇧← / ⇧→ (o [ / ])   sfoglia le risposte precedenti
 *   ↑ / ↓ (o ctrl+p/n)  scorre il testo, pagina su/giù per salti più ampi
 *   c                   copia la risposta in markdown negli appunti
 *   x                   azzera la cronologia
 *   esc / invio / q     chiude (la domanda in corso continua in background)
 *
 * Come in Claude Code la risposta NON entra nella conversazione principale:
 * è una domanda laterale. Per ripristinare il vecchio comportamento
 * (risposta iniettata nel contesto) metti INJECT_INTO_CONVERSATION a true.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, Model, TextContent, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Loader, Markdown, getNativeClipboard, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** Consegna la risposta anche alla conversazione principale (vecchio comportamento). */
const INJECT_INTO_CONVERSATION = false;

/** Quanti scambi della cronologia mostra l'intestazione del pannello. */
const MAX_HEADER_ROWS = 5;

/** Budget in caratteri per il contesto di conversazione allegato alla domanda. */
const CONTEXT_BUDGET_CHARS = 60_000;

/** Limite per il singolo frammento (risultati di tool, output di shell, ...) estratto dal transcript. */
const FRAGMENT_LIMIT = 2_000;

/**
 * Istruzioni per il modello, identiche a quelle che Claude Code usa per /btw:
 * una singola risposta, nessuno strumento, nessuna azione promessa.
 */
const SIDE_QUESTION_PROMPT = `<system-reminder>This is a side question from the user. You must answer this question directly in a single response.
IMPORTANT CONTEXT:
- You are a separate, lightweight agent spawned to answer this one question
- The main agent is NOT interrupted - it continues working independently in the background
- You share the conversation context but are a completely separate instance
- Do NOT reference being interrupted or what you were "previously doing" - that framing is incorrect
CRITICAL CONSTRAINTS:
- You have NO tools available - you cannot read files, run commands, search, or take any actions
- Do NOT write tool calls or tool output as text (for example invoke or function_calls XML blocks) - nothing you write here is executed; if answering would need reading files, running commands, or searching, say that can't be checked from a side question and suggest asking in the main conversation
- This is a one-off response - there will be no follow-up turns
- You can ONLY provide information based on what you already know from the conversation context
- NEVER say things like "Let me try...", "I'll now...", "Let me check...", or promise to take any action
- If you don't know the answer, say so - do not offer to look it up or investigate
Simply answer the question with the information you have.</system-reminder>`;

/** Avviso quando la risposta contiene chiamate a tool scritte come testo (non eseguite). */
const TOOL_CALLS_NOTICE =
	"_/btw non può eseguire tool: eventuali chiamate a tool o output di tool mostrati sopra non sono stati eseguiti e potrebbero non riflettere i tuoi file o i tuoi dati reali. Chiedilo nella conversazione principale per verificare._";

/** Avviso quando la risposta è stata tagliata dal limite di token. */
const CUT_OFF_NOTICE = "_(Questa risposta è stata interrotta prima della fine. Riprova.)_";

/** Sostituto quando non c'è nessuna risposta utilizzabile. */
const NO_ANSWER = "(Nessuna risposta disponibile per questa domanda laterale. Riprova, o chiedilo nella conversazione principale.)";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Scambio già concluso, conservato nella cronologia. */
interface BtwExchange {
	question: string;
	answer: string;
	notice?: string;
	synthetic?: boolean;
	timestamp: number;
}

/** Domanda mostrata nello slot "corrente" del pannello (in esecuzione o appena conclusa). */
interface BtwLive {
	question: string;
	phase: "running" | "done" | "error";
	answer: string;
	notice?: string;
	error?: string;
	/** Lo scambio registrato in cronologia, quando la risposta è già stata salvata. */
	exchange?: BtwExchange;
}

function liveFromExchange(exchange: BtwExchange): BtwLive {
	return {
		question: exchange.question,
		phase: "done",
		answer: exchange.answer,
		notice: exchange.notice,
		exchange,
	};
}

/** Turno piatto del transcript, prima di essere convertito in Message. */
interface Turn {
	role: "user" | "assistant";
	text: string;
}

// ---------------------------------------------------------------------------
// Contesto della conversazione
// ---------------------------------------------------------------------------

function truncate(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}\n… [troncato]`;
}

/** Estrae solo le parti testuali da un content generico di messaggio. */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content as Array<Record<string, unknown>>) {
		if (part && part.type === "text" && typeof part.text === "string") parts.push(part.text);
	}
	return parts.join("\n");
}

/**
 * Appiattisce il transcript della sessione in turni di testo user/assistant,
 * così la domanda laterale condivide il contesto della conversazione senza
 * inviare blocchi tool_use orfani (la side question non ha strumenti).
 */
function flattenTranscript(messages: readonly AgentMessage[]): Turn[] {
	const turns: Turn[] = [];
	for (const message of messages) {
		const raw = message as unknown as Record<string, any>;
		switch (raw.role) {
			case "system":
				break;
			case "user": {
				const text = contentText(raw.content);
				if (text.trim()) turns.push({ role: "user", text: truncate(text, FRAGMENT_LIMIT) });
				break;
			}
			case "assistant": {
				const parts: string[] = [];
				for (const part of (raw.content ?? []) as Array<Record<string, any>>) {
					if (part.type === "text" && typeof part.text === "string") {
						parts.push(part.text);
					} else if (part.type === "toolCall") {
						const args = JSON.stringify(part.arguments ?? {});
						parts.push(`[chiamata al tool \`${part.name}\`]\n${truncate(args, 400)}`);
					}
				}
				const text = parts.join("\n");
				if (text.trim()) turns.push({ role: "assistant", text: truncate(text, FRAGMENT_LIMIT) });
				break;
			}
			case "toolResult": {
				const text = contentText(raw.content);
				const label = raw.isError ? `[errore del tool \`${raw.toolName}\`]` : `[risultato del tool \`${raw.toolName}\`]`;
				turns.push({ role: "user", text: truncate(`${label}\n${text}`, FRAGMENT_LIMIT) });
				break;
			}
			case "custom": {
				const text = contentText(raw.content);
				if (text.trim()) turns.push({ role: "user", text: truncate(`[${raw.customType}]\n${text}`, FRAGMENT_LIMIT) });
				break;
			}
			case "bashExecution": {
				const text = `[comando shell]\n$ ${truncate(String(raw.command ?? ""), 300)}\n${truncate(String(raw.output ?? ""), FRAGMENT_LIMIT)}`;
				turns.push({ role: "user", text });
				break;
			}
			case "compactionSummary":
			case "branchSummary": {
				turns.push({ role: "user", text: truncate(`[riepilogo]\n${String(raw.summary ?? "")}`, 4_000) });
				break;
			}
		}
	}
	return turns;
}

/** Unisce i turni consecutivi dello stesso ruolo e taglia i più vecchi se sfora il budget. */
function mergeTurns(turns: Turn[]): Turn[] {
	const merged: Turn[] = [];
	for (const turn of turns) {
		const prev = merged[merged.length - 1];
		if (prev && prev.role === turn.role) {
			prev.text = `${prev.text}\n\n${turn.text}`;
		} else {
			merged.push({ ...turn });
		}
	}
	let total = merged.reduce((sum, t) => sum + t.text.length, 0);
	while (merged.length > 1 && total > CONTEXT_BUDGET_CHARS) {
		total -= merged[0].text.length;
		merged.shift();
	}
	return merged;
}

function userMessage(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function assistantMessage(text: string, model: Model<any>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: EMPTY_USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function turnsToMessages(turns: Turn[], model: Model<any>): Message[] {
	return turns.map((turn) => (turn.role === "user" ? userMessage(turn.text) : assistantMessage(turn.text, model)));
}

// ---------------------------------------------------------------------------
// Richiesta della risposta
// ---------------------------------------------------------------------------

interface AskResult {
	answer: string;
	notice?: string;
	synthetic?: boolean;
}

function textOfAssistant(message: AssistantMessage): string {
	return message.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

/** Rileva chiamate a tool scritte come testo nella risposta (come fa Claude Code). */
function looksLikeToolCallText(text: string): boolean {
	return /<\s*(\/?\s*)?(invoke|function_calls|tool_use|tool_result|tool_call|antml:)/i.test(text);
}

/**
 * Pone la domanda laterale: stesso modello, contesto della conversazione,
 * cronologia delle domande precedenti, nessuno strumento, una sola risposta.
 */
async function askSideQuestion(options: {
	registry: ExtensionCommandContext["modelRegistry"];
	model: Model<any>;
	systemPrompt: string;
	transcript: Turn[];
	history: BtwExchange[];
	question: string;
	signal: AbortSignal;
	onPartial: (text: string) => void;
}): Promise<AskResult> {
	const { registry, model, systemPrompt, transcript, history, question, signal, onPartial } = options;

	const turns = [...transcript];
	for (const exchange of history) {
		turns.push({ role: "user", text: exchange.question }, { role: "assistant", text: exchange.answer });
	}
	turns.push({ role: "user", text: `${SIDE_QUESTION_PROMPT}\n${question}` });

	const request: Message[] = turnsToMessages(mergeTurns(turns), model);

	let message: AssistantMessage;
	try {
		const stream = registry.streamSimple(
			model,
			{ systemPrompt, messages: request },
			{ signal, toolChoice: "none" },
		);
		for await (const event of stream) {
			if (event.type === "text_start" || event.type === "text_delta") {
				onPartial(textOfAssistant(event.partial));
			}
		}
		message = await stream.result();
	} catch (error) {
		const text = error instanceof Error ? error.message : String(error);
		return { answer: `(Errore API: ${text})`, synthetic: true };
	}

	const answer = textOfAssistant(message).trim();
	if (answer) {
		const notices: string[] = [];
		if (looksLikeToolCallText(answer)) notices.push(TOOL_CALLS_NOTICE);
		if (message.stopReason === "length") notices.push(CUT_OFF_NOTICE);
		return { answer, notice: notices.length > 0 ? notices.join("\n") : undefined };
	}

	if (message.stopReason === "aborted") return { answer: NO_ANSWER, synthetic: true };

	const toolCall = message.content.find((part) => part.type === "toolCall");
	if (toolCall && toolCall.type === "toolCall") {
		return {
			answer: `(Il modello ha provato a chiamare il tool ${toolCall.name} invece di rispondere direttamente. Riprova con una formulazione diversa, o chiedilo nella conversazione principale.)`,
			synthetic: true,
		};
	}

	if (message.errorMessage) {
		return { answer: `(Errore API: ${message.errorMessage})`, synthetic: true };
	}

	return { answer: NO_ANSWER, synthetic: true };
}

// ---------------------------------------------------------------------------
// Appunti
// ---------------------------------------------------------------------------

async function copyToClipboard(tui: TUI, pi: ExtensionAPI, text: string): Promise<boolean> {
	const clipboard = getNativeClipboard();
	if (clipboard?.setText) {
		try {
			await clipboard.setText(text);
			return true;
		} catch {
			/* riprova con le vie successive */
		}
	}

	// Su Linux il clipboard nativo spesso non mantiene la proprietà: usiamo i tool da shell.
	// Su Windows usiamo clip.exe o PowerShell; altrove wl-copy/xclip/xsel (Linux) e pbcopy (macOS).
	try {
		const tmp = path.join(os.tmpdir(), `btw-copy-${process.pid}-${Date.now()}.txt`);
		fs.writeFileSync(tmp, text, "utf8");
		const script =
			'if command -v clip.exe >/dev/null 2>&1; then clip.exe < "$1";exit $?;fi;' +
			'if command -v wl-copy >/dev/null 2>&1; then wl-copy < "$1";exit $?;fi;' +
			'if command -v xclip >/dev/null 2>&1; then xclip -selection clipboard < "$1";exit $?;fi;' +
			'if command -v xsel >/dev/null 2>&1; then xsel --clipboard < "$1";exit $?;fi;' +
			'if command -v pbcopy >/dev/null 2>&1; then pbcopy < "$1";exit $?;fi;' +
			"powershell.exe -NoProfile -Command \"Set-Clipboard -Path '$1'\" 2>/dev/null || exit 127";
		const result = await pi
			.exec("bash", ["-c", script, "btw-copy", tmp], { timeout: 3_000 })
			.catch(() =>
				// Niente bash (tipicamente Windows): prova diretto con PowerShell.
				pi.exec("powershell.exe", ["-NoProfile", "-Command", `Set-Clipboard -Path '${tmp}'`], {
					timeout: 3_000,
				}),
			);
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* il file temporaneo può essere già stato rimosso */
		}
		if (result.code === 0) return true;
	} catch {
		/* riprova con OSC 52 */
	}

	// Ultima risorsa: OSC 52 (funziona anche da remoto, se il terminale lo consente).
	try {
		tui.terminal.write(`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`);
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Pannello
// ---------------------------------------------------------------------------

interface BtwPanelOptions {
	/** Scambi già conclusi mostrati in intestazione (escluso quello nello slot corrente). */
	prior: BtwExchange[];
	/** Domanda corrente: in esecuzione o appena conclusa. */
	live: BtwLive | null;
	onClose: () => void;
	onClearHistory: () => void;
	copy: (text: string) => Promise<boolean>;
}

class BtwPanel implements Component {
	private tui: TUI;
	private theme: Theme;
	private loader: Loader;
	private body: Markdown;
	private options: BtwPanelOptions;
	private selected: number | null = null;
	private scrollOffset = 0;
	private copiedUntil = 0;
	private wasRunning = false;

	constructor(tui: TUI, theme: Theme, options: BtwPanelOptions) {
		this.tui = tui;
		this.theme = theme;
		this.options = options;

		this.loader = new Loader(
			tui,
			(s) => theme.fg("accent", s),
			(s) => theme.fg("warning", s),
			"Risposta in corso…",
		);
		if (options.live?.phase === "running") this.loader.start();

		this.body = new Markdown("", 0, 0, getMarkdownTheme(), {
			color: (s) => theme.fg("text", s),
		});
	}

	/** Il testo attualmente mostrato nel corpo (per la copia). */
	private currentAnswer(): string {
		if (this.selected !== null) return this.options.prior[this.selected]?.answer ?? "";
		return this.options.live?.answer ?? "";
	}

	private browse(direction: -1 | 1): void {
		const count = this.options.prior.length;
		if (count === 0) return;
		if (this.selected === null) {
			this.selected = direction === -1 ? count - 1 : null;
		} else {
			const next = this.selected + direction;
			this.selected = next < 0 ? 0 : next >= count ? null : next;
		}
		this.scrollOffset = 0;
		this.tui.requestRender();
	}

	private scroll(lines: number): void {
		this.scrollOffset = Math.max(0, this.scrollOffset + lines);
		this.tui.requestRender();
	}

	private async copy(): Promise<void> {
		const answer = this.currentAnswer();
		if (!answer) return;
		const ok = await this.options.copy(answer);
		if (ok) {
			this.copiedUntil = Date.now() + 1_500;
			this.tui.requestRender();
			setTimeout(() => this.tui.requestRender(), 1_600);
		}
	}

	/** Aggiorna la vista quando lo stato della domanda cambia fuori da render(). */
	requestRender(): void {
		if (this.options.live?.phase !== "running") this.loader.stop();
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "return") || matchesKey(data, "q")) {
			this.options.onClose();
			return;
		}
		if (matchesKey(data, "shift+left") || matchesKey(data, "[")) {
			this.browse(-1);
		} else if (matchesKey(data, "shift+right") || matchesKey(data, "]")) {
			this.browse(1);
		} else if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
			this.scroll(-1);
		} else if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
			this.scroll(1);
		} else if (matchesKey(data, "pageUp")) {
			this.scroll(-10);
		} else if (matchesKey(data, "pageDown")) {
			this.scroll(10);
		} else if (matchesKey(data, "c")) {
			void this.copy();
		} else if (matchesKey(data, "x")) {
			this.options.prior = [];
			this.selected = null;
			this.options.onClearHistory();
			this.tui.requestRender();
		}
	}

	/** Intestazione: cronologia + riga della domanda corrente. */
	private renderHeader(innerW: number): string[] {
		const th = this.theme;
		const lines: string[] = [];
		const prior = this.options.prior;
		const visible = prior.slice(-MAX_HEADER_ROWS);
		const hidden = prior.length - visible.length;

		if (hidden > 0) {
			lines.push(th.fg("muted", `  (+${hidden} ${hidden === 1 ? "altra domanda" : "altre domande"} /btw)`));
		}
		const base = prior.length - visible.length;
		visible.forEach((exchange, i) => {
			const label = `  /btw ${truncateToWidth(exchange.question, innerW - 8, "…")}`;
			lines.push(this.selected === base + i ? th.bold(th.fg("text", label)) : th.fg("muted", label));
		});

		const live = this.options.live;
		if (live) {
			const question = truncateToWidth(live.question, innerW - 8, "…");
			lines.push(`  ${th.fg("warning", th.bold("/btw"))} ${th.fg("muted", question)}`);
		}
		return lines;
	}

	/** Corpo: spinner durante l'attesa, altrimenti la risposta in markdown. */
	private renderBody(width: number, rows: number): string[] {
		const th = this.theme;
		const selected = this.selected !== null ? this.options.prior[this.selected] : undefined;
		const live = this.selected === null ? this.options.live : undefined;

		let content: string[] = [];
		if (selected) {
			content = this.renderAnswer(selected.notice, selected.answer, width);
		} else if (live && live.phase === "running") {
			const streamed = live.answer ? this.renderAnswer(live.notice, live.answer, width) : [];
			content = [...this.loader.render(width), ...streamed];
		} else if (live && live.phase === "error") {
			content = wrapTextWithAnsi(th.fg("error", live.error ?? "Errore sconosciuto"), width);
		} else if (live) {
			content = this.renderAnswer(live.notice, live.answer, width);
		} else {
			content = [th.fg("muted", "Nessuna domanda.")];
		}

		const maxOffset = Math.max(0, content.length - rows);
		const running = live?.phase === "running";
		if (running) {
			// Durante lo streaming segue la fine del testo...
			this.scrollOffset = maxOffset;
			this.wasRunning = true;
		} else if (this.wasRunning) {
			// ...poi, quando arriva la risposta, la mostra dall'inizio.
			this.wasRunning = false;
			this.scrollOffset = 0;
		}
		const offset = Math.min(this.scrollOffset, maxOffset);
		this.scrollOffset = offset;

		const slice = content.slice(offset, offset + rows);
		while (slice.length < rows) slice.push("");
		return slice;
	}

	private renderAnswer(notice: string | undefined, answer: string, width: number): string[] {
		const th = this.theme;
		const lines: string[] = [];
		if (notice) {
			lines.push(...wrapTextWithAnsi(th.fg("warning", notice), width));
			lines.push("");
		}
		if (!answer.trim()) {
			lines.push(th.fg("muted", "(il modello non ha prodotto alcun output)"));
			return lines;
		}
		this.body.setText(answer);
		lines.push(...this.body.render(width));
		return lines;
	}

	private renderFooter(width: number): string {
		const th = this.theme;
		if (Date.now() < this.copiedUntil) {
			return th.fg("success", "  Copiato negli appunti");
		}
		const hasAnswer = this.currentAnswer().trim().length > 0;
		const hints: string[] = [];
		if (this.options.prior.length > 0) hints.push("⇧←/⇧→ sfoglia");
		hints.push("↑/↓ scorri");
		if (hasAnswer) hints.push("c copia");
		if (this.options.prior.length > 0) hints.push("x azzera cronologia");
		hints.push("esc chiudi");
		return th.fg("muted", truncateToWidth(`  ${hints.join("  ·  ")}`, width, "…"));
	}

	render(width: number): string[] {
		const th = this.theme;
		// Corinice disegnata dentro il pannello: l'overlay di pi non ha bordi
		// nativi e senza cornice sembra un "quadrato" anonimo in mezzo allo schermo.
		const boxW = Math.max(28, width);
		const innerW = Math.max(24, boxW - 4); // 2 bordi + 2 spazi di padding
		const header = this.renderHeader(innerW);
		const footerRows = 2;
		const used = header.length + 1 + footerRows;
		const maxRows = Math.max(10, Math.floor(this.tui.terminal.rows * 0.9) - 4);
		const bodyRows = Math.max(4, maxRows - used);

		const content = ["", ...header, "", ...this.renderBody(innerW, bodyRows), "", this.renderFooter(innerW)];

		// Barra del titolo: rende chiaro che è una schermata a parte.
		const live = this.selected === null ? this.options.live : undefined;
		const status =
			live?.phase === "running" ? " ● rispondo…" : live?.phase === "error" ? " ● errore" : "";
		const title = ` ◆ /btw — domanda laterale${status} `;
		const topFill = Math.max(0, boxW - 2 - [...title].length);
		const top = th.fg("accent", `╭${title}${"─".repeat(topFill)}╮`);
		const bottom = th.fg("accent", `╰${"─".repeat(boxW - 2)}╯`);
		const side = (line: string) => {
			const cut = truncateToWidth(line, innerW, "…");
			const pad = " ".repeat(Math.max(0, innerW - visibleWidth(cut)));
			return `${th.fg("accent", "│")} ${cut}${pad} ${th.fg("accent", "│")}`;
		};

		return [top, ...content.map(side), bottom];
	}

	invalidate(): void {
		this.body.invalidate();
	}

	dispose(): void {
		this.loader.stop();
	}
}

// ---------------------------------------------------------------------------
// Estensione
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	/** Cronologia della sessione corrente (scambi conclusi). */
	let history: BtwExchange[] = [];
	/** Domanda corrente più recente, utile per riaprire il pannello con /btw. */
	let latest: BtwLive | null = null;
	/** Evita domande laterali concorrenti inutili: una sola per volta. */
	let inFlight = false;

	const remember = (live: BtwLive, result: AskResult) => {
		const exchange: BtwExchange = {
			question: live.question,
			answer: result.answer,
			notice: result.notice,
			synthetic: result.synthetic,
			timestamp: Date.now(),
		};
		live.phase = "done";
		live.answer = result.answer;
		live.notice = result.notice;
		if (!result.synthetic) {
			history.push(exchange);
			live.exchange = exchange;
			pi.appendEntry("btw-exchange", exchange);
		}
	};

	// Ricostruisce la cronologia della sessione (branch-aware) ad ogni avvio/sessione.
	pi.on("session_start", (_event, ctx) => {
		history = [];
		latest = null;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === "btw-history-clear") {
				history = [];
				continue;
			}
			if (entry.customType === "btw-exchange") {
				const data = entry.data as BtwExchange | undefined;
				if (data && typeof data.question === "string" && typeof data.answer === "string") {
					history.push(data);
				}
			}
		}
		if (history.length > 0) latest = liveFromExchange(history[history.length - 1]);
	});

	pi.registerCommand("btw", {
		description: "Ask a quick side question without interrupting the main conversation",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/btw richiede la modalità interattiva (TUI)", "error");
				return;
			}

			const question = args.trim();

			// /btw senza argomenti: riapre il pannello sull'ultima domanda/risposta
			// (come fa Claude Code) per rileggere le risposte precedenti.
			if (!question) {
				const shown: BtwLive | null =
					latest && latest.phase === "running"
						? latest
						: history.length > 0
							? liveFromExchange(history[history.length - 1])
							: latest;
				if (!shown) {
					ctx.ui.notify("Utilizzo: /btw <domanda>", "warning");
					return;
				}
				// Lo scambio mostrato nello slot corrente non va ripetuto in intestazione.
				const prior = history.filter((exchange) => exchange !== shown.exchange);
				openPanel(ctx, shown, prior);
				return;
			}

			if (inFlight) {
				ctx.ui.notify("C'è già una domanda /btw in corso", "warning");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("Nessun modello selezionato", "error");
				return;
			}

			// Tutto ciò che serve viene catturato subito: il resto gira in background
			// senza mai disturbare l'agente principale.
			const registry = ctx.modelRegistry;
			const model = ctx.model;
			const systemPrompt = ctx.getSystemPrompt();
			const transcript = flattenTranscript(ctx.sessionManager.buildSessionProjection().messages);
			const priorHistory = history.slice();
			const live: BtwLive = { question, phase: "running", answer: "" };
			latest = live;
			const prior = history.filter((exchange) => exchange !== live.exchange);

			const panel = openPanel(ctx, live, prior);
			const controller = new AbortController();
			inFlight = true;

			void askSideQuestion({
				registry,
				model,
				systemPrompt,
				transcript,
				history: priorHistory,
				question,
				signal: controller.signal,
				onPartial: (text) => {
					live.answer = text;
					panel.requestRender();
				},
			})
				.then((result) => {
					remember(live, result);
					if (INJECT_INTO_CONVERSATION && !result.synthetic) {
						try {
							pi.sendMessage(
								{
									customType: "btw-answer",
									content: `**Risposta /btw** ("${question}")\n\n${result.answer}`,
									display: true,
								},
								{ triggerTurn: false },
							);
						} catch {
							/* la sessione potrebbe essere terminata */
						}
					}
					if (panel.isClosed()) {
						ctx.ui.notify(`Risposta /btw pronta — /btw per rileggerla`, "info");
					}
				})
				.catch(() => {
					live.phase = "error";
					live.error = "Errore imprevisto durante la richiesta.";
				})
				.finally(() => {
					inFlight = false;
					panel.requestRender();
				});
		},
	});

	/**
	 * Apre il pannello in overlay SENZA aspettare la chiusura: il comando torna
	 * subito e l'agente principale continua a lavorare.
	 */
	function openPanel(ctx: ExtensionCommandContext, live: BtwLive, prior: BtwExchange[]): {
		requestRender: () => void;
		isClosed: () => boolean;
	} {
		let closed = false;
		let panel: BtwPanel | null = null;
		const handle = {
			requestRender: () => panel?.requestRender(),
			isClosed: () => closed,
		};

		void ctx.ui
			.custom<void>(
				(tui, theme, _keybindings, done) => {
					panel = new BtwPanel(tui, theme, {
						prior,
						live,
						onClose: () => {
							closed = true;
							done();
						},
						onClearHistory: () => {
							history = [];
							pi.appendEntry("btw-history-clear", { timestamp: Date.now() });
						},
						copy: (text) => copyToClipboard(tui, pi, text),
					});
					return panel;
				},
				{
					overlay: true,
					overlayOptions: {
						width: "90%",
						maxHeight: "90%",
						anchor: "center",
					},
				},
			)
			.then(() => {
				closed = true;
			});

		return handle;
	}
}
