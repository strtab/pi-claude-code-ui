/**
 * Commands: /cc-tools, /cc-theme, /cc-spinner (same names as the old extension
 * to keep migration cost zero). Extra detail aligned with CC: no keyboard shortcut
 * (CC only toggles verbose in the /config panel), can only toggle via /cc-tools detail,
 * shows detail indicator in status bar when enabled.
 *
 * The group and extra-detail toggles persist to ~/.pi/settings.json (old ext
 * writeSettingsKey pattern) so they survive restarts; grouping.ts reads
 * `groupToolCalls` (same key the old extension used) from the same file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setExtraDetail } from "./tools/builtins.js";
import { bustGroupingSettingsCache, repaintGroupedRows } from "./tools/grouping.js";
import { runSpinnerCommand } from "./spinner-config.js";

const SETTINGS_KEY_GROUP = "groupToolCalls";
const SETTINGS_KEY_EXTRA_DETAIL = "ccToolsExtraDetail";
const SETTINGS_KEY_CC_THEME = "ccTheme";

// Old-ext settings cache (index.ts:121-143): merged cwd + home settings, 5s TTL.
let settingsCache: { value: Record<string, unknown>; timestamp: number } | null = null;
const SETTINGS_CACHE_TTL_MS = 5_000;

function readSettings(): Record<string, unknown> {
	const now = Date.now();
	if (settingsCache && now - settingsCache.timestamp < SETTINGS_CACHE_TTL_MS) {
		return settingsCache.value;
	}
	const merged: Record<string, unknown> = {};
	for (const path of [join(process.cwd(), ".pi", "settings.json"), join(homedir(), ".pi", "settings.json")]) {
		try {
			if (!path || !existsSync(path)) continue;
			const raw = JSON.parse(readFileSync(path, "utf8"));
			if (raw && typeof raw === "object") Object.assign(merged, raw);
		} catch {
			// ignore invalid settings files
		}
	}
	settingsCache = { value: merged, timestamp: now };
	return merged;
}

/** Write one key to ~/.pi/settings.json (old ext index.ts:155-174). Uses
 *  homedir() — the same source readSettings uses, so the toggle survives
 *  even when HOME is unset. */
function writeSettingsKey(key: string, value: unknown): void {
	settingsCache = null; // invalidate cache on write
	const dir = join(homedir(), ".pi");
	const path = join(dir, "settings.json");
	let settings: Record<string, unknown> = {};
	try {
		if (existsSync(path)) settings = JSON.parse(readFileSync(path, "utf8")) ?? {};
	} catch {
		/* start fresh */
	}
	if (value === undefined) {
		delete settings[key];
	} else {
		settings[key] = value;
	}
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
	} catch {
		/* best effort */
	}
}

// Initial state from settings: grouping defaults on, extra detail defaults off.
let groupingEnabled = readSettings()[SETTINGS_KEY_GROUP] !== false;
let extraDetail = readSettings()[SETTINGS_KEY_EXTRA_DETAIL] === true;

export function isGroupingEnabled(): boolean {
	return groupingEnabled;
}

export function isExtraDetail(): boolean {
	return extraDetail;
}

