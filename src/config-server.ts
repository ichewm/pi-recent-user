/**
 * Local web UI for pi-recent-user config.
 *
 * Same pattern as pi-web-access's curator server: a short-lived node:http
 * server on 127.0.0.1 (random port) guarded by a session token in the URL.
 * The browser page edits count / maxLine / show, POSTs back, and the
 * extension persists + refreshes the widget immediately.
 */
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { clampCount, clampMaxLine, type RecentConfig } from "./config.ts";

const MAX_BODY_SIZE = 16 * 1024;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/** Strip SGR escape sequences — widget (TUI) consumes them, but a browser page would show them as garbage. */
const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

export interface ConfigServerOptions {
	/** Shared mutable config object (same reference the extension uses). */
	config: RecentConfig;
	/** Recent user prompts (single-line, untruncated, newest last). Max 10. */
	getSamples: () => string[];
	/** Called after a successful save; persist + refresh the widget. Return false to fail the request. */
	onSave: (config: RecentConfig) => boolean | void;
	/** Called when the server closes (idle timeout or explicit close). */
	onClose?: () => void;
}

export interface ConfigServerHandle {
	url: string;
	close(): void;
}

/**
 * Collapse all whitespace (newlines/tabs/nbsp/…) to single spaces, then strip ALL
 * remaining control characters (C0/C1/DEL/ESC) — they can ring the bell, leak ANSI
 * colors, or force a line break (NEL) and break the widget layout. Idempotent.
 */
export function toSingleLine(text: string): string {
	return text
		.replace(/\s+/g, " ")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
		.trim();
}

/** Single source of truth for widget rendering — page preview uses the exact same output. */
export function buildWidgetLines(config: RecentConfig, msgs: string[]): string[] {
	if (!config.show || msgs.length === 0) return [];
	const maxLine = Math.max(10, config.maxLine);
	// Title must not exceed maxLine either (matters for tiny maxLine).
	const lines = [truncateToWidth("📝 Recently you asked:", maxLine, "…")];
	msgs.forEach((m, idx) => {
		const prefix = idx === msgs.length - 1 ? "▶ " : "· ";
		// "▶ " / "· " render as 2 terminal columns — budget for them so the whole line stays ≤ maxLine.
		lines.push(prefix + truncateToWidth(toSingleLine(m), maxLine - 2, "…"));
	});
	return lines;
}

function previewLines(opts: ConfigServerOptions, count: number, maxLine: number): string[] {
	return buildWidgetLines(
		{ count, maxLine, show: true },
		opts.getSamples().slice(0, clampCount(count)),
	);
}

