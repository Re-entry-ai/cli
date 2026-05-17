import * as fs from 'fs';
import * as path from 'path';
import kleur from 'kleur';
import { ExitCodes } from '../lib/exit-codes';
import { apiUrl, credentialsPath, CLI_VERSION } from '../lib/config';
import { readCredentials } from '../lib/storage';
import { callMcpTool } from '../lib/mcp-client';
import { probePreCommitHook } from '../lib/git-hook';
import { readRemoteOriginUrl } from '../lib/git';
import {
  claudeCodeConfigPath,
  statusClaudeCode,
} from '../lib/agent-configs/claude-code';
import {
  cursorConfigPath,
  statusCursor,
} from '../lib/agent-configs/cursor';

interface DoctorOptions {
  json?: boolean;
}

type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

async function checkCredentials(
  options: DoctorOptions,
): Promise<{ result: CheckResult; creds: ReturnType<typeof readCredentials> }> {
  const creds = readCredentials();
  if (!creds) {
    return {
      result: {
        name: 'credentials',
        status: 'fail',
        detail:
          'No credentials found. Run `reentry login` to authenticate.',
      },
      creds,
    };
  }

  // Mode-check the credentials file — anything other than 0600 is a leak.
  const credsFile = credentialsPath();
  let perms: number | null = null;
  try {
    perms = fs.statSync(credsFile).mode & 0o777;
  } catch {
    perms = null;
  }
  if (perms !== null && perms !== 0o600) {
    return {
      result: {
        name: 'credentials',
        status: 'warn',
        detail: `Credentials file at ${path.basename(credsFile)} is mode 0${perms.toString(8)} (expected 0600). Run \`chmod 600 ${credsFile}\`.`,
      },
      creds,
    };
  }

  return {
    result: {
      name: 'credentials',
      status: 'ok',
      detail: `Token issued ${creds.issuedAt} — file mode 0600.`,
    },
    creds,
  };
}

async function checkBackendReachable(
  creds: ReturnType<typeof readCredentials>,
  options: DoctorOptions,
): Promise<CheckResult> {
  if (!creds) {
    return {
      name: 'backend',
      status: 'skip',
      detail: 'Skipped — not logged in.',
    };
  }
  try {
    // `get_team_rules` is a cheap read that exercises auth + tier + scope
    // gates without hitting the LLM. A successful call confirms the
    // token still validates and the backend route is up.
    await callMcpTool('get_team_rules', {}, creds.accessToken);
    return {
      name: 'backend',
      status: 'ok',
      detail: `Reachable at ${apiUrl()}; token valid.`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name: 'backend',
      status: 'fail',
      detail: `Could not reach backend or token rejected: ${message}`,
    };
  }
}

function checkGitHook(options: DoctorOptions): CheckResult {
  const probe = probePreCommitHook();
  if (!probe.inRepo) {
    return {
      name: 'pre-commit hook',
      status: 'skip',
      detail: 'Not inside a git repository — nothing to install here.',
    };
  }
  if (!probe.exists) {
    return {
      name: 'pre-commit hook',
      status: 'warn',
      detail:
        'No pre-commit hook installed. Run `reentry init` to enable governance on every commit.',
    };
  }
  if (!probe.managedByReentry) {
    return {
      name: 'pre-commit hook',
      status: 'warn',
      detail: `Existing pre-commit hook at ${probe.path} is not managed by reentry. \`reentry init\` will back it up before installing.`,
    };
  }
  return {
    name: 'pre-commit hook',
    status: 'ok',
    detail: `Managed shim installed at ${probe.path}.`,
  };
}

function checkAgentConfig(
  agent: 'claude-code' | 'cursor',
  options: DoctorOptions,
): CheckResult {
  const status =
    agent === 'claude-code'
      ? statusClaudeCode({ global: false })
      : statusCursor({ global: false });

  const configPath =
    agent === 'claude-code'
      ? claudeCodeConfigPath(false)
      : cursorConfigPath(false);

  if (!status.installed) {
    return {
      name: `agent: ${agent}`,
      status: 'skip',
      detail: `No project-local entry. Run \`reentry agent add ${agent}\` to register the MCP server.`,
    };
  }

  // The agent config holds the bearer token — verify file mode 0600.
  let perms: number | null = null;
  try {
    perms = fs.statSync(configPath).mode & 0o777;
  } catch {
    perms = null;
  }
  if (perms !== null && perms !== 0o600) {
    return {
      name: `agent: ${agent}`,
      status: 'warn',
      detail: `Installed at ${configPath} but file mode is 0${perms.toString(8)} (expected 0600). Run \`chmod 600 ${configPath}\`.`,
    };
  }
  return {
    name: `agent: ${agent}`,
    status: 'ok',
    detail: `Installed at ${configPath} — file mode 0600.`,
  };
}

/**
 * Shape returned by `list_recent_assessments` — we only care about
 * `repository` here, so this is intentionally a minimal subset of the
 * real envelope. If the API ever returns this nested or renamed, the
 * doctor check degrades to `warn` ("could not verify"), never `fail`,
 * so a transport change can't make the doctor exit non-zero in CI.
 */
