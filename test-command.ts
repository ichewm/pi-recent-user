/**
 * Command-dispatch test for the /recent subcommands — mocks pi & ctx, drives
 * the registered handler through every branch. Run: node --experimental-strip-types test-command.ts
 *
 * Config isolation: PI_RECENT_USER_CONFIG redirects all reads/writes to a
 * temp file BEFORE the extension modules load (hence dynamic imports), so the
 * user's real ~/.pi/agent/pi-recent-user.json is never touched.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_DIR = mkdtempSync(join(tmpdir(), "pi-recent-user-test-"));
process.env.PI_RECENT_USER_CONFIG = join(TEST_DIR, "config.json");

const { default: recentWidget } = await import("./src/index.ts");
const { CONFIG_PATH } = await import("./src/config.ts");

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

// ---- mock pi ----
type Handler = (args: string, ctx: unknown) => Promise<void>;
let command: { description: string; handler: Handler } | null = null;
const execCalls: string[] = [];
const pi = {
	on: (_ev: string, _h: unknown) => {},
	registerCommand: (_name: string, opts: { description: string; handler: Handler }) => {
		command = opts;
	},
	exec: async (cmd: string, args: string[]) => {
		execCalls.push(`${cmd} ${args.join(" ")}`);
		return { code: 0, stdout: "", stderr: "" };
	},
};

// ---- mock ctx ----
const branch = [
	{ type: "message", message: { role: "user", content: [{ type: "text", text: "first question" }] } },
	{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "answer 1" }] } },
	{ type: "message", message: { role: "user", content: [{ type: "text", text: "second question" }] } },
	{ type: "message", message: { role: "user", content: "third question\nwith\nnewlines" } },
];
const widgetCalls: (string[] | undefined)[] = [];
const notifications: { msg: string; type: string }[] = [];
const makeCtx = () =>
	({
		hasUI: true,
		ui: {
			setWidget: (_k: string, c: string[] | undefined) => widgetCalls.push(c),
			notify: (m: string, t: string) => notifications.push({ msg: m, type: t }),
		},
		sessionManager: { getBranch: () => branch },
	}) as never;

recentWidget(pi as never);

async function run(args: string): Promise<void> {
	if (!command) throw new Error("command not registered");
	await command.handler(args, makeCtx());
}

// 1. command registered
assert(!!command, "/recent command registered");
assert(command!.description.includes("config"), "description mentions config");

// 2. /recent (empty) → status
await run("");
const last = () => notifications[notifications.length - 1];
assert(notifications.some((n) => n.msg.includes("widget:") && n.msg.includes("/recent config to open")), "empty args → status (incl. config hint)");

// 3. /recent 5 → widget with title + 5 entries (only 3 user msgs available)
widgetCalls.length = 0;
await run("5");
const w = widgetCalls[widgetCalls.length - 1];
assert(Array.isArray(w) && w!.length === 4, "/recent 5 → title + 3 available entries");
assert(w![3] === "▶ third question with newlines", "latest entry ▶, newline collapsed");

// 4. /recent off → widget cleared
widgetCalls.length = 0;
await run("off");
assert(widgetCalls[widgetCalls.length - 1] === undefined, "/recent off → widget cleared");

// 5. /recent on → widget restored
await run("on");
assert(Array.isArray(widgetCalls[widgetCalls.length - 1]), "/recent on → widget restored");

// 6. /recent config → server started + browser opened + URL notified
notifications.length = 0;
execCalls.length = 0;
await run("config");
assert(execCalls.some((c) => c.startsWith("open http://127.0.0.1:")), "/recent config → browser opened with local URL");
assert(last().msg.includes("config page:") && last().msg.includes("auto-closes after 10 min idle"), "/recent config → URL + idle hint notified");

// 7. /recent config (again, running) → same URL, server reused (exec called again, notify still shows URL)
const url1 = last().msg;
await run("config");
assert(last().msg.includes("config page:"), "/recent config while running → shows URL again");

// 8. save via the running page → widget hot-refresh + notify
const m = url1.match(/http:\/\/[^\s]+/);
assert(!!m, "URL extractable from notify");
const pageUrl = m![0];
const base = new URL(pageUrl).origin;
const tok = pageUrl.split("t=")[1]!;
widgetCalls.length = 0;
notifications.length = 0;
const res = await fetch(`${base}/api/config?t=${tok}`, {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({ count: 2, maxLine: 50, show: true }),
});
const data = (await res.json()) as { ok: boolean };
assert(data.ok, "POST /api/config via page URL → ok");
assert(Array.isArray(widgetCalls[widgetCalls.length - 1]), "save from page → widget hot-refreshed");
assert(notifications.some((n) => n.msg.includes("Hot-applied")), "save from page → terminal notify 'Hot-applied'");
assert(existsSync(CONFIG_PATH), "save from page → config file written");

// 9. /recent config stop → closed
notifications.length = 0;
await run("config stop");
assert(last().msg === "config page closed", "/recent config stop → closed notify");

// 10. unknown subcommand → warning
notifications.length = 0;
await run("blah");
assert(last().type === "warning" && last().msg.includes("Unknown subcommand"), "unknown subcommand → warning usage");

console.log(`\n${passed} passed, ${failed} failed`);
// cleanup: only the isolated temp dir, never the user's real config
try {
	rmSync(TEST_DIR, { recursive: true, force: true });
} catch {}
process.exit(failed > 0 ? 1 : 0);
