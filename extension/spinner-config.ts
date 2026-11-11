/**
 * Spinner style config: persisted under the `ccSpinner` key of
 * ~/.pi/settings.json (project .pi/settings.json is read too and overrides).
 *
 * Example:
 *   "ccSpinner": {
 *     "frames": ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"],
 *     "pingPong": false,
 *     "frameMs": 80,
 *     "glimmer": false,
 *     "verb": "Working",
 *     "accent": "#ff8c00",
 *     "shimmer": "#ffd28a",
 *     "showTimer": true,
 *     "showTokens": true
 *   }
 *
 * Every key is optional; a missing key means "use the CC default".
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Rgb = [number, number, number];

export interface SpinnerConfig {
	/** Glyph frames (each one terminal cell wide). */
	frames?: string[];
	/** Play frames forward then reverse (CC default true). */
	pingPong?: boolean;
	/** Milliseconds per glyph frame (CC default 120). */
	frameMs?: number;
	/** Shimmer sweep across the verb (default true). */
	glimmer?: boolean;
	/** Fixed verb; omit for CC's random rotation. */
	verb?: string;
	/** Custom verb pool for the random rotation. */
	verbs?: string[];
	/** Glyph + verb color, "#rrggbb". */
	accent?: string;
	/** Shimmer color, "#rrggbb". */
	shimmer?: string;
	showTimer?: boolean;
	showTokens?: boolean;
}

const SETTINGS_KEY = "ccSpinner";

export const PRESETS: Record<string, SpinnerConfig> = {
	classic: { frames: undefined, pingPong: undefined, frameMs: undefined, glimmer: undefined },
	braille: { frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], pingPong: false, frameMs: 80, glimmer: true },
	dots: { frames: ["⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈"], pingPong: false, frameMs: 100, glimmer: true },
	line: { frames: ["-", "\\", "|", "/"], pingPong: false, frameMs: 120, glimmer: true },
	arrows: { frames: ["←", "↖", "↑", "↗", "→", "↘", "↓", "↙"], pingPong: false, frameMs: 100, glimmer: true },
};

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