interface RecentAssessmentSubset {
  repository?: unknown;
}

interface RecentAssessmentsEnvelope {
  // The backend envelope uses `items`. Earlier drafts of this doctor
  // check looked for `assessments` — the wrong field — and produced
  // false-positive "could not verify" output. Keep this typed against
  // the real wire shape, not whatever feels natural.
  items?: RecentAssessmentSubset[];
}

/**
 * Canonicalise a repository slug into a single comparable form. The git
 * remote and the backend's `repository` column don't necessarily agree
 * on case or `.git` suffix — without normalisation we'd silently warn
 * (or silently OK) on a case mismatch. Conservative rules:
 *  - strip trailing `.git`
 *  - lowercase
 *  - trim whitespace
 *
 * Anything that's not a string returns `null` so the caller can skip
 * comparing it (vs. comparing against the literal string "null").
 */
function normaliseRepoSlug(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.replace(/\.git$/i, '').toLowerCase();
}

/**
 * Pull the team's recently-touched repositories from the MCP API. Used
 * by the git-remote check below to verify that the repo the CLI is
 * about to send to the backend is one the team actually monitors.
 *
 * Failure-mode policy: return null on ANY failure (network, schema,
 * auth, scope). The caller treats null as "skip" — never as "fail" —
 * because the doctor command is a diagnostic, not a gate. If the
 * backend is unreachable the prior `backend` check already reported it.
 */
async function fetchMonitoredRepositories(
  creds: ReturnType<typeof readCredentials>,
): Promise<Set<string> | null> {
  if (!creds) {
    return null;
  }
  try {
    // 50 is enough headroom for any active team's recent repo footprint
    // while staying cheap (DB index hit only; no LLM in the loop).
    const envelope = await callMcpTool<RecentAssessmentsEnvelope>(
      'list_recent_assessments',
      { limit: 50 },
      creds.accessToken,
    );
    if (!envelope || !Array.isArray(envelope.items)) {
      return null;
    }
    const repositories = new Set<string>();
    for (const item of envelope.items) {
      const normalised = normaliseRepoSlug(item.repository);
      if (normalised !== null) {
        repositories.add(normalised);
      }
    }
    return repositories;
  } catch (err) {
    // Always degrade to `null` (caller treats as `skip`). doctor is a
    // diagnostic, not a gate — a failed monitored-repo lookup must
    // never make `doctor` exit non-zero or surface a confusing `warn`.
    //
    // We log a CONSTANT message + the error's class name (e.g.
    // `McpToolError`, `FetchError`) so the failure mode is observable
    // without ever printing `err.message`. Some upstream clients can,
    // in their error stringification, include request context that
    // contains the Authorization header — printing `err.message`
    // verbatim would leak the bearer token into CI logs / shell
    // history. `err.name` is bounded to a class name and safe.
    const errorClass: string =
      err instanceof Error ? err.constructor.name : 'unknown';
    process.stderr.write(
      `reentry doctor: list_recent_assessments lookup failed [${errorClass}] — repo scope check skipped\n`,
    );
    return null;
  }
}

/**
 * Format contract for the repo-scope check (lock this in so a future
 * caller doesn't silently break the comparison):
 *
 *   - `readRemoteOriginUrl()` is REGEX-BOUND to `owner/repo` form. It
 *     parses SSH (`git@github.com:owner/repo[.git]`) and HTTPS
 *     (`https://github.com/owner/repo[.git]`) and returns null for
 *     everything else. No protocol, no host, no path beyond two segments.
 *   - The MCP API's `list_recent_assessments` returns each row's
 *     `repository` field in the same `owner/repo` form (e.g.
 *     `"Re-entry-ai/sentry-reentry"`).
 *
 * Both sides therefore agree on shape; the only drift the normaliser
 * needs to absorb is **case** and an optional trailing `.git` (which
 * `readRemoteOriginUrl`'s regex already strips, but the backend could
 * grow it). If either side ever broadens to full URLs or multi-segment
 * paths, `normaliseRepoSlug` must be extended to match — otherwise this
 * check will silently mis-report.
 */

/**
 * Verify that the repository the CLI will infer from `git remote` is
 * one the user's team actually monitors. This catches two real failure
 * modes that wasted ~2 hours of debug time over the past two days:
 *
 *   1. Git remote points at an old org URL via GitHub redirect (e.g.
 *      after a repo transfer). Pushes succeed via redirect but every
 *      MCP call sends the stale slug to the backend and gets
 *      SCOPE_VIOLATION — with no obvious clue that `git remote` is the
 *      culprit.
 *   2. The user `cd`'d into an unrelated repo and forgot to use
 *      `--repository`. Same SCOPE_VIOLATION, equally confusing.
 *
 * Both surface as actionable warnings here BEFORE the user spends a
 * session on it.
 *
 * Always `skip` or `warn`, never `fail` — this is informational. The
 * CLI still works (with `--repository`) even when this warns.
 */