export function startConfigServer(opts: ConfigServerOptions): Promise<ConfigServerHandle> {
	const token = randomUUID();

	const server = http.createServer((req, res) => {
		touchIdle();
		handle(req, res).catch((err) => {
			try {
				sendJson(res, 500, { ok: false, error: String(err?.message ?? err) });
			} catch {
				// response already sent — nothing to do
			}
		});
	});

	let closed = false;
	let port = 0;
	let idleTimer: NodeJS.Timeout | null = null;
	const clearIdle = () => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = null;
	};
	const touchIdle = () => {
		clearIdle();
		idleTimer = setTimeout(() => close("idle"), IDLE_TIMEOUT_MS);
	};
	function close(_reason: string): void {
		if (closed) return;
		closed = true;
		clearIdle();
		try {
			server.close();
		} catch {
			// ignore
		}
		opts.onClose?.();
	}

	function sendJson(res: ServerResponse, status: number, payload: unknown): void {
		res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
		res.end(JSON.stringify(payload));
	}

	function tokenOk(req: IncomingMessage): boolean {
		let fromQuery: string | null = null;
		try {
			fromQuery = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("t");
		} catch {
			fromQuery = null;
		}
		const fromHeader = req.headers["x-config-token"];
		const provided = fromQuery ?? (Array.isArray(fromHeader) ? fromHeader[0] : fromHeader);
		return provided === token;
	}

	async function readBody(req: IncomingMessage): Promise<unknown> {
		return new Promise((resolve, reject) => {
			let size = 0;
			const chunks: Buffer[] = [];
			req.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > MAX_BODY_SIZE) {
					reject(new Error("body too large"));
					req.destroy();
					return;
				}
				chunks.push(chunk);
			});
			req.on("end", () => {
				try {
					resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}"));
				} catch {
					reject(new Error("invalid JSON body"));
				}
			});
			req.on("error", reject);
		});
	}

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const u = new URL(req.url ?? "/", "http://127.0.0.1");
		// DNS-rebinding guard: only accept requests addressed to this exact local endpoint.
		const host = (req.headers.host ?? "").toLowerCase();
		if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
			sendJson(res, 403, { ok: false, error: "Invalid host" });
			return;
		}
		if (!tokenOk(req)) {
			res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("Invalid session");
			return;
		}
		if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) {
			res.writeHead(200, {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "no-store",
				"Content-Security-Policy":
					"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
			});
			res.end(renderPage(token));
			return;
		}
		if (u.pathname === "/api/state" && req.method === "GET") {
			sendJson(res, 200, {
				ok: true,
				config: { ...opts.config },
				available: opts.getSamples().length,
				lines: buildWidgetLines(opts.config, opts.getSamples().slice(0, opts.config.count)).map(stripAnsi),
			});
			return;
		}
		if (u.pathname === "/api/preview" && req.method === "POST") {
			const body = (await readBody(req)) as { count?: unknown; maxLine?: unknown };
			const count = typeof body.count === "number" ? clampCount(body.count) : opts.config.count;
			const maxLine =
				typeof body.maxLine === "number" ? clampMaxLine(body.maxLine) : opts.config.maxLine;
			sendJson(res, 200, {
				ok: true,
				available: opts.getSamples().length,
				lines: previewLines(opts, count, maxLine).map(stripAnsi),
			});
			return;
		}
		if (u.pathname === "/api/config" && req.method === "POST") {
			const body = (await readBody(req)) as {
				count?: unknown;
				maxLine?: unknown;
				show?: unknown;
			};
			if (body.count !== undefined && typeof body.count !== "number") {
				sendJson(res, 400, { ok: false, error: "count must be a number" });
				return;
			}
			if (body.maxLine !== undefined && typeof body.maxLine !== "number") {
				sendJson(res, 400, { ok: false, error: "maxLine must be a number" });
				return;
			}
			if (body.show !== undefined && typeof body.show !== "boolean") {
				sendJson(res, 400, { ok: false, error: "show must be a boolean" });
				return;
			}
			if (typeof body.count === "number") opts.config.count = clampCount(body.count);
			if (typeof body.maxLine === "number") opts.config.maxLine = clampMaxLine(body.maxLine);
			if (typeof body.show === "boolean") opts.config.show = body.show;
			const persisted = opts.onSave(opts.config);
			if (persisted === false) {
				sendJson(res, 500, { ok: false, error: "failed to persist config" });
				return;
			}
			sendJson(res, 200, {
				ok: true,
				config: { ...opts.config },
				available: opts.getSamples().length,
				lines: buildWidgetLines(opts.config, opts.getSamples().slice(0, opts.config.count)).map(stripAnsi),
			});
			return;
		}
		sendJson(res, 404, { ok: false, error: "not found" });
	}

	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			touchIdle();
			const addr = server.address();
			if (addr === null || typeof addr === "string") {
				close("no-address");
				reject(new Error("failed to bind config server"));
				return;
			}
			port = addr.port;
			resolve({
				url: `http://127.0.0.1:${addr.port}/?t=${token}`,
				close: () => close("explicit"),
			});
		});
	});
}

