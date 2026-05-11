<!-- Thanks for contributing. Please fill in the sections below. -->

## What changed

<!-- One or two sentences describing the change. -->

## Why

<!-- Link the issue this addresses (e.g. "Closes #123") and explain the motivation. -->

## How to verify

<!-- Concrete steps a reviewer can run to confirm this works. -->

```sh
# example
npm test
reentry pre-commit
```

## Checklist

- [ ] Tests added or updated (or the change is documentation-only).
- [ ] `npm run typecheck && npm test && npm run lint && npm run build` pass locally.
- [ ] No breaking changes to exit codes or `--json` output shape (or, if there are, a deprecation notice is included).
- [ ] README / CONTRIBUTING updated if user-facing behavior changed.
- [ ] No secrets, tokens, or customer data in the diff.
