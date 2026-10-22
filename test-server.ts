/**
 * Integration test for config-server.ts — starts a real server and exercises
 * every endpoint via fetch. Run: node --experimental-strip-types test-server.ts
 */
import { startConfigServer, buildWidgetLines, toSingleLine, type ConfigServerHandle } from "./src/config-server.ts";
import type { RecentConfig } from "./src/config.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as http from "node:http";

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string): void {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		failed++;
		console.error(`  ✗ ${name}`);
	}
}

const config: RecentConfig = { count: 3, maxLine: 70, show: true };
const samples = [
	"first prompt about redis",
	"中文提问测试——这是一条比较长的中文提问，用来验证按终端列宽截断的行为是否符合预期，中文占两列",
	"last one",
];

let saved: RecentConfig | null = null;
let closed = false;

const handle: ConfigServerHandle = await startConfigServer({
	config,
	getSamples: () => samples,
	onSave: (c) => {
		saved = { ...c };
	},
	onClose: () => {
		closed = true;
	},
});

console.log(`server at ${handle.url}`);

const base = new URL(handle.url).origin;
const tok = handle.url.split("t=")[1];

// 1. HTML page with correct token
let res = await fetch(handle.url);
const html = await res.text();
assert(res.status === 200, "GET / (correct token) → 200");
assert(html.includes("pi-recent-user 配置"), "HTML contains page title");
assert(html.includes("<!DOCTYPE html>"), "HTML doctype present");

// 2. Wrong token rejected
const badUrl = handle.url.replace(/t=[^&]+/, "t=wrong-token");
res = await fetch(badUrl);
assert(res.status === 403, "GET / (wrong token) → 403");
res = await fetch(`${base}/api/state`);
assert(res.status === 403, "GET /api/state (no token) → 403");

// 3. State endpoint
res = await fetch(`${base}/api/state?t=${tok}`);
let data = (await res.json()) as { ok: boolean; config: RecentConfig; lines: string[] };
assert(res.status === 200 && data.ok, "GET /api/state → ok");
assert(data.config.count === 3 && data.config.maxLine === 70, "state returns current config");
assert(
	data.lines.length === 4 && data.lines[0].includes("Recently you asked") && data.lines[3] === "▶ last one",
	"state lines: title + 3 entries, ▶ on latest",
);
assert(!data.lines[1].includes("\n"), "lines are single-line (no embedded newline)");

// 4. Preview: CJK truncation by terminal columns
res = await fetch(`${base}/api/preview?t=${tok}`, {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({ count: 2, maxLine: 30 }),
});
data = (await res.json()) as { ok: boolean; lines: string[] };
assert(data.ok && data.lines.length === 3, "preview respects count=2 (title + 2)");
assert(data.lines[1].includes("…") || data.lines[2].includes("…"), "long line truncated with …");
assert(!data.lines.some((l) => l.includes("\n") || l.includes("\r") || l.includes("\t")), "preview lines single-line");

// 5. Save: mutates shared config + triggers onSave
res = await fetch(`${base}/api/config?t=${tok}`, {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({ count: 5, maxLine: 100, show: false }),
});
data = (await res.json()) as { ok: boolean; config: RecentConfig; lines: string[] };
assert(data.ok && data.config.count === 5 && data.config.maxLine === 100 && data.config.show === false, "save returns clamped config");
assert(config.count === 5 && config.maxLine === 100 && config.show === false, "shared config object mutated");
assert(saved !== null && saved.count === 5, "onSave callback fired with new config");
assert(data.lines.length === 0, "show=false → empty lines (widget hidden)");

// 6. Out-of-range values are clamped server-side
res = await fetch(`${base}/api/config?t=${tok}`, {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({ count: 999, maxLine: 1 }),
});
data = (await res.json()) as { ok: boolean; config: RecentConfig };
assert(data.ok && data.config.count === 10 && data.config.maxLine === 10, "out-of-range clamped to [1,10]/[10,200]");

// 7. Invalid types rejected
res = await fetch(`${base}/api/config?t=${tok}`, {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({ count: "five" }),
});
assert(res.status === 400, "non-numeric count → 400");

