/**
 * CC status line: model / cwd / git branch / context% / cost, via setFooter.
 * Fields mirror CC's StatusLine; colors stay on dim/muted theme tokens like
 * CC's dim status bar (warning only when the context is nearly exhausted).
 * Session totals (old ext "Total time · N turns" semantics): wall-clock since
 * session_start plus a user-turn counter, appended as one dim part.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isExtraDetail } from "./commands.js";

/**
 * Collapse the home-dir prefix of an absolute path to `~`, CC-style
 * (getDisplayPath, file.ts:163-166): only rewrite when the path actually sits
 * under home, guarded by a `home + "/"` boundary. A bare
 * `cwd.replace(HOME ?? "", "~")` injects a stray leading `~` when HOME is unset
 * (`replace("", "~")` matches at index 0) (AUDIT §5 status-line.ts:66).
 */
export function tildeHome(cwd: string): string {
	const home = homedir();
	if (!home) return cwd;
	if (cwd === home) return "~";
	if (cwd.startsWith(home + "/")) return "~" + cwd.slice(home.length);
	return cwd;
}

// Loose type for the assistant message usage we sum (avoids a direct pi-ai dependency).
interface AssistantUsage {
	usage: { cost: { total: number } };
}

/** Progress bar width (chars) — matches the bash reference script. */
const BAR_WIDTH = 13;
/** Characters for filled/empty segments. */
const BAR_FILLED = "█";
const BAR_EMPTY = "░";

/** Render a context-usage progress bar, color-coded by pct. */
function renderContextBar(pct: number, theme: import("@earendil-works/pi-coding-agent").Theme): string {
	const filled = Math.round(pct * BAR_WIDTH / 100);
	const empty = BAR_WIDTH - filled;
	let bar = "";
	// Pick color: success (< 70%), warning (70-90%), error (> 90%).
	const color = pct >= 90 ? "error" : pct >= 70 ? "warning" : "success";
	const colored = (s: string): string => theme.fg(color, s);
	for (let i = 0; i < filled; i++) bar += BAR_FILLED;
	for (let i = 0; i < empty; i++) bar += BAR_EMPTY;
	return `${colored(bar)} ${pct}%`;
}

export function registerStatusLine(pi: ExtensionAPI): void {
	function formatTokens(n: number): string {
		if (n < 1000) return `${n}`;
		return `${(n / 1000).toFixed(1)}k`;
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		// Session cost and turns: seeded from branch history on resume.
		// message_end with role "user" fires exactly once per submitted prompt
		// (agent-loop.js:51-54/96-103) — not per LLM turn, so it isn't inflated
		// by tools/retries/compaction.
		let cost = 0;
		let turns = 0;
		for (const e of ctx.sessionManager.getBranch()) {
			if (e.type === "message" && e.message.role === "assistant") {
				cost += (e.message as unknown as AssistantUsage).usage.cost.total;
			}
			if (e.type === "message" && e.message.role === "user") {
				turns += 1;
			}
		}

		pi.on("message_end", async (event) => {
			// Optional-chain the whole path: a failure-path assistant message may
			// carry no usage, and defensive handlers must not throw in the bus.
			if (event.message?.role === "assistant") {
				cost += (event.message as { usage?: { cost?: { total?: number } } }).usage?.cost?.total ?? 0;
			} else if (event.message?.role === "user") {
				turns += 1;
			}
		});

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					const model = ctx.model?.id ?? "no-model";
					const cwd = tildeHome(ctx.cwd);
					const branch = footerData.getGitBranch();
					const usage = ctx.getContextUsage();
					const window = ctx.model?.contextWindow ?? 0;
					const tokens = usage?.tokens ?? 0;
					const pct = window > 0 ? Math.round((tokens / window) * 100) : 0;

					const parts: string[] = [theme.fg("muted", model)];
					parts.push(theme.fg("dim", cwd));
					if (branch) parts.push(theme.fg("dim", branch));
					if (tokens > 0) {
						if (window > 0) {
							parts.push(renderContextBar(pct, theme));
						} else {
							parts.push(theme.fg("dim", formatTokens(tokens)));
						}
					}
					if (cost > 0) parts.push(theme.fg("dim", `$${cost.toFixed(2)}`));
					// extra detail (≈CC verbose) is a persistent toggle; when triggered accidentally
					// it can flood thousands of lines per screen, so it must be visible in the
					// status bar — otherwise users have no way to know the source of the flood
					// (2026-09-22 incident).
					// CC's own status bar has no verbose section (verified StatusLine.tsx); this
					// is an element beyond CC: use dim mode indicator only, no warning — warning
					// is reserved for critical states like near-exhaustion, not mode toggles.
					if (isExtraDetail()) parts.push(theme.fg("dim", "detail"));
					// Turn count appended when > 0 (session has received at least one user turn).
					if (turns > 0) parts.push(theme.fg("dim", `${turns} ${turns === 1 ? "turn" : "turns"}`));

					const line = parts.join(theme.fg("dim", " · "));
					return [truncateToWidth(line, width, "")];
				},
			};
		});
	});
}