export function registerCommands(pi: ExtensionAPI): void {
	// AUDIT §4 / §5:71 (P2 ×11): extraDetail is persisted (ccToolsExtraDetail), but
	// the module-level extraDetail in builtins.ts defaults to false and is only
	// modified by setExtraDetail(). Nothing restores the persisted value to builtins
	// at startup → status bar reads commands.ts extraDetail as "on", but actual
	// preview still uses 8 lines (off), and the first Ctrl+Shift+O does
	// setDetail(!extraDetail) = setDetail(false), bringing both sides to off,
	// making it look like "first keyboard shortcut press does nothing / turns off".
	// Sync once here: keep builtins' switch in sync with persisted/display state.
	setExtraDetail(extraDetail);

	// Restore the CC theme if pi fell back to its built-in default at startup.
	// This happens when the CC theme package isn't registered yet when pi
	// applies the saved theme (package resolution timing in createStartupTui).
	// pi's initTheme catches the load failure and silently falls back to
	// "dark"; without this restore, the user's /cc-theme choice is lost for
	// the rest of the session.
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		const saved = readSettings()[SETTINGS_KEY_CC_THEME];
		if (typeof saved !== "string" || !saved.startsWith("claude-code-")) return;
		const current = ctx.ui.theme?.name;
		// Only re-apply when the theme fell back to pi's built-in default.
		// If the user intentionally switched to dark/light via /settings,
		// this overrides that choice — but a CC-extension user who picked a
		// CC theme via /cc-theme expects it to stick across projects.
		if (current === "dark" || current === "light") {
			ctx.ui.setTheme(saved);
		}
	});

	const setDetail = (v: boolean) => {
		extraDetail = v;
		setExtraDetail(v);
		writeSettingsKey(SETTINGS_KEY_EXTRA_DETAIL, v);
	};

	const setGrouping = (v: boolean) => {
		groupingEnabled = v;
		writeSettingsKey(SETTINGS_KEY_GROUP, v);
		// grouping.ts caches the setting for 2s; bust it so the toggle is instant.
		bustGroupingSettingsCache();
		// AUDIT §5:372 / commands.ts:88 — the toggle used to change only future
		// renders: hidden member rows stayed blank and leaders kept stale
		// summaries. Push every grouped row (current turn + archived turns) to
		// re-render under the new setting.
		repaintGroupedRows();
	};

	// /cc-tools — control tool UI: grouping, extra detail.
	pi.registerCommand("cc-tools", {
		description: "Control CC tool UI: grouping, extra detail",
		async handler(args, ctx) {
			const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			const sub = parts[0] ?? "status";

			if (sub === "status") {
				if (ctx.hasUI) {
					ctx.ui.notify(
						[
							`Tool grouping: ${groupingEnabled ? "on" : "off"}`,
							`Extra detail: ${extraDetail ? "on" : "off"} (/cc-tools detail on|off|toggle)`,
							"  /cc-tools group on|off|toggle",
							"  /cc-tools detail on|off|toggle",
						].join("\n"),
						"info",
					);
				}
				return;
			}

			if (sub === "group") {
				const v = parts[1];
				if (v === "on" || v === "off") {
					setGrouping(v === "on");
					if (ctx.hasUI) ctx.ui.notify(`Tool grouping: ${v}`, "info");
				} else {
					setGrouping(!groupingEnabled);
					if (ctx.hasUI) ctx.ui.notify(`Tool grouping: ${groupingEnabled ? "on" : "off"}`, "info");
				}
				return;
			}

			if (sub === "detail" || sub === "extra") {
				const v = parts[1];
				if (v === "on" || v === "off") {
					setDetail(v === "on");
					if (ctx.hasUI) ctx.ui.notify(`Extra detail: ${v}`, "info");
				} else {
					setDetail(!extraDetail);
					if (ctx.hasUI) ctx.ui.notify(`Extra detail: ${extraDetail ? "on" : "off"}`, "info");
				}
				return;
			}

			if (ctx.hasUI) {
				ctx.ui.notify(`Unknown option "${sub}". Try /cc-tools status.`, "error");
			}
		},
	});

	// /cc-theme — pick one of the shipped CC themes (pi persists the choice via
	// its setTheme path, settings.json `theme`). pi 0.84 has no built-in /theme
	// command — theme switching lives in /settings — so this panel is the fast
	// path for the six CC variants.
	pi.registerCommand("cc-theme", {
		description: "Pick a Claude Code theme",
		async handler(_args, ctx) {
			if (!ctx.hasUI) return;
			const themes = [
				"claude-code-dark",
				"claude-code-light",
				"claude-code-dark-ansi",
				"claude-code-light-ansi",
				"claude-code-dark-daltonized",
				"claude-code-light-daltonized",
			];
			const current = ctx.ui.theme?.name;
			const choice = await ctx.ui.select(
				current ? `Claude Code theme (current: ${current})` : "Claude Code theme",
				themes,
			);
			if (!choice) return;
			const result = ctx.ui.setTheme(choice) as { success?: boolean; error?: string } | boolean | undefined;
			const failed = result === false || (typeof result === "object" && result !== null && result.success === false);
			if (failed) {
				const err = typeof result === "object" && result !== null ? result.error : undefined;
				ctx.ui.notify(`Theme switch failed: ${err ?? choice}`, "error");
				return;
			}
			ctx.ui.notify(`Theme: ${choice}`, "info");
			// Belt-and-suspenders: persist the choice to the extension's own settings
			// file too. pi's setTheme already writes ~/.pi/agent/settings.json, but
			// if the CC theme package isn't registered yet at startup (package
			// resolution timing), pi silently falls back to "dark" and never
			// recovers. The session_start handler below restores it.
			writeSettingsKey(SETTINGS_KEY_CC_THEME, choice);
		},
	});

  pi.registerCommand("cc-spinner", {
    description: "Show or change the spinner style (/cc-spinner status for options)",
    async handler(args, ctx) {
      const { message, error } = runSpinnerCommand(args);
      if (ctx.hasUI) ctx.ui.notify(message, error ? "error" : "info");
    },
  });

	// CC has no keyboard shortcut for verbose — in claude-code-main verbose can only
	// be toggled in the /config panel (ctrl+shift+o is app:toggleTeammatePreview,
	// unrelated to verbose).
	// We once bound extra detail to ctrl+shift+o and alt+o: single-modifier chords
	// in the terminal are very easy to accidentally trigger (macOS Option is ESC
	// prefix), and since the switch is persistent with no status bar indicator,
	// an accidental press silently floods thousands of lines (2026-09-22 flood incident).
	// Aligned with CC: keep only /cc-tools command toggle; persist the setting
	// (CC also persists verbose to global config), but show an indicator in the
	// status bar when enabled (detail section in status-line.ts).
}