function renderPage(token: string): string {
	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pi-recent-user 配置</title>
<style>
	:root { color-scheme: dark; }
	* { box-sizing: border-box; margin: 0; padding: 0; }
	body {
		font-family: -apple-system, "PingFang SC", "Segoe UI", "Microsoft YaHei", sans-serif;
		background: #0f1117; color: #e2e4ea;
		min-height: 100vh; display: flex; justify-content: center;
		padding: 40px 16px;
	}
	.card { width: 100%; max-width: 640px; }
	h1 { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
	.sub { color: #8b90a0; font-size: 13px; margin-bottom: 28px; }
	.section {
		background: #1a1d27; border: 1px solid #262a38; border-radius: 12px;
		padding: 18px 20px; margin-bottom: 16px;
	}
	.row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
	label.main { font-size: 15px; font-weight: 500; }
	.hint { color: #8b90a0; font-size: 12px; margin-top: 4px; }
	.val { color: #7aa2f7; font-variant-numeric: tabular-nums; font-weight: 600; }
	input[type="range"] {
		flex: 1; accent-color: #7aa2f7; height: 4px; cursor: pointer;
	}
	.switch { position: relative; width: 44px; height: 24px; flex-shrink: 0; }
	.switch input { opacity: 0; width: 0; height: 0; }
	.slider {
		position: absolute; inset: 0; background: #333848; border-radius: 999px;
		transition: background .15s; cursor: pointer;
	}
	.slider::before {
		content: ""; position: absolute; width: 18px; height: 18px; left: 3px; top: 3px;
		background: #e2e4ea; border-radius: 50%; transition: transform .15s;
	}
	.switch input:checked + .slider { background: #7aa2f7; }
	.switch input:checked + .slider::before { transform: translateX(20px); }
	.preview {
		background: #0c0e13; border: 1px solid #262a38; border-radius: 8px;
		padding: 14px 16px; margin-top: 12px;
		font-family: "SF Mono", Menlo, Consolas, monospace;
		font-size: 13px; line-height: 1.7; white-space: pre-wrap; word-break: break-all;
		color: #c8cdda; min-height: 76px;
	}
	.preview .empty { color: #5a5f70; font-family: inherit; }
	.preview-title { margin-bottom: 12px; font-size: 13px; color: #8b90a0; }
	button {
		width: 100%; padding: 12px; border: none; border-radius: 10px;
		background: #7aa2f7; color: #0f1117; font-size: 15px; font-weight: 600;
		cursor: pointer; transition: background .15s;
	}
	button:hover { background: #8db1f9; }
	button:disabled { opacity: .6; cursor: default; }
	.status { text-align: center; font-size: 13px; margin-top: 12px; min-height: 18px; color: #8b90a0; }
	.status.ok { color: #9ece6a; }
	.status.err { color: #f7768e; }
</style>
</head>
<body>
<div class="card">
	<h1>📝 pi-recent-user 配置</h1>
	<div class="sub">保存后立即生效并写入 <code>~/.pi/agent/pi-recent-user.json</code>，重启 pi 依然保留</div>

	<div class="section">
		<div class="row">
			<div>
				<label class="main" for="show">显示 widget</label>
				<div class="hint">关闭后编辑器上方的"最近提问"小组件将被隐藏</div>
			</div>
			<label class="switch">
				<input type="checkbox" id="show" checked>
				<span class="slider"></span>
			</label>
		</div>
	</div>

	<div class="section">
		<div class="row" style="margin-bottom: 14px">
			<label class="main" for="count">显示条数</label>
			<span class="val"><span id="countVal">3</span> 条</span>
		</div>
		<div class="row"><input type="range" id="count" min="1" max="10" step="1" value="3"></div>
	</div>

	<div class="section">
		<div class="row" style="margin-bottom: 14px">
			<label class="main" for="maxLine">每行宽度上限</label>
			<span class="val"><span id="maxLineVal">70</span> 列</span>
		</div>
		<div class="row"><input type="range" id="maxLine" min="10" max="200" step="5" value="70"></div>
		<div class="hint" style="margin-top: 10px">超出部分以 … 截断；宽度按终端列计算（中文占 2 列），建议不超过终端窗口宽度</div>
	</div>

	<div class="section">
		<div class="preview-title">实时预览（取自当前会话最近的提问）<span id="previewMeta" style="color:#7aa2f7"></span></div>
		<div class="preview" id="preview"><span class="empty">加载中…</span></div>
	</div>

	<button id="save">保存</button>
	<div class="status" id="status"></div>
</div>
<script>
(function () {
	"use strict";
	var TOKEN = new URLSearchParams(location.search).get("t") || "";
	var $ = function (id) { return document.getElementById(id); };
	var els = { show: $("show"), count: $("count"), maxLine: $("maxLine"),
		countVal: $("countVal"), maxLineVal: $("maxLineVal"),
		preview: $("preview"), save: $("save"), status: $("status") };

	function api(path, body) {
		var init = { method: body ? "POST" : "GET", headers: { "x-config-token": TOKEN } };
		if (body) {
			init.headers["Content-Type"] = "application/json";
			init.body = JSON.stringify(body);
		}
		return fetch(path + "?t=" + encodeURIComponent(TOKEN), init).then(function (r) { return r.json(); });
	}

	function metaText(available, count) {
		if (!available) return " · 暂无提问记录";
		if (count >= available) return " · " + available + " 条可用，已全部显示";
		return " · " + available + " 条可用，显示前 " + count + " 条";
	}

	function renderPreview(lines, show, available, count) {
		document.getElementById("previewMeta").textContent = metaText(available || 0, count || 0);
		if (!show) {
			els.preview.innerHTML = '<span class="empty">widget 已隐藏（开启"显示 widget"后可见预览）</span>';
			return;
		}
		if (!lines || !lines.length) {
			els.preview.innerHTML = '<span class="empty">（当前会话还没有提问记录——在 pi 里发一条消息后再来预览）</span>';
			return;
		}
		els.preview.textContent = lines.join("\\n");
	}

	function setStatus(text, cls) {
		els.status.textContent = text;
		els.status.className = "status" + (cls ? " " + cls : "");
	}

	var debounceTimer = null;
	function onControlInput() {
		els.countVal.textContent = els.count.value;
		els.maxLineVal.textContent = els.maxLine.value;
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(function () {
			api("/api/preview", {
				count: parseInt(els.count.value, 10),
				maxLine: parseInt(els.maxLine.value, 10)
			}).then(function (data) {
				if (data.ok) renderPreview(data.lines, true, data.available, parseInt(els.count.value, 10));
			}).catch(function () {});
		}, 200);
	}

	function load() {
		return api("/api/state").then(function (data) {
			if (!data.ok) throw new Error("state load failed");
			els.show.checked = data.config.show;
			els.count.value = data.config.count;
			els.maxLine.value = data.config.maxLine;
			els.countVal.textContent = data.config.count;
			els.maxLineVal.textContent = data.config.maxLine;
			renderPreview(data.lines, data.config.show, data.available, data.config.count);
		});
	}

	els.show.addEventListener("change", function () {
		api("/api/preview", {
			count: parseInt(els.count.value, 10),
			maxLine: parseInt(els.maxLine.value, 10)
		}).then(function (data) {
			if (data.ok) renderPreview(data.lines, els.show.checked, data.available, parseInt(els.count.value, 10));
		}).catch(function () {});
	});
	els.count.addEventListener("input", onControlInput);
	els.maxLine.addEventListener("input", onControlInput);

	els.save.addEventListener("click", function () {
		els.save.disabled = true;
		setStatus("保存中…", "");
		api("/api/config", {
			count: parseInt(els.count.value, 10),
			maxLine: parseInt(els.maxLine.value, 10),
			show: els.show.checked
		}).then(function (data) {
			if (!data.ok) throw new Error(data.error || "save failed");
			els.countVal.textContent = data.config.count;
			els.maxLineVal.textContent = data.config.maxLine;
			renderPreview(data.lines, data.config.show, data.available, data.config.count);
			setStatus("已保存 ✓ widget 已同步刷新", "ok");
		}).catch(function (err) {
			setStatus("保存失败：" + (err && err.message ? err.message : err), "err");
		}).then(function () {
			els.save.disabled = false;
		});
	});

	load().catch(function (err) {
		setStatus("加载失败：" + (err && err.message ? err.message : err), "err");
	});
})();
</script>
</body>
</html>`;
}
