/**
 * Config for pi-recent-user — persisted in ~/.pi/agent/pi-recent-user.json
 * (not in pi's settings.json). Changes are atomically written and survive restart.
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const CONFIG_PATH = process.env.PI_RECENT_USER_CONFIG
	? join(process.env.PI_RECENT_USER_CONFIG)
	: join(getAgentDir(), "pi-recent-user.json");

export interface RecentConfig {
	/** How many recent user prompts to show (1–10). */
	count: number;
	/** Max display width per line, in terminal columns (counting CJK as 2). */
	maxLine: number;
	/** Whether the widget is shown. */
	show: boolean;
}

export const DEFAULTS: RecentConfig = { count: 3, maxLine: 70, show: true };

export const clampCount = (n: number): number => Math.max(1, Math.min(10, Math.floor(n)));
export const clampMaxLine = (n: number): number => Math.max(10, Math.min(200, Math.floor(n)));

export function loadConfig(): RecentConfig {
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

/** Atomic write: write to .tmp then rename. Returns false when the write failed. */
export function saveConfig(config: RecentConfig): boolean {
	const tmp = `${CONFIG_PATH}.tmp`;
	try {
		writeFileSync(tmp, JSON.stringify(config, null, 2), "utf-8");
		renameSync(tmp, CONFIG_PATH);
		return true;
	} catch {
		try {
			unlinkSync(tmp);
		} catch {
			// ignore cleanup failure
		}
		return false;
	}
}
