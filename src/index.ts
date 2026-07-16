/**
 * pi-recent-user — 常驻 widget 显示"最近你在问什么"
 *
 * 配置持久化在插件自己的 ~/.pi/agent/pi-recent-user.json（不进 pi settings）。
 * /recent 调整原子写回该文件，重启保留。pi remove 后文件残留但无害。
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

const WIDGET_KEY = "pi-recent-user";
const CONFIG_PATH = join(getAgentDir(), "pi-recent-user.json");

interface RecentConfig {
	/** 显示最近几条 user 输入（1~10） */
	count: number;
	/** 每条最多显示宽度（终端列数，中英文按实际宽度算） */
	maxLine: number;
	/** 是否显示 */
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

/** 原子写：先写 .tmp 再 rename，避免多会话并发覆盖中途丢失。 */
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
		const lines = ["📝 最近你在问："];
		msgs.forEach((m, idx) => {
			const prefix = idx === msgs.length - 1 ? "▶" : "·";
			lines.push(`${prefix} ${truncateToWidth(m, config.maxLine, "…")}`);
		});
		ctx.ui.setWidget(WIDGET_KEY, lines);
	} catch {
		// 任何异常（如 getBranch 失败）静默清 widget，绝不让 widget 错误影响主流程
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
		description: "最近提问 widget：/recent on|off|<条数>，或无参查看状态（调整会持久化）",
		handler: async (args, ctx) => {
			const a = (args ?? "").trim().toLowerCase();
			let changed = false;
			if (a === "off" || a === "hide") {
				config.show = false;
				changed = true;
				ctx.ui.setWidget(WIDGET_KEY, undefined);
				if (ctx.hasUI) ctx.ui.notify("已隐藏最近提问 widget", "info");
			} else if (a === "on" || a === "show") {
				config.show = true;
				changed = true;
				updateWidget(ctx, config);
				if (ctx.hasUI) ctx.ui.notify("已显示最近提问 widget", "info");
			} else if (/^\d+$/.test(a)) {
				config.count = clampCount(parseInt(a, 10));
				changed = true;
				updateWidget(ctx, config);
				if (ctx.hasUI) ctx.ui.notify(`显示最近 ${config.count} 条`, "info");
			} else {
				if (ctx.hasUI) ctx.ui.notify(`最近提问：${config.show ? "显示" : "隐藏"}，共 ${config.count} 条`, "info");
			}
			if (changed) saveConfig(config);
		},
	});
}
