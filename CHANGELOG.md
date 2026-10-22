# Changelog

## 0.2.0

Web config page + hardening. Full rewrite of the config UX — everything is now adjustable in the browser with a live preview, in the same style as `/vrefine config`.

### Added

- **Web config page** (`/recent config`): dark-themed local page on `127.0.0.1` (random port, per-run session token) with show/hide toggle, count slider (1–10), max-line slider (10–200), and a live preview rendered from your session's actual recent prompts. Saving persists atomically and hot-applies to the widget — no restart.
- `/recent` now defaults to a `status` view (widget state, config path, config-page URL); subcommands: `status | config [stop] | on | off | <1–10>`, same style as `/vrefine`.
- Live-preview meta line showing available vs. displayed prompt count, so it's obvious why changing count may not change the preview (not enough prompts in the session).
- Config server auto-closes after 10 min idle or on `session_shutdown`.
- Security: Host-header validation (DNS-rebinding guard), `Cache-Control: no-store`, restrictive CSP, 16 KB body cap, token via URL or `x-config-token` header.
- `PI_RECENT_USER_CONFIG` env var to redirect the config file path (used by tests for isolation).
- Two test suites (`test-server.ts` 40 assertions, `test-command.ts` 17) covering auth, clamping, width budget, control characters, persist failures, and subcommand dispatch.

### Fixed

- Multi-line prompts no longer break the widget layout: all whitespace runs collapse to single spaces AND all control characters (C0/C1/DEL/ESC — bell, NEL, ANSI leaks) are stripped.
- Every widget line now respects `maxLine` exactly: the `▶ `/`· ` prefix is budgeted (2 columns) and the title line is truncated too (matters for tiny `maxLine`).
- Preview no longer shows `[0m` garbage — API responses are ANSI-stripped (the widget itself keeps proper ANSI for the TUI).
- A failed disk write now surfaces as an error (HTTP 500 + terminal notify) instead of a fake \"saved ✓\".

### Changed

- Config source split into `src/config.ts`; widget rendering lives in `src/config-server.ts` (`buildWidgetLines`, single source of truth for widget + preview).
- Type deps upgraded to pi 1.x (`^1.4.0`); imports use `.ts` extensions for jiti.

## 0.1.0

Initial release: persistent widget showing your recent prompts above the editor, `/recent on|off|<n>`, config persisted in `~/.pi/agent/pi-recent-user.json`.
