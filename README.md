# `reentry` — re-entry.ai CLI

> Governance for autonomous coding agents, in your terminal.

`reentry` brings the re-entry.ai control plane to where developers actually work — local shells, CI pipelines, and AI coding agents (Claude Code, Cursor) over MCP. It's quiet on the happy path, intervenes only when risk or policy says so, and explains every decision.

- 🛡️ **Detect risk on every commit, push, and PR** — heuristic scoring + LLM review, scored against your team's policies.
- 🤖 **Govern AI coding agents via MCP** — the same governance the dashboard runs is one config block away from Claude Code or Cursor.
- 📡 **Live observation of agent sessions** — `reentry observe` tails what your agents are doing in real time.
- 🚦 **Block at the boundary, not in code review** — fail commits before they leave the laptop; non-zero exit codes wire cleanly into CI.

```sh
npm i -g @reentry-ai/cli && reentry init
```

---

## Table of contents

- [Quick start](#quick-start)
- [Typical workflow](#typical-workflow)
- [Commands reference](#commands-reference)
- [Exit codes](#exit-codes)
- [Configuration](#configuration)
- [Security & privacy](#security--privacy)
- [Pre-commit hook](#pre-commit-hook)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

---

## Quick start

```sh
# 1. Install
npm i -g @reentry-ai/cli

# 2. Set up: device-flow login, install pre-commit hook, run first check
reentry init

# 3. (Optional) wire your IDE / coding agent to the same governance
reentry agent add claude-code
# or
reentry agent add cursor
```

`reentry init` runs the device-flow login (opens your browser to confirm), installs a `.git/hooks/pre-commit` shim, and runs a first risk check against your staged (or last-commit) diff. From then on, every commit is checked against your team's policies before it lands.

`reentry agent add` writes the re-entry MCP server into your IDE's config so your AI agents can call governance tools (`pre_commit_check`, `decide_action`, `get_team_rules`, …) without you wiring anything by hand.

---

## Typical workflow

A day-in-the-life view — what `reentry` is doing while you work.

1. **`reentry init`** in your repo, once. Token stored at `~/.config/reentry/credentials.json` (mode `0600`). Pre-commit hook installed.
2. **`reentry agent add claude-code`** (or `cursor`). The MCP server entry is added to the IDE's config; your AI agents can now call governance tools natively.
3. **You write code normally.** No prompting, no UI, no overhead. The pre-commit hook fires on every `git commit`.
4. **A risky change is staged** — say, a migration that touches `auth.service.ts`. The hook calls `reentry pre-commit`, which runs the heuristic + LLM risk pass. If the score crosses threshold, the commit is blocked (exit `1`) with a one-paragraph reason and a link to the dashboard.
5. **`reentry observe`** in another terminal lets you tail agent activity live: which tools were called, which got blocked, latency, risk scores. Useful when you've got an autonomous agent running unattended overnight.
6. **`reentry status` / `reentry explain <pr>`** when you want a verdict on a specific branch or PR — same governance result the dashboard shows, in your terminal. Auto-detects the repo from `git remote get-url origin`.

---

## Commands reference

| Command | What it does |
| --- | --- |
| `reentry init` | One flow: login → install git pre-commit hook → run a first check. Idempotent. |
| `reentry login` | Authenticate via device flow (opens your browser). |
| `reentry logout` | Remove the locally stored token. |
| `reentry whoami` | Show the team, plan tier, and tool scopes attached to your token. |
| `reentry pre-commit` | Check the staged diff. Exits non-zero on blocked / requires-review. |
| `reentry status [pr]` | Governance verdict for the current branch or a specific PR. |
| `reentry explain <pr>` | Human-readable rationale for a PR decision. |
| `reentry observe` | Tail live agent-session events from your team. |
| `reentry agent add <claude-code\|cursor>` | Write the re-entry MCP server into the agent's config. `--global` for user-level, `--force` to overwrite a stale entry. |
| `reentry agent remove <claude-code\|cursor>` | Remove only the re-entry server entry; preserves everything else in the file. |
| `reentry agent list` | Show install status for each supported agent. |

Every command accepts `--json` for machine-readable output (success and error). Every command honors `--no-color` and the `NO_COLOR` env variable.

---

## Exit codes

CI scripts can branch on these:

| Code | Meaning |
| --- | --- |
| `0` | Action allowed / command succeeded |
| `1` | Action blocked by policy or risk |
| `2` | Action requires human review |
| `64` | CLI usage error (bad flag, missing arg, nonexistent PR) |
| `65` | Auth error — run `reentry login` |
| `66` | Network or backend error |
| `70` | Internal CLI error |
| `77` | Permission denied — token valid, action forbidden by tier/scope/policy |

Codes `64`–`77` follow the BSD `sysexits.h` convention. CI authors who already branch on these get sensible behavior for free.

---

## Configuration

| Variable | Purpose |
| --- | --- |
| `REENTRY_API_URL` | Override the backend URL (default: `https://api.re-entry.ai`). |
| `XDG_CONFIG_HOME` | Override where credentials are stored (default: `~/.config`). |
| `NO_COLOR` | Disable color output (standard terminal convention). |
| `REENTRY_SKIP_BROWSER` | Set to `1` to suppress the browser auto-open during `login` / `init`. Useful for headless / CI. |

---

## Security & privacy

We treat the CLI as a trust boundary. Here's exactly what happens:

### What's stored, where

| Artifact | Path | Mode |
| --- | --- | --- |
| Bearer token | `$XDG_CONFIG_HOME/reentry/credentials.json` (default: `~/.config/reentry/credentials.json`) | `0600` |
| Claude Code MCP config (incl. token) | `<repo>/.mcp.json` (or `~/.claude.json` with `--global`) | `0600` |
| Cursor MCP config (incl. token) | `<repo>/.cursor/mcp.json` (or `~/.cursor/mcp.json` with `--global`) | `0600` |
| Pre-commit hook | `<repo>/.git/hooks/pre-commit` | `0755` |

All token files are written with `0600` and owner-only directory permissions. If `reentry` ever finds the credentials file with looser permissions (e.g., a teammate's dotfile sync widened it), it tightens to `0600` and prints a one-line warning to stderr.

### What's transmitted

- **Only on demand.** No background syncing, no telemetry pings, no usage tracking.
- **Diffs go to the backend** when you run `pre-commit`, `status`, `explain`, or any MCP tool that needs them. Used for LLM risk assessment. Raw source isn't retained beyond your team's audit-log retention window — see the dashboard's data settings page.
- **HTTPS only** to the API host. Bearer auth with a short-lived token. Tokens are scoped to a single team and a single set of MCP tools (see `reentry whoami`).
- **No source code is sent unless you stage it.** The pre-commit hook reads `git diff --cached`; if it's empty, nothing is transmitted.

### Hooks are safe for teammates

The git hook auto-skips if `reentry` isn't on a teammate's `PATH`:

```sh
if ! command -v reentry >/dev/null 2>&1; then
  exit 0
fi
exec reentry pre-commit
```

Pulling a repo with a re-entry hook installed never breaks a contributor who hasn't installed the CLI.

### `reentry agent add` and the bearer token

`agent add` writes your bearer token into the IDE's MCP config file. Two consequences:

1. **The token is now in two places** — `~/.config/reentry/credentials.json` and the IDE config. Running `reentry logout` deletes the first; you should also `reentry agent remove` to delete the second.
2. **The IDE config file is also `chmod 0600`'d** by us. If you commit `.mcp.json` to a public repo, the bearer token will be exposed — the IDE config files are useful to share within a team but the token-bearing form should not be committed publicly. For shared-team-config use the project-local file with `--global` omitted; for solo / personal use, prefer `--global`.

### Compliance status

- SOC 2 Type I — see the dashboard's `/security` page for current status.
- GDPR / EU data residency — current posture documented at <https://re-entry.ai/security>.

---

## Pre-commit hook

`reentry init` writes `.git/hooks/pre-commit`:

```sh
#!/bin/sh
# managed-by: reentry-cli
# Run re-entry pre-commit governance check. Exit non-zero to block the commit.
if ! command -v reentry >/dev/null 2>&1; then
  exit 0
fi
exec reentry pre-commit
```

If you already have a `pre-commit` hook, it's preserved at `pre-commit.reentry-backup` so you can re-merge any custom logic. Re-running `reentry init` refreshes the managed hook in place (idempotent — same SHA on a no-op re-run).

---

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `reentry login` hangs forever | Backend device-flow route 404 | Confirm `REENTRY_API_URL` points at a running backend; restart it if you just deployed. |
| `reentry login` opens the browser to a 404 | Frontend not running, or you're not signed in to the dashboard | Make sure the dashboard is reachable; sign in once before approving the device code. |
| `reentry whoami` says "Not logged in" right after `reentry login` | Credentials file write failed (permissions / path) | `ls -la ~/.config/reentry/credentials.json` — should exist, mode `0600`. Re-run `reentry login`. |
| `reentry pre-commit` exits `65` | Token expired or revoked | `reentry logout && reentry login`. |
| `reentry pre-commit` exits `66` | Backend unreachable | Check `REENTRY_API_URL` and your network. |
| `reentry status` exits `77` | Repo not in your team's selected repos | Open the dashboard → integrations → add this repo. |
| `reentry agent add ...` says "stale" | Existing entry differs from current login (e.g., different team, different URL) | Re-run with `--force`, or `reentry agent remove` first. |
| Commit hook doesn't fire | Hook missing exec bit, or hook never installed | `ls -la .git/hooks/pre-commit`; rerun `reentry init`. |

`reentry --json` adds a structured envelope to every error — `{"success":false,"code":"...","message":"..."}` — so CI scripts can branch without parsing prose.

---

## Development

```sh
git clone https://github.com/Re-entry-ai/cli.git
cd cli
nvm use 18.18.0
npm install
npm run build       # bundles to bin/reentry
npm link            # symlinks `reentry` onto your PATH
npm test            # jest
npm run typecheck   # tsc --noEmit
```

After local edits: rerun `npm run build` (the `npm link` symlink stays valid).

---

## License

MIT — see [LICENSE](./LICENSE).

## Reporting bugs

<https://github.com/Re-entry-ai/cli/issues>
