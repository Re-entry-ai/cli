# Contributing to `@re-entry.ai/cli`

Thanks for your interest in helping. The CLI is the agent-native surface of the re-entry.ai control plane — it's used in pre-commit hooks, CI gates, and MCP integrations every day, so quality bar is high. This guide tells you how to contribute without surprises.

## Code of conduct

This project follows the [Contributor Covenant 2.1](./CODE_OF_CONDUCT.md). Be kind. Disagree with code, not people.

## Ways to contribute

- **Report a bug** — open a [GitHub issue](https://github.com/Re-entry-ai/cli/issues/new/choose) using the bug-report template.
- **Suggest an enhancement** — same issues page, feature-request template.
- **Improve docs** — README typos, clarifications, additional workflows are all welcome PRs.
- **Submit a fix or feature** — see "Pull requests" below.
- **Report a security vulnerability** — DO NOT open a public issue. See [SECURITY.md](./SECURITY.md).

## Local development

```sh
git clone https://github.com/Re-entry-ai/cli.git
cd cli
nvm use 18.18.0     # required Node version
npm install
npm run build       # bundles src/ → bin/reentry
npm link            # symlinks `reentry` onto your PATH
npm test            # jest
npm run typecheck   # tsc --noEmit
npm run lint        # eslint src
```

`npm link` makes the locally-built `reentry` executable available in any shell. After edits, rerun `npm run build` — the link stays valid.

To point the CLI at a non-production backend:

```sh
REENTRY_API_URL=http://localhost:3003 reentry whoami
```

## Pull requests

1. **Open an issue first** for anything beyond a typo or one-line fix. We don't want you to spend a weekend on a feature we won't merge.
2. **Fork + branch.** Branch names: `feat/<short>`, `fix/<short>`, `docs/<short>`. Keep one logical change per PR.
3. **Run the full check locally** before pushing:
   ```sh
   npm run typecheck && npm test && npm run lint && npm run build
   ```
4. **Write tests.** New commands need at least one passing scenario in `test/`. Bug fixes need a regression test that fails before the fix.
5. **Keep diffs small.** PRs over ~400 changed lines are hard to review carefully.
6. **No breaking changes to exit codes or `--json` output shape** without a deprecation notice. CI scripts depend on these.
7. **Open the PR** with a clear title and a body that answers: _what changed, why, how to verify_. Use the PR template.

CI runs typecheck + test + build on every PR; merges are blocked until it's green.

## Style

- TypeScript only. No `any`. Always braces. No one-line conditionals.
- File-per-command for new commands (`src/commands/<name>.ts`).
- Helpers live in `src/lib/`.
- Keep stdout machine-friendly when `--json` is set (no decorative output to stdout in JSON mode).
- Errors go to stderr; exit codes follow the BSD `sysexits.h` convention documented in the [README](./README.md#exit-codes).

## Maintainer setup: branch protection

`main` is protected. Contributors cannot push directly; every change goes through a PR.

The exact protection rules are versioned in [`scripts/branch-protection.json`](./scripts/branch-protection.json) and can be reapplied at any time:

```sh
export GITHUB_TOKEN=...   # token with repo:admin on Re-entry-ai/cli
bash scripts/setup-branch-protection.sh
```

In short:

- No direct pushes to `main` (admins included — `enforce_admins: true`).
- Every PR requires one approving review from a CODEOWNER.
- Stale reviews are dismissed when new commits land.
- All conversations must be resolved.
- CI status checks (`test (18.18.0)`, `test (20.x)`, `packaging`) must pass.
- Force pushes and branch deletion are disabled.
- Linear history (rebase or squash merges only).

## Releasing (maintainers only)

Releases are published to npm with [provenance](https://docs.npmjs.com/generating-provenance-statements) by `.github/workflows/publish.yml` when a `v*` tag is pushed:

```sh
# bump version in package.json (semver)
npm version patch    # or minor / major
git push --follow-tags
```

The workflow verifies that the tag matches `package.json`, runs typecheck/test/build, and then `npm publish --provenance --access public`. Provenance ties every published tarball to a specific GitHub Actions run + commit SHA.

## License

By contributing, you agree that your contributions will be licensed under the MIT License (see [LICENSE](./LICENSE)).
