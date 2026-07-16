# pi-recent-user

> A pi extension that keeps a persistent widget showing your recent prompts, so you can pick up context fast when returning to a long session.

## Problem

A pi session accumulates many turns over time. Leave for a while, come back, and the screen is full of the latest LLM thinking and answer — you scroll forever to find "what did I ask last?". This extension puts a persistent widget above the editor showing your last N prompts. One glance and you're back in context.

## What it looks like

```
📝 Recently you asked:
· help me review the token-refresh logic in the login module
· what are typical Redis use cases
▶ what to consider when designing a flash-sale system
```

Latest entry is marked with `▶`, earlier ones with `·`.

## Install

```bash
# local path (dev/personal)
pi install /path/to/pi-recent-user

# GitHub
pi install git:github.com/ichewm/pi-recent-user@v0.1.0
# or unpinned
pi install https://github.com/ichewm/pi-recent-user

# npm
pi install npm:pi-recent-user
```

Once installed, every pi start auto-loads it (no `-e` needed). Uninstall: `pi remove <source>`.

## Usage

Auto-works on install. One command to adjust:

| Command | Effect |
|---|---|
| `/recent` | show current status |
| `/recent on` / `/recent off` | show / hide the widget |
| `/recent 5` | show last 5 prompts (range 1–10) |

All adjustments persist (written to the config file) and survive restart.

## Config

Stored in the extension's own file: `~/.pi/agent/pi-recent-user.json` — **not** in pi's `settings.json` (follows the pi ecosystem convention, so no config leftover on uninstall).

| Field | Type | Default | Description |
|---|---|---|---|
| `count` | number | `3` | how many recent prompts to show (1–10, auto-clamped) |
| `maxLine` | number | `70` | max display width per line, in terminal columns (10–200) |
| `show` | boolean | `true` | whether the widget is shown |

To change defaults without `/recent`, edit `DEFAULTS` in `src/index.ts`.

## How it works

- **Triggers**: `session_start` (return/new session) + `turn_end` (refresh after each turn)
- **Source**: reads `ctx.sessionManager.getBranch()`, takes the last N `role === "user"` messages
- **Display**: `ctx.ui.setWidget()`, a persistent widget above the editor
- **Zero side effects**: read-only — doesn't touch context, doesn't alter the message stream, makes no LLM calls

## Notes

1. **Truncation by display width** (CJK characters counted as 2 columns) via `truncateToWidth`, so wide-glyph text doesn't overflow.
2. **Widget position**: above the editor by default. For below: pass `{ placement: "belowEditor" }` to `setWidget`.
3. **After `pi remove`**: the config file `~/.pi/agent/pi-recent-user.json` remains but is harmless (not read when the extension is unloaded). Delete it manually to fully clean up.
4. **Empty session**: the widget is hidden when there's no user-message history yet.
5. **Multi-line/long input**: each entry is collapsed to a single line.
6. **Editing the config file by hand**: restart pi to take effect — only `/recent` changes apply live.

## Customize

Single file `src/index.ts` (~130 lines). Common tweaks:

- Defaults: `DEFAULTS`
- Widget title: the `"📝 Recently you asked:"` string in `updateWidget`
- Position below editor: add `{ placement: "belowEditor" }` to `setWidget`
- Truncation width: `DEFAULTS.maxLine`

After edits: `/reload` or restart pi.

## Dependencies

- Runtime: `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` (bundled with pi, listed as `peerDependencies`, not bundled here)
- No build step — pi runs `.ts` directly via jiti

## License

MIT
