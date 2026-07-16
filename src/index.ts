/**
 * pi-recent-user — persistent widget showing your recent prompts.
 *
 * Config is persisted in the extension's own ~/.pi/agent/pi-recent-user.json
 * (not in pi's settings.json). /recent changes are atomically written and
 * survive restart. After `pi remove` the file remains but is harmless.
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

const WIDGET_KEY = "pi-recent-user";
const CONFIG_PATH = join(getAgentDir(), "pi-recent-user.json");

interface RecentConfig {
	/** How many recent user prompts to show (1–10). */
	count: number;
	/** Max display width per line, in terminal columns (counting CJK as 2). */
	maxLine: number;
	/** Whether the widget is shown. */
	show: boolean;
}

const DEFAULTS: RecentConfig = { count: 3, maxLine: 70, show: true };

const clampCount = (n: number): number => Math.max(1, Math.min(10, Math.floor(n)));
const clampMaxLine = (n: number): number => Math.max(10, Math.min(200, Math.floor(n)));

function loadConfig(): RecentConfig {
	if (!existsSync(CONFIG_PATH)) return { ...DEFAULTS };
	try {
		const data = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		return {
			count: typeof data.count === "number" ? clampCount(data.count) : DEFAULTS.count,
			maxLine: typeof data.maxLine === "number" ? clampMaxLine(data.maxLine) : DEFAULTS.maxLine,
			show: typeof data.show === "boolean" ? data.show : DEFAULTS.show,
		};
	} catch {
		return { ...DEFAULTS };
	}
}

/** Atomic write: write to .tmp then rename, to avoid losing data on concurrent writes. */
function saveConfig(config: RecentConfig): void {
	const tmp = `${CONFIG_PATH}.tmp`;
	try {
		writeFileSync(tmp, JSON.stringify(config, null, 2), "utf-8");
		renameSync(tmp, CONFIG_PATH);
	} catch {
		try {
			unlinkSync(tmp);
		} catch {
			// ignore cleanup failure
		}
	}
}

interface TextBlock {
	type: "text";
	text: string;
}

function extractUserText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((b): b is TextBlock => b?.type === "text" && typeof b.text === "string")
			.map((b) => b.text)
			.join(" ");
	}
	return "";
}

interface BranchEntry {
	type?: string;
	message?: { role?: string; content?: unknown };
}

function getRecentUserMessages(ctx: ExtensionContext, count: number): string[] {
	const branch = ctx.sessionManager.getBranch();
	const users: string[] = [];
	for (let i = branch.length - 1; i >= 0 && users.length < count; i--) {
		const e = branch[i] as BranchEntry;
		if (e?.type === "message" && e.message?.role === "user") {
			const text = extractUserText(e.message.content).trim();
			if (text) users.push(text);
		}
	}
	return users.reverse();
}

function updateWidget(ctx: ExtensionContext, config: RecentConfig): void {
	if (!ctx.hasUI) return;
	if (!config.show) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}
	try {
		const msgs = getRecentUserMessages(ctx, config.count);
		if (msgs.length === 0) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const lines = ["📝 Recently you asked:"];
		msgs.forEach((m, idx) => {
			const prefix = idx === msgs.length - 1 ? "▶" : "·";
			lines.push(`${prefix} ${truncateToWidth(m, config.maxLine, "…")}`);
		});
		ctx.ui.setWidget(WIDGET_KEY, lines);
	} catch {
		// Any failure (e.g. getBranch throwing) silently clears the widget —
		// never let the widget break the main flow.
		try {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		} catch {
			// ignore
		}
	}
}

export default function recentWidget(pi: ExtensionAPI): void {
	const config = loadConfig();

	pi.on("session_start", async (_e, ctx) => updateWidget(ctx, config));
	pi.on("turn_end", async (_e, ctx) => updateWidget(ctx, config));

	pi.registerCommand("recent", {
		description: "Recent-prompts widget: /recent on|off|<count>, or no args to show status (changes persist)",
		handler: async (args, ctx) => {
			const a = (args ?? "").trim().toLowerCase();
			let changed = false;
			if (a === "off" || a === "hide") {
				config.show = false;
				changed = true;
				ctx.ui.setWidget(WIDGET_KEY, undefined);
				if (ctx.hasUI) ctx.ui.notify("Recent widget hidden", "info");
			} else if (a === "on" || a === "show") {
				config.show = true;
				changed = true;
				updateWidget(ctx, config);
				if (ctx.hasUI) ctx.ui.notify("Recent widget shown", "info");
			} else if (/^\d+$/.test(a)) {
				config.count = clampCount(parseInt(a, 10));
				changed = true;
				updateWidget(ctx, config);
				if (ctx.hasUI) ctx.ui.notify(`Showing last ${config.count} prompts`, "info");
			} else {
				if (ctx.hasUI) ctx.ui.notify(`Recent: ${config.show ? "shown" : "hidden"}, ${config.count} prompts`, "info");
			}
			if (changed) saveConfig(config);
		},
	});
}
