# Security policy

## Supported versions

We support the latest minor release of `@re-entry.ai/cli`. Older versions may not receive security fixes — upgrade to stay protected.

## Reporting a vulnerability

**Do not open a public GitHub issue for vulnerabilities.**

Email **security@re-entry.ai** with:

1. A description of the issue and its impact.
2. Steps to reproduce (or a proof-of-concept).
3. The CLI version (`reentry --version`), Node.js version, and operating system.
4. Any suggested mitigation, if you have one.

You should receive an acknowledgement within **two business days**. We aim to confirm a triage decision within **five business days** and to ship a fix within **30 days** for high-severity issues.

We follow [coordinated disclosure](https://en.wikipedia.org/wiki/Coordinated_vulnerability_disclosure): we ask that you give us a reasonable window to ship a fix before publishing details. We will credit you in the release notes if you would like the credit.

## Scope

In scope:

- The published `@re-entry.ai/cli` package on npm.
- Configuration files the CLI writes (`~/.config/reentry/credentials.json`, `.git/hooks/pre-commit`, IDE MCP configs).
- The CLI's interaction with the re-entry.ai backend over HTTPS.

Out of scope (report directly to <security@re-entry.ai> but tracked separately):

- The re-entry.ai web dashboard or backend API.
- Third-party MCP clients (Claude Code, Cursor) and their internal handling of MCP configs.

## Supply-chain integrity

Every published version is signed with [npm provenance](https://docs.npmjs.com/generating-provenance-statements). You can verify the binding between the published tarball and the GitHub Actions run that built it:

```sh
npm audit signatures
```

Releases are produced by `.github/workflows/publish.yml` from this public repository — there is no other publish path.

## What the CLI sends to the backend

A summary lives in the [README — Security & privacy](./README.md#security--privacy) section. In short: diffs are transmitted on demand for risk assessment; nothing is sent in the background; bearer tokens are scoped to a single team.