async function checkGitRemoteScope(
  creds: ReturnType<typeof readCredentials>,
): Promise<CheckResult> {
  if (!creds) {
    return {
      name: 'repo scope',
      status: 'skip',
      detail: 'Skipped — not logged in.',
    };
  }
  // `readRemoteOriginUrl()` returns null for BOTH "not in a git repo" and
  // "in a git repo with no parseable github.com origin". From this
  // check's perspective both produce the same outcome: the CLI can't
  // infer a repo and the user will need `--repository` on every call.
  // Conflate the two branches into one user-facing message.
  const inferredRepoRaw = readRemoteOriginUrl();
  if (!inferredRepoRaw) {
    return {
      name: 'repo scope',
      status: 'skip',
      detail:
        'Not inside a git repo with a github.com origin — CLI commands will require `--repository owner/name`.',
    };
  }
  const inferredRepoNormalised = normaliseRepoSlug(inferredRepoRaw);
  if (inferredRepoNormalised === null) {
    return {
      name: 'repo scope',
      status: 'skip',
      detail: `Could not normalise inferred repo "${inferredRepoRaw}".`,
    };
  }
  const monitored = await fetchMonitoredRepositories(creds);
  if (monitored === null) {
    return {
      name: 'repo scope',
      status: 'skip',
      detail: `Inferred repo "${inferredRepoRaw}"; could not verify against monitored set (backend or schema issue — see backend check above).`,
    };
  }
  if (monitored.size === 0) {
    return {
      name: 'repo scope',
      status: 'skip',
      detail: `Inferred repo "${inferredRepoRaw}"; team has no recent assessments to compare against. Run a PR review or push to populate.`,
    };
  }
  if (monitored.has(inferredRepoNormalised)) {
    return {
      name: 'repo scope',
      status: 'ok',
      detail: `Inferred repo "${inferredRepoRaw}" is in the team's recently-assessed set — CLI commands will run normally.`,
    };
  }
  // Inferred repo isn't in monitored set. List a few examples of what
  // IS monitored so the user can spot a typo / stale remote quickly.
  // Sample is drawn from the normalised set — it's lowercased, which
  // matches the displayed inferred-repo value's normalisation rules.
  const sampleMonitored = Array.from(monitored).slice(0, 3).join(', ');
  return {
    name: 'repo scope',
    status: 'warn',
    detail:
      `Inferred repo "${inferredRepoRaw}" is NOT in your team's recently-assessed set ` +
      `(saw: ${sampleMonitored}${monitored.size > 3 ? `, +${monitored.size - 3} more` : ''}). ` +
      `Other CLI commands will return SCOPE_VIOLATION. ` +
      `Either run \`git remote set-url origin <canonical-url>\` if the remote is stale, ` +
      `or pass \`--repository owner/name\` explicitly.`,
  };
}

const STATUS_ICON: Record<CheckStatus, string> = {
  ok: kleur.green('✓'),
  warn: kleur.yellow('⚠'),
  fail: kleur.red('✗'),
  skip: kleur.dim('·'),
};

function renderChecks(checks: CheckResult[]): void {
  process.stdout.write('\n');
  for (const check of checks) {
    process.stdout.write(
      `  ${STATUS_ICON[check.status]} ${kleur.bold(check.name)}\n` +
        `    ${kleur.dim(check.detail)}\n`,
    );
  }
  process.stdout.write('\n');
}

function summaryExitCode(checks: CheckResult[]): number {
  const hasFail = checks.some((check) => check.status === 'fail');
  return hasFail ? ExitCodes.INTERNAL : ExitCodes.ALLOWED;
}

/**
 * `reentry doctor` — diagnostic command.
 *
 * Reports on every piece of state `reentry` depends on: credentials,
 * backend reachability, git hook, IDE agent configs, CLI version. Designed
 * for a CI step (`reentry doctor --json | jq '.checks[] | select(.status=="fail")'`)
 * as well as for interactive use.
 *
 * Never modifies state — pure read.
 */
export async function doctorCommand(options: DoctorOptions): Promise<number> {
  const checks: CheckResult[] = [];

  const credsCheck = await checkCredentials(options);
  checks.push(credsCheck.result);
  checks.push(await checkBackendReachable(credsCheck.creds, options));
  checks.push(checkGitHook(options));
  checks.push(await checkGitRemoteScope(credsCheck.creds));
  checks.push(checkAgentConfig('claude-code', options));
  checks.push(checkAgentConfig('cursor', options));
  checks.push({
    name: 'cli version',
    status: 'ok',
    detail: `reentry-cli ${CLI_VERSION}`,
  });

  if (options.json) {
    process.stdout.write(
      JSON.stringify({
        success: !checks.some((check) => check.status === 'fail'),
        version: CLI_VERSION,
        apiUrl: apiUrl(),
        checks,
      }) + '\n',
    );
  } else {
    renderChecks(checks);
  }

  return summaryExitCode(checks);
}
