/**
 * Tok/s footer
 *
 * Replaces the built-in footer with one that shows the generation speed
 * (output tokens per second) of the last assistant response inline in the
 * stats line, next to the token/cost numbers. The context percentage is
 * intentionally omitted.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Delta event types that correspond to output tokens. */
const OUTPUT_DELTA_TYPES = new Set(["text_delta", "thinking_delta", "toolcall_delta"]);

export default function (pi: ExtensionAPI) {
	// Set from the footer factory so event handlers can trigger a re-render.
	let requestRender: (() => void) | undefined;

	// Streaming-window timing for the assistant message currently being streamed:
	// performance.now() of the first and most recent output-token delta.
	let firstDeltaAt: number | undefined;
	let lastDeltaAt: number | undefined;

	// Measured tok/s per assistant message (keyed by responseId ?? timestamp), so the
	// footer can prefer the streaming-window speed over the durationMs-based estimate.
	const measured = new Map<string, number>();
	const keyOf = (a: AssistantMessage) => `${a.responseId ?? "?"}:${a.timestamp}`;

	const install = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			requestRender = () => tui.requestRender();

			return {
				dispose: () => {
					unsub();
					requestRender = undefined;
				},
				invalidate() {},
				render(width: number) {
					let input = 0,
						output = 0,
						cacheRead = 0,
						cacheWrite = 0,
						cost = 0;
					let tokPerSec: number | undefined;

					for (const e of ctx.sessionManager.getBranch()) {
						if (e.type !== "message") continue;
						const m = e.message;
						if (m.role === "assistant") {
							const a = m as AssistantMessage;
							input += a.usage.input;
							output += a.usage.output;
							cacheRead += a.usage.cacheRead;
							cacheWrite += a.usage.cacheWrite;
							cost += a.usage.cost.total;
							if (a.durationMs && a.durationMs > 0 && a.usage.output > 0) {
								// Prefer the streaming-window measurement (delta-to-delta time, which excludes
								// connection/request overhead and time-to-first-token); fall back to the
								// durationMs estimate for messages loaded from history.
								const streamed = measured.get(keyOf(a));
								tokPerSec = streamed ?? a.usage.output / (a.durationMs / 1000);
							}
						} else if (m.role === "toolResult" && m.usage) {
							input += m.usage.input;
							output += m.usage.output;
							cacheRead += m.usage.cacheRead;
							cacheWrite += m.usage.cacheWrite;
							cost += m.usage.cost.total;
						}
					}

					const fmt = (n: number) =>
						n < 1000 ? `${n}` : n < 1000000 ? `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k` : `${(n / 1000000).toFixed(1)}M`;

					const statsParts: string[] = [];
					if (input) statsParts.push(`↑${fmt(input)}`);
					if (output) statsParts.push(`↓${fmt(output)}`);
					if (cacheRead) statsParts.push(`R${fmt(cacheRead)}`);
					if (cacheWrite) statsParts.push(`W${fmt(cacheWrite)}`);
					if (cost) statsParts.push(`$${cost.toFixed(3)}`);
					if (tokPerSec !== undefined) {
						statsParts.push(theme.fg("accent", `${tokPerSec.toFixed(1)} tok/s`));
					}

					let statsLeft = statsParts.join(" ");

					// Right side: model name, thinking level, provider
					let rightSide = ctx.model?.id || "no-model";
					if (ctx.model?.reasoning) {
						const level = ctx.thinkingLevel || "off";
						rightSide = level === "off" ? `${rightSide} • thinking off` : `${rightSide} • ${level}`;
					}
					if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
						rightSide = `(${ctx.model.provider}) ${rightSide}`;
					}

					// Pwd line: cwd and git branch
					let pwd = ctx.cwd;
					const branch = footerData.getGitBranch();
					if (branch) pwd = `${pwd} (${branch})`;

					let statsLine: string;
					const statsWidth = visibleWidth(statsLeft);
					const rightWidth = visibleWidth(rightSide);
					const minPadding = 2;
					if (statsWidth + minPadding + rightWidth <= width) {
						const padding = " ".repeat(width - statsWidth - rightWidth);
						statsLine = statsLeft + padding + rightSide;
					} else if (statsWidth > width) {
						statsLeft = truncateToWidth(statsLeft, width, "...");
						statsLine = statsLeft;
					} else {
						rightSide = truncateToWidth(rightSide, Math.max(1, width - statsWidth - minPadding), "...");
						const padding = " ".repeat(Math.max(0, width - statsWidth - visibleWidth(rightSide)));
						statsLine = statsLeft + padding + rightSide;
					}

					// Dim each part separately so the colored tok/s keeps its color
					const dimStats = theme.fg("dim", statsLeft);
					const remainder = statsLine.slice(statsLeft.length);
					const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
					return [pwdLine, dimStats + theme.fg("dim", remainder)];
				},
			};
		});
	};

	pi.on("session_start", async (_event, ctx) => install(ctx));

	pi.on("message_update", async (event) => {
		// Time the actual token streaming: from the first output delta to the last one.
		// This excludes request/connection overhead and time-to-first-token, which are
		// part of durationMs but are not generation speed.
		if (OUTPUT_DELTA_TYPES.has(event.assistantMessageEvent.type)) {
			const now = performance.now();
			if (firstDeltaAt === undefined) firstDeltaAt = now;
			lastDeltaAt = now;
		}
	});

	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		const a = event.message as AssistantMessage;
		if (
			a.usage?.output > 0 &&
			firstDeltaAt !== undefined &&
			lastDeltaAt !== undefined &&
			lastDeltaAt > firstDeltaAt
		) {
			measured.set(keyOf(a), a.usage.output / ((lastDeltaAt - firstDeltaAt) / 1000));
			if (measured.size > 200) {
				const oldest = measured.keys().next().value;
				if (oldest !== undefined) measured.delete(oldest);
			}
		}
		firstDeltaAt = undefined;
		lastDeltaAt = undefined;
		requestRender?.();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		requestRender = undefined;
		ctx.ui.setFooter(undefined);
	});
}
