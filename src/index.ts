/**
 * pi-recent-user — persistent widget showing your recent prompts.
 *
 * Config UI is a local web page (config-server.ts): `/recent` opens it in
 * your browser, edits apply instantly and persist to
 * ~/.pi/agent/pi-recent-user.json. Quick toggles (`/recent off|on|<n>`)
 * are still available without opening the page.
 */
import { spawn } from "node:child_process";
import { platform } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	buildWidgetLines,
	startConfigServer,
	toSingleLine,
	type ConfigServerHandle,
} from "./config-server.ts";
import {
	clampCount,
	CONFIG_PATH,
	loadConfig,
	saveConfig,
	type RecentConfig,
} from "./config.ts";

const WIDGET_KEY = "pi-recent-user";

/** Most recent ExtensionContext — kept fresh on every event, used to refresh the widget on web-page saves. */
let currentCtx: ExtensionContext | null = null;
let serverHandle: ConfigServerHandle | null = null;

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
			const text = toSingleLine(extractUserText(e.message.content));
			if (text) users.push(text);
		}
	}
	return users.reverse();
}

/** Up to 10 recent prompts for the web page preview (count's upper bound). */
function getSamples(): string[] {
	if (!currentCtx) return [];
	return getRecentUserMessages(currentCtx, 10);
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
		const lines = buildWidgetLines(config, msgs);
		ctx.ui.setWidget(WIDGET_KEY, lines.length > 0 ? lines : undefined);
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

/** Open a URL in the system browser (macOS / Windows / Linux), same pattern as pi-web-access. */
async function openInBrowser(pi: ExtensionAPI, url: string): Promise<void> {
	const plat = platform();
	if (plat === "darwin") {
		const result = await pi.exec("open", [url]);
		if (result.code !== 0) throw new Error(result.stderr || `open exited with ${result.code}`);
		return;
	}
	if (plat === "win32") {
		const result = await pi.exec("cmd", ["/c", "start", "", url]);
		if (result.code !== 0) throw new Error(result.stderr || `start exited with ${result.code}`);
		return;
	}
	await new Promise<void>((resolve, reject) => {
		const child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
		const timer = setTimeout(resolve, 100);
		child.once("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve();
			else reject(new Error(`xdg-open exited with code ${code ?? "unknown"}`));
		});
		child.unref();
	});
}

/** Ensure the config server is running; restart it if it idle-timed-out. */
async function ensureConfigServer(config: RecentConfig): Promise<ConfigServerHandle> {
	if (serverHandle) return serverHandle;
	serverHandle = await startConfigServer({
		config,
		getSamples,
		onSave: (c) => {
			const persisted = saveConfig(c);
			if (currentCtx) {
				updateWidget(currentCtx, c);
				if (currentCtx.hasUI)
					currentCtx.ui.notify(
						persisted
							? `recent config saved (count=${c.count}, maxLine=${c.maxLine}). Hot-applied.`
							: "recent config save FAILED (disk write error) — change applies to this session only",
						"info",
					);
			}
			return persisted;
		},
		onClose: () => {
			serverHandle = null;
		},
	});
	return serverHandle;
}

/** Close the config page server (if running) without waiting for idle timeout. */
function handleClose(): void {
	if (serverHandle) serverHandle.close();
}

export default function recentWidget(pi: ExtensionAPI): void {
	const config = loadConfig();

	pi.on("session_start", async (_e, ctx) => {
		currentCtx = ctx;
		updateWidget(ctx, config);
	});
	pi.on("turn_end", async (_e, ctx) => {
		currentCtx = ctx;
		updateWidget(ctx, config);
	});
	pi.on("session_shutdown", async () => {
		// release the config-page port early; a leftover server would otherwise
		// idle for up to 10 min after /reload or session close
		handleClose();
	});

	pi.registerCommand("recent", {
		description: "recent-prompts widget (status|config|on|off|<count>)",
		handler: async (args, ctx) => {
			currentCtx = ctx;
			const [sub = "status", ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);

			switch (sub) {
				case "status": {
				const lines = [
					`widget: ${config.show ? "shown" : "hidden"} · ${config.count} prompts · maxLine ${config.maxLine}`,
					`config: ${CONFIG_PATH}`,
					`config page: ${serverHandle ? serverHandle.url : "/recent config to open"}`,
					`usage: /recent config|on|off|<1-10>`,
				];
				ctx.ui.notify(lines.join("\n"), "info");
				break;
				}

				case "web":
				case "page":
				case "config": {
				if (rest[0] === "stop") {
					if (serverHandle) {
						handleClose();
					ctx.ui.notify("config page closed", "info");
					} else {
						ctx.ui.notify("config page not running", "info");					}
					break;
				}
				try {
					const handle = await ensureConfigServer(config);
					try {
						await openInBrowser(pi, handle.url);
					} catch (err) {
						// browser failed to open — surface the URL so the user can open it manually
						const msg = err instanceof Error ? err.message : String(err);
						ctx.ui.notify(`config page (open manually):\n${handle.url}\n(${msg})`, "warning");
						break;
					}
					ctx.ui.notify(`config page:\n${handle.url}\n(auto-closes after 10 min idle; /recent config stop)`, "info");
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					ctx.ui.notify(`Failed to start config page: ${msg}`, "error");
				}
				break;
				}

				case "off":
				case "hide":
					config.show = false;
					ctx.ui.setWidget(WIDGET_KEY, undefined);
					if (ctx.hasUI) ctx.ui.notify("Recent widget hidden", "info");
					saveConfig(config);
					break;

				case "on":
				case "show":
					config.show = true;
					updateWidget(ctx, config);
					if (ctx.hasUI) ctx.ui.notify("Recent widget shown", "info");
					saveConfig(config);
					break;

				default: {
					if (/^\d+$/.test(sub)) {
						config.count = clampCount(parseInt(sub, 10));
					updateWidget(ctx, config);
					if (ctx.hasUI) ctx.ui.notify(`Showing last ${config.count} prompts`, "info");
						saveConfig(config);
				} else {
					ctx.ui.notify(`Unknown subcommand "${sub}". Usage: /recent status|config|on|off|<1-10>`, "warning");
				}
				}
			}
		},
	});
}
