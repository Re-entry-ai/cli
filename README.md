# `reentry` — re-entry.ai CLI

Governance for autonomous coding agents, in your terminal.

```sh
npm i -g @reentry-ai/cli && reentry init
```

`reentry init` runs the device-flow login, installs a git pre-commit hook, and runs a first risk check on your staged (or last-commit) diff. After that, every commit is checked against your team's policies before it lands.

## Commands

| Command | What it does |
| --- | --- |
| `reentry init` | One flow: login → install git pre-commit hook → first check. Idempotent. |
| `reentry login` | Authenticate via device flow (opens your browser). |
| `reentry logout` | Remove the locally stored token. |
| `reentry whoami` | Show the team and agent identity attached to your token. |
| `reentry pre-commit` | Check the staged diff. Exits non-zero on blocked / requires-review. |
| `reentry status [pr]` | Governance verdict for the current branch or a specific PR. |
| `reentry explain <pr>` | Human-readable rationale for a PR decision. |
| `reentry observe` | Tail live agent-session events from your team. |

All commands accept `--json` for machine-readable output.

## Exit codes

CI scripts can branch on these:

| Code | Meaning |
| --- | --- |
| `0` | Action allowed / command succeeded |
| `1` | Action blocked by policy or risk |
| `2` | Action requires human review |
| `64` | CLI usage error (bad flag, missing arg) |
| `65` | Auth error — run `reentry login` |
| `66` | Network or backend error |
| `70` | Internal CLI error |
| `77` | Permission denied — token valid, action forbidden by tier/scope/policy |

Codes 64–77 follow the BSD `sysexits.h` convention.

## Configuration

| Variable | Purpose |
| --- | --- |
| `REENTRY_API_URL` | Override the backend URL (default: `https://api.re-entry.ai`). |
| `XDG_CONFIG_HOME` | Override where credentials are stored (default: `~/.config`). |
| `NO_COLOR` | Disable color output (terminal-norm). |
| `REENTRY_SKIP_BROWSER` | Set to `1` to suppress the browser auto-open during `login` / `init`. Useful for headless environments and CI. |

Credentials are stored at `$XDG_CONFIG_HOME/reentry/credentials.json` with file mode `0600` (owner-read/write only). To revoke a token server-side, open the dashboard's MCP-tokens page.

## Pre-commit hook

`reentry init` writes `.git/hooks/pre-commit` containing:

```sh
#!/bin/sh
# managed-by: reentry-cli
if ! command -v reentry >/dev/null 2>&1; then
  exit 0
fi
exec reentry pre-commit
```

If you already have a `pre-commit` hook, it's preserved at `pre-commit.reentry-backup` so you can re-merge any custom logic. Re-running `reentry init` refreshes the managed hook in place.

## Requirements

- Node 18.18.0 or newer.
- A re-entry.ai team — sign up at <https://re-entry.ai>.

## Reporting bugs

<https://github.com/reentry-ai/cli/issues>