// 8. Unknown path → 404
res = await fetch(`${base}/api/nope?t=${tok}`);
assert(res.status === 404, "unknown path → 404");

// 9. Header-based token also accepted
res = await fetch(`${base}/api/state`, { headers: { "x-config-token": tok } });
assert(res.status === 200, "token via x-config-token header accepted");

// 10. Edge cases: control chars, line-width budget, title truncation, idempotency
console.log("\nedge cases:");
const dirty = "line1\nline2\r\n\ttabbed\x07bell\x00nul\x1b[31mansi\x1b[0m\x7fdel\u0085nel end";
const cleaned = toSingleLine(dirty);
assert(!/[\u0000-\u001f\u007f-\u009f]/.test(cleaned), "toSingleLine strips all control chars (C0/C1/DEL/ESC)");
assert(!/[\n\r\t]/.test(cleaned) && cleaned.includes("tabbed"), "toSingleLine collapses newlines/tabs to spaces");
assert(toSingleLine(toSingleLine(dirty)) === cleaned, "toSingleLine is idempotent");

for (const ml of [10, 30, 70, 200]) {
	const lines = buildWidgetLines(
		{ count: 3, maxLine: ml, show: true },
		[dirty, "x".repeat(300), "中文长文本".repeat(60)],
	);
	const allWithin = lines.every((l) => visibleWidth(l) <= ml);
	assert(allWithin, `every line visibleWidth ≤ maxLine=${ml}`);
	assert(lines.every((l) => !/[\u0000-\u001f\u007f-\u009f]/.test(l.replace(/\u001b\[[0-9;]*m/g, ""))), `no control chars in widget lines (maxLine=${ml})`);
	if (ml === 10) {
		assert(visibleWidth(lines[0]) <= 10, "title truncated to maxLine=10");
		assert(!lines[0].includes("Recently"), "title actually truncated at maxLine=10");
	}
}

// 11. available field on all APIs
res = await fetch(`${base}/api/preview?t=${tok}`, {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({ count: 10, maxLine: 50 }),
});
const pv = (await res.json()) as { ok: boolean; available: number; lines: string[] };
assert(pv.ok && pv.available === 3, "preview reports available=3 (sample count)");
assert(pv.lines.length === 4, "count=10 > available → shows all 3 (title+3)");

// 12. DNS-rebinding guard: foreign Host header → 403 (undici fetch forbids setting Host, use raw http)
{
	const status = await new Promise<number>((resolve, reject) => {
		const u = new URL(`${base}/api/state?t=${tok}`);
		const req = http.request(
			{ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: { Host: "evil.example.com" } },
			(res) => {
				res.resume();
				res.once("end", () => resolve(res.statusCode ?? 0));
			},
		);
		req.once("error", reject);
		req.end();
	});
	assert(status === 403, `foreign Host header → 403 (DNS-rebinding guard), got ${status}`);
}

// 13. Preview lines are ANSI-stripped (browser shows no [0m garbage)
const pv2 = (await (
	await fetch(`${base}/api/preview?t=${tok}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ count: 3, maxLine: 20 }),
	})
).json()) as { ok: boolean; lines: string[] };
assert(pv2.ok && !pv2.lines.some((l) => l.includes("\u001b") || l.includes("[0m")), "preview lines ANSI-stripped");

// 14. onSave returning false → 500 (persist failure surfaces to the page)
{
	const h2 = await startConfigServer({
		config: { count: 3, maxLine: 70, show: true },
		getSamples: () => [],
		onSave: () => false,
	});
	const b2 = new URL(h2.url).origin;
	const t2 = h2.url.split("t=")[1]!;
	const r2 = await fetch(`${b2}/api/config?t=${t2}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ count: 4 }),
	});
	assert(r2.status === 500, "onSave=false → 500 persist failure");
	h2.close();
}

// 15. Close → onClose fired, server refuses connections
handle.close();
await new Promise((r) => setTimeout(r, 100));
assert(closed, "onClose fired after close()");
try {
	await fetch(`${base}/api/state?t=${tok}`, { signal: AbortSignal.timeout(800) });
	assert(false, "server refuses connections after close");
} catch {
	assert(true, "server refuses connections after close");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
