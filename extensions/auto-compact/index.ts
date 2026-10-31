/**
 * Auto-compact at a percentage of the context window
 *
 * Pi's built-in auto-compaction only fires near the hard limit
 * (`contextWindow - reserveTokens`, i.e. ~98% of a 1M window). This extension
 * adds an earlier, model-agnostic guard: every time an agent run settles, it
 * checks the current context usage and, if the percentage is at or above
 * `COMPACT_ABOVE_PERCENT`, compacts the session before you continue.
 *
 * The check runs at `agent_settled` (after retries and pi's own automatic
 * compaction have stopped), so it never interrupts a run in progress. The
 * built-in threshold remains active as a safety net for long agentic loops
 * that never settle before hitting the limit.
 *
 * Tunables:
 *   /autocompact           show the current threshold and context usage
 *   /autocompact 90        change the threshold for this session
 *   /autocompact off       disable the guard for this session
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_THRESHOLD_PERCENT = 85;
/** Don't retry a failed compaction on every settle. */
const RETRY_COOLDOWN_MS = 60_000;

export default function (pi: ExtensionAPI) {
	let thresholdPercent: number | null = DEFAULT_THRESHOLD_PERCENT;
	let lastAttemptAt = 0;
	let compacting = false;

	pi.on("agent_settled", async (event, ctx) => {
		if (event.aborted || compacting || thresholdPercent === null) return;

		const usage = ctx.getContextUsage();
		if (!usage || usage.percent === null) return; // unknown right after a compaction
		if (usage.percent < thresholdPercent) return;

		const now = Date.now();
		if (now - lastAttemptAt < RETRY_COOLDOWN_MS) return;
		lastAttemptAt = now;
		compacting = true;

		const label = `${usage.percent.toFixed(1)}% of ${usage.contextWindow.toLocaleString()} tokens`;
		if (ctx.hasUI) {
			ctx.ui.notify(`Context at ${label} (≥ ${thresholdPercent}%), compacting…`, "info");
		}

		// Defer past the settle transition: compact() aborts the current agent
		// operation first, and at this point there is nothing left to abort.
		setTimeout(() => {
			// A new prompt may have started a run in the meantime; never abort it.
			if (!ctx.isIdle()) {
				compacting = false;
				return;
			}
			ctx.compact({
				onComplete: () => {
					compacting = false;
					if (ctx.hasUI) ctx.ui.notify("Auto-compaction completed", "info");
				},
				onError: (error) => {
					compacting = false;
					if (ctx.hasUI) ctx.ui.notify(`Auto-compaction failed: ${error.message}`, "error");
				},
			});
		}, 0);
	});

	const showStatus = (ctx: ExtensionCommandContext) => {
		const usage = ctx.getContextUsage();
		const current =
			usage && usage.percent !== null
				? `${usage.percent.toFixed(1)}% (${usage.tokens?.toLocaleString()} / ${usage.contextWindow.toLocaleString()})`
				: "unknown (compacted, waiting for next response)";
		const threshold = thresholdPercent === null ? "disabled" : `${thresholdPercent}%`;
		ctx.ui.notify(`Auto-compact threshold: ${threshold} • current context: ${current}`, "info");
	};

	pi.registerCommand("autocompact", {
		description: "Show or change the percentage at which the session auto-compacts",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "") {
				showStatus(ctx);
				return;
			}
			if (arg === "off" || arg === "disable") {
				thresholdPercent = null;
				ctx.ui.notify("Auto-compact guard disabled for this session", "info");
				return;
			}
			const value = Number(arg);
			if (!Number.isFinite(value) || value < 1 || value > 100) {
				ctx.ui.notify("Usage: /autocompact [1-100|off]", "error");
				return;
			}
			thresholdPercent = value;
			ctx.ui.notify(`Auto-compact threshold set to ${value}%`, "info");
			showStatus(ctx);
		},
	});
}
