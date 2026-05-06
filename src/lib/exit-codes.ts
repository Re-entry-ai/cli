/**
 * `reentry` exit-code contract. CI scripts branch on these — keep stable.
 *
 * 0   — action allowed / command succeeded
 * 1   — action blocked by policy or risk
 * 2   — action requires human review (neither allowed nor blocked)
 * 64  — CLI usage error (bad flag, missing arg) — BSD sysexits EX_USAGE
 * 65  — auth error (no token, expired, revoked) — EX_DATAERR-ish; we co-opt
 * 66  — network or backend error                   — EX_NOINPUT-ish; we co-opt
 * 70  — internal CLI error                         — EX_SOFTWARE
 * 77  — permission denied (token valid, action forbidden by tier/scope/policy)
 *                                                    — EX_NOPERM
 *
 * The 64–77 range follows the BSD `sysexits.h` convention so CI authors who
 * already branch on these get sensible behavior for free.
 */
export const ExitCodes = {
  ALLOWED: 0,
  BLOCKED: 1,
  REQUIRES_HUMAN: 2,
  USAGE: 64,
  AUTH: 65,
  NETWORK: 66,
  INTERNAL: 70,
  PERMISSION: 77,
} as const;

export type ExitCode = (typeof ExitCodes)[keyof typeof ExitCodes];
