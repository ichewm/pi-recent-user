# pi-recent-user

> A pi extension that keeps a persistent widget showing your recent prompts, so you can pick up context fast when returning to a long session.

## Problem

A pi session accumulates many turns over time. Leave for a while, come back, and the screen is full of the latest LLM thinking and answer — you scroll forever to find "what did I ask last?". This extension puts a persistent widget above the editor showing your last N prompts. One glance and you're back in context.

## What it looks like

Widget (above the editor):

```
📝 Recently you asked:
· help me review the token-refresh logic in the login module
· what are typical Redis use cases
▶ what to consider when designing a flash-sale system
```

Latest entry is marked with `▶`, earlier ones with `·`.

Config page (opens in your browser via `/recent`): a dark-themed card with a show/hide toggle, a count slider (1–10), a max-line slider (10–200), and a **live preview** rendered with your session's actual recent prompts. Saving applies instantly — no restart needed.

## Install

```bash
# local path (dev/personal)
pi install /path/to/pi-recent-user

# GitHub
pi install git:github.com/ichewm/pi-recent-user@v0.2.0
# or unpinned
pi install https://github.com/ichewm/pi-recent-user

# npm
pi install npm:pi-recent-user
```

Once installed, every pi start auto-loads it (no `-e` needed). Uninstall: `pi remove <source>`.

## Usage

Same subcommand style as `/vrefine`:

| Command | Effect |
|---|---|
| `/recent` | show status: widget state, count/maxLine, config path, config-page URL if running |
| `/recent config` | **open the web config page in your browser** (main entry) |
| `/recent config stop` | manually close the config page server |
| `/recent on` / `/recent off` | quick show / hide without opening the page |
| `/recent 5` | quick set: show last 5 prompts (1–10) |

Running `/recent config` again while the page is running just shows the existing URL. The page auto-closes after 10 minutes of inactivity; every save also `notify`s in the pi terminal (`config saved (…). Hot-applied.`).

On the config page you can adjust everything — show/hide, count, max line width — with a live preview of the widget, then Save. Changes are written to the config file and applied to the widget immediately.

If the browser fails to open, pi shows the URL (e.g. `http://127.0.0.1:53231/?t=<token>`) so you can open it manually.

## Config

Stored in the extension's own file: `~/.pi/agent/pi-recent-user.json` — **not** in pi's `settings.json` (follows the pi ecosystem convention, so no config leftover on uninstall).

| Field | Type | Default | Description |
|---|---|---|---|
| `count` | number | `3` | how many recent prompts to show (1–10, auto-clamped) |
| `maxLine` | number | `70` | max display width per line, in terminal columns (10–200) |
| `show` | boolean | `true` | whether the widget is shown |

You normally don't edit this file by hand — use the web page. If you do edit it, restart pi (or re-save from the page) to take effect.

## How it works

- **Widget**: `session_start` (return/new session) + `turn_end` (refresh after each turn) → reads `ctx.sessionManager.getBranch()`, takes the last N `role === "user"` messages → `ctx.ui.setWidget()`, a persistent widget above the editor
- **Config page**: `/recent config` starts a local HTTP server on `127.0.0.1` (random port) guarded by a per-session random token in the URL, then opens it in your browser. `/recent config stop` closes it manually; it also auto-shuts-down after 10 minutes of inactivity or when the session shuts down. The page is served inline (no external assets); edits POST back as JSON, are clamped to valid ranges, persisted atomically (a disk-write failure surfaces as an error instead of a fake success), and the widget refreshes instantly.
- **Zero side effects on your session**: read-only w.r.t. messages — doesn't touch context, doesn't alter the message stream, makes no LLM calls

## Notes

1. **Truncation by display width** (CJK characters counted as 2 columns) via `truncateToWidth`, so wide-glyph text doesn't overflow.
2. **Multi-line/long input**: each entry is collapsed to a single line (all whitespace runs become one space).
3. **Widget position**: above the editor by default. For below: pass `{ placement: "belowEditor" }` to `setWidget`.
4. **After `pi remove`**: the config file `~/.pi/agent/pi-recent-user.json` remains but is harmless (not read when the extension is unloaded). Delete it manually to fully clean up.
5. **Empty session**: the widget is hidden when there's no user-message history yet; the config page preview shows a hint instead.
6. **Security & privacy**: the config server binds to `127.0.0.1` only, uses a random port and a random per-run session token, rejects foreign `Host` headers (DNS-rebinding guard), sends `Cache-Control: no-store` and a restrictive `Content-Security-Policy`, and caps request body size. Recent prompts shown on the page live in memory only — nothing is logged, persisted, or sent anywhere; the config file stores just three harmless fields (`count` / `maxLine` / `show`).

## Customize

Three files under `src/`:

- `index.ts` — extension entry: events, widget updates, `/recent` command, browser opening
- `config.ts` — config type, defaults, clamping, atomic load/save
- `config-server.ts` — local HTTP server + inline HTML page + widget-line builder (single source of truth for rendering)

Common tweaks:

- Defaults: `DEFAULTS` in `config.ts`
- Widget title: the `"📝 Recently you asked:"` string in `buildWidgetLines` (`config-server.ts`)
- Idle timeout of the config server: `IDLE_TIMEOUT_MS` in `config-server.ts` (10 min, same as `/vrefine config`)
- Position below editor: add `{ placement: "belowEditor" }` to `setWidget` in `index.ts`

After edits: `/reload` or restart pi.

## Development

```bash
npm run check                # tsc --noEmit
node --experimental-strip-types --no-warnings test-server.ts    # config server: auth, clamping, width budget, edge cases (no pi needed)
node --experimental-strip-types --no-warnings test-command.ts   # /recent subcommand dispatch with mocked pi/ctx
```

Tests never touch your real config: `test-command.ts` sets `PI_RECENT_USER_CONFIG` to a temp
path before importing the extension (dynamic import), so all writes are redirected. You can
also set that env var yourself to run pi with an isolated config file.

## Dependencies

- Runtime: `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` (bundled with pi, listed as `peerDependencies`, not bundled here)
- No build step — pi runs `.ts` directly via jiti

## License

MIT