export function parseHex(s: string): Rgb | null {
	const m = /^#?([0-9a-f]{6})$/i.exec(s.trim());
	if (!m) return null;
	const n = Number.parseInt(m[1]!, 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Truecolor foreground painter for a "#rrggbb" string, or null if invalid. */
export function hexPainter(hex: string | undefined): ((s: string) => string) | null {
	if (!hex) return null;
	const rgb = parseHex(hex);
	if (!rgb) return null;
	const [r, g, b] = rgb;
	return (s) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

function userSettingsPath(): string {
	return join(homedir(), ".pi", "settings.json");
}

function readJson(path: string): Record<string, unknown> {
	try {
		if (!existsSync(path)) return {};
		const raw = JSON.parse(readFileSync(path, "utf8"));
		return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** Validate untrusted JSON into a SpinnerConfig; bad keys are dropped. */
export function sanitize(raw: unknown): SpinnerConfig {
	const out: SpinnerConfig = {};
	if (!raw || typeof raw !== "object") return out;
	const r = raw as Record<string, unknown>;
	const strings = (v: unknown): string[] =>
		Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];

	const frames = strings(r.frames);
	if (frames.length) out.frames = frames;
	const verbs = strings(r.verbs);
	if (verbs.length) out.verbs = verbs;
	if (typeof r.verb === "string" && r.verb.trim()) out.verb = r.verb.trim();
	if (typeof r.pingPong === "boolean") out.pingPong = r.pingPong;
	if (typeof r.glimmer === "boolean") out.glimmer = r.glimmer;
	if (typeof r.showTimer === "boolean") out.showTimer = r.showTimer;
	if (typeof r.showTokens === "boolean") out.showTokens = r.showTokens;
	if (typeof r.frameMs === "number" && Number.isFinite(r.frameMs) && r.frameMs >= 16 && r.frameMs <= 2000) {
		out.frameMs = Math.round(r.frameMs);
	}
	if (typeof r.accent === "string" && parseHex(r.accent)) out.accent = r.accent.trim();
	if (typeof r.shimmer === "string" && parseHex(r.shimmer)) out.shimmer = r.shimmer.trim();
	return out;
}

function loadFromDisk(): SpinnerConfig {
	// Home first, project second, so a project's .pi/settings.json wins.
	const home = sanitize(readJson(userSettingsPath())[SETTINGS_KEY]);
	const project = sanitize(readJson(join(process.cwd(), ".pi", "settings.json"))[SETTINGS_KEY]);
	return { ...home, ...project };
}

let current: SpinnerConfig = loadFromDisk();

/** Live config. Cheap: returns the in-memory object. */
export function getSpinnerConfig(): SpinnerConfig {
	return current;
}

/** Re-read settings.json (picks up hand edits). Call at agent_start. */
export function reloadSpinnerConfig(): SpinnerConfig {
	current = loadFromDisk();
	return current;
}

function persist(cfg: SpinnerConfig): void {
	const path = userSettingsPath();
	const settings = readJson(path);
	if (Object.keys(cfg).length === 0) delete settings[SETTINGS_KEY];
	else settings[SETTINGS_KEY] = cfg;
	try {
		mkdirSync(join(homedir(), ".pi"), { recursive: true });
		writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
	} catch {
		/* best effort */
	}
}

/**
 * Merge a patch into the config, apply it immediately and save it to
 * ~/.pi/settings.json. A key set to `undefined` is removed (back to default).
 */
export function updateSpinnerConfig(patch: Partial<Record<keyof SpinnerConfig, unknown>>): SpinnerConfig {
	const merged: Record<string, unknown> = { ...current };
	for (const [k, v] of Object.entries(patch)) {
		if (v === undefined) delete merged[k];
		else merged[k] = v;
	}
	current = sanitize(merged);
	persist(current);
	return current;
}

export function resetSpinnerConfig(): void {
	current = {};
	persist(current);
}

export function applyPreset(name: string): boolean {
	const preset = PRESETS[name];
	if (!preset) return false;
	updateSpinnerConfig(preset);
	return true;
}

// ---------------------------------------------------------------------------
// /cc-spinner command parsing
// ---------------------------------------------------------------------------

const onOff = (v: string | undefined, cur: boolean): boolean =>
	v === "on" ? true : v === "off" ? false : !cur;

export const SPINNER_HELP = [
	"/cc-spinner status",
	"/cc-spinner preset <classic|braille|dots|line|arrows|minimal>",
	"/cc-spinner frames <glyphs>      e.g. frames ⠋⠙⠹⠸ (or space-separated)",
	"/cc-spinner speed <16-2000>      ms per frame",
	"/cc-spinner verb <word|random>",
	"/cc-spinner color <#accent> [#shimmer] | color reset",
	"/cc-spinner glimmer|timer|tokens|pingpong on|off",
	"/cc-spinner reset",
].join("\n");

/** Runs one /cc-spinner invocation; returns the message to show. */
export function runSpinnerCommand(argString: string): { message: string; error?: boolean } {
	const parts = argString.trim().split(/\s+/).filter(Boolean);
	const sub = (parts[0] ?? "status").toLowerCase();
	const rest = parts.slice(1);
	const cfg = current;

	switch (sub) {
		case "status": {
			const lines = [
				`frames: ${(cfg.frames ?? ["default CC frames"]).join(" ")}`,
				`pingPong: ${cfg.pingPong !== false}   frameMs: ${cfg.frameMs ?? 120}   glimmer: ${cfg.glimmer !== false}`,
				`verb: ${cfg.verb ?? (cfg.verbs?.length ? `random of ${cfg.verbs.length} custom` : "random (CC list)")}`,
				`accent: ${cfg.accent ?? "CC orange"}   shimmer: ${cfg.shimmer ?? "CC shimmer"}`,
				`timer: ${cfg.showTimer !== false}   tokens: ${cfg.showTokens !== false}`,
				"",
				SPINNER_HELP,
			];
			return { message: lines.join("\n") };
		}
		case "preset": {
			const name = rest[0]?.toLowerCase() ?? "";
			return applyPreset(name)
				? { message: `Spinner preset: ${name}` }
				: { message: `Unknown preset. Options: ${Object.keys(PRESETS).join(", ")}`, error: true };
		}
		case "frames": {
			const text = rest.join(" ");
			const frames = rest.length > 1 ? rest : [...text];
			if (frames.length === 0) return { message: "Usage: /cc-spinner frames ⠋⠙⠹⠸", error: true };
			updateSpinnerConfig({ frames });
			return { message: `Frames: ${frames.join(" ")}` };
		}
		case "speed": {
			const ms = Number(rest[0]);
			if (!Number.isFinite(ms) || ms < 16 || ms > 2000) {
				return { message: "Usage: /cc-spinner speed <16-2000> (ms per frame)", error: true };
			}
			updateSpinnerConfig({ frameMs: Math.round(ms) });
			return { message: `Frame time: ${Math.round(ms)}ms` };
		}
		case "verb": {
			const word = rest.join(" ");
			if (!word) return { message: "Usage: /cc-spinner verb <word|random>", error: true };
			updateSpinnerConfig({ verb: word.toLowerCase() === "random" ? undefined : word });
			return { message: word.toLowerCase() === "random" ? "Verb: random" : `Verb: ${word} (from the next request)` };
		}
		case "color":
		case "colour": {
			if (rest[0]?.toLowerCase() === "reset") {
				updateSpinnerConfig({ accent: undefined, shimmer: undefined });
				return { message: "Spinner colors reset" };
			}
			if (!rest[0] || !parseHex(rest[0]) || (rest[1] && !parseHex(rest[1]))) {
				return { message: "Usage: /cc-spinner color #ff8c00 [#ffd28a] | color reset", error: true };
			}
			updateSpinnerConfig({ accent: rest[0], shimmer: rest[1] });
			return { message: `Colors: accent ${rest[0]}${rest[1] ? `, shimmer ${rest[1]}` : ""}` };
		}
		case "glimmer":
			updateSpinnerConfig({ glimmer: onOff(rest[0], cfg.glimmer !== false) });
			return { message: `Glimmer: ${current.glimmer !== false ? "on" : "off"}` };
		case "timer":
			updateSpinnerConfig({ showTimer: onOff(rest[0], cfg.showTimer !== false) });
			return { message: `Timer: ${current.showTimer !== false ? "on" : "off"}` };
		case "tokens":
			updateSpinnerConfig({ showTokens: onOff(rest[0], cfg.showTokens !== false) });
			return { message: `Tokens: ${current.showTokens !== false ? "on" : "off"}` };
		case "pingpong":
			updateSpinnerConfig({ pingPong: onOff(rest[0], cfg.pingPong !== false) });
			return { message: `Ping-pong: ${current.pingPong !== false ? "on" : "off"}` };
		case "reset":
			resetSpinnerConfig();
			return { message: "Spinner reset to CC defaults" };
		default:
			return { message: `Unknown option "${sub}".\n${SPINNER_HELP}`, error: true };
	}
}
