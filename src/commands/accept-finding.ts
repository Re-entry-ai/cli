import kleur from 'kleur';
import { ExitCodes } from '../lib/exit-codes';
import { readCredentials } from '../lib/storage';
import { readRemoteOriginUrl } from '../lib/git';
import { callMcpTool } from '../lib/mcp-client';
import { handleMcpError } from './pre-commit';
import { safeText } from '../lib/safe-print';

interface AcceptFindingOptions {
  json?: boolean;
  reason?: string;
  repository?: string;
  expires?: string;
  teamWide?: boolean;
}

interface AcceptFindingApiResponse {
  id: string;
  findingId: string;
  acceptedAt: string;
  rationale: string;
}

function emitUsage(message: string, options: AcceptFindingOptions): void {
  if (options.json) {
    process.stdout.write(
      JSON.stringify({ success: false, code: 'USAGE', message }) + '\n',
    );
    return;
  }
  process.stderr.write(`${kleur.red('error:')} ${message}\n`);
}

/**
 * `reentry accept-finding <findingId> --reason "..." [--team-wide] [--repository owner/name] [--expires <ISO>]`
 *
 * Marks a risk-engine finding "considered and accepted" so future
 * gate runs (pre-commit, PR review) suppress it. Use this when the
 * LLM reviewer keeps re-flagging a design-philosophy preference the
 * team has already decided on — accepting it stops the iteration loop.
 *
 * Default scope is repo-scoped (uses `git remote` to infer
 * `owner/name`). Pass `--team-wide` to apply the acceptance across
 * every repo in the team (useful for general design-philosophy
 * preferences that aren't repo-specific).
 *
 * Accepted findings still appear in subsequent gate responses under
 * `acceptedFindings` for full audit transparency — they're suppressed
 * from the scoring path, not silently hidden. The dashboard surfaces
 * "this was accepted on X by Y because Z" for governance review.
 */
export async function acceptFindingCommand(
  findingIdArg: string,
  options: AcceptFindingOptions,
): Promise<number> {
  const creds = readCredentials();
  if (!creds) {
    if (options.json) {
      process.stdout.write(
        JSON.stringify({
          success: false,
          code: 'AUTH',
          message: 'Not logged in. Run `reentry login`.',
        }) + '\n',
      );
    } else {
      process.stderr.write(
        `${kleur.red('error:')} Not logged in. Run \`reentry login\`.\n`,
      );
    }
    return ExitCodes.AUTH;
  }

  // Validate findingId at the boundary so the user gets a fast,
  // actionable error instead of a generic 400 from the backend.
  const findingId: string = findingIdArg.trim();
  if (findingId.length !== 16 || !/^[0-9a-f]+$/i.test(findingId)) {
    emitUsage(
      `findingId must be the 16-char hex hash emitted by the gate (got "${findingId.slice(0, 32)}"). Copy it from a recent \`reentry pre-commit\` or \`reentry review\` output.`,
      options,
    );
    return ExitCodes.USAGE;
  }

  const reason: string = (options.reason ?? '').trim();
  if (reason.length === 0) {
    emitUsage(
      '--reason "<explanation>" is required. The rationale is recorded in the audit trail along with your identity + timestamp.',
      options,
    );
    return ExitCodes.USAGE;
  }
  if (reason.length > 1000) {
    emitUsage(
      `--reason must be 1000 chars or fewer (got ${reason.length}). Tighten the explanation.`,
      options,
    );
    return ExitCodes.USAGE;
  }

  // Repository resolution. Three precedence rules, top wins:
  //   --team-wide flag → unscoped (apply to every repo in the team)
  //   --repository <slug> → explicit scope
  //   `git remote` inference → default to the current repo
  // The user must EXPLICITLY opt into team-wide to avoid accidentally
  // suppressing a finding everywhere when they meant just-this-repo.
  let repository: string | undefined;
  if (options.teamWide === true) {
    if (options.repository !== undefined) {
      emitUsage(
        '--team-wide and --repository are mutually exclusive. Pick one scope.',
        options,
      );
      return ExitCodes.USAGE;
    }
    repository = undefined;
  } else if (options.repository !== undefined) {
    repository = options.repository;
  } else {
    const inferred = readRemoteOriginUrl();
    if (!inferred) {
      emitUsage(
        'Could not infer repository from `git remote`. Pass `--repository owner/name` explicitly or `--team-wide` to apply across every repo in the team.',
        options,
      );
      return ExitCodes.USAGE;
    }
    repository = inferred;
  }

  // expiresAt validation: STRICT ISO-8601 only. `new Date(string)` is
  // lenient and accepts ambiguous formats like "2026-01-01" or
  // "2026/01/01 EST" — but those have unstable timezone interpretation
  // across Node versions, which would let the user think they passed
  // a UTC date and quietly get a local-time one. The regex enforces a
  // canonical RFC-3339 / ISO-8601 shape: YYYY-MM-DDTHH:MM:SS(.sss)?
  // followed by `Z` or an explicit `±HH:MM` offset.
  let expiresAt: string | undefined;
  if (options.expires !== undefined && options.expires.trim().length > 0) {
    const isoStrict: RegExp =
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
    const raw: string = options.expires.trim();
    if (!isoStrict.test(raw)) {
      emitUsage(
        `--expires must be a strict ISO-8601 timestamp with explicit timezone (got "${options.expires}"). Try e.g. "2026-12-31T00:00:00Z" or "2026-12-31T00:00:00+00:00".`,
        options,
      );
      return ExitCodes.USAGE;
    }
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      emitUsage(
        `--expires parsed to an invalid date (got "${options.expires}"). Try e.g. "2026-12-31T00:00:00Z".`,
        options,
      );
      return ExitCodes.USAGE;
    }
    if (parsed.getTime() <= Date.now()) {
      emitUsage(
        '--expires must be in the future. Pass a date past now or omit for a permanent acceptance.',
        options,
      );
      return ExitCodes.USAGE;
    }
    expiresAt = parsed.toISOString();
  }

  try {
    const result = await callMcpTool<AcceptFindingApiResponse>(
      'accept_finding',
      {
        findingId,
        rationale: reason,
        ...(repository !== undefined ? { repository } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      },
      creds.accessToken,
    );

    if (options.json) {
      process.stdout.write(
        JSON.stringify({ success: true, ...result }) + '\n',
      );
      return ExitCodes.ALLOWED;
    }

    renderAcceptance(result, repository, expiresAt);
    return ExitCodes.ALLOWED;
  } catch (err) {
    return handleMcpError(err, 'accept finding', { json: options.json });
  }
}

function renderAcceptance(
  response: AcceptFindingApiResponse,
  repository: string | undefined,
  expiresAt: string | undefined,
): void {
  const scope: string =
    repository === undefined ? 'team-wide (all repos)' : repository;
  const safeRationale: string = safeText(response.rationale);
  process.stdout.write('\n');
  process.stdout.write(
    `  ${kleur.green('✓')} Accepted finding ${kleur.dim(response.findingId)}\n`,
  );
  process.stdout.write(
    `    ${kleur.dim('Scope:')}     ${kleur.bold(scope)}\n`,
  );
  process.stdout.write(
    `    ${kleur.dim('Rationale:')} ${safeRationale}\n`,
  );
  if (expiresAt !== undefined) {
    process.stdout.write(
      `    ${kleur.dim('Expires:')}   ${expiresAt}\n`,
    );
  }
  process.stdout.write(
    `\n  ${kleur.dim('Future gate runs will suppress this finding in scope and emit it under `acceptedFindings` for audit.')}\n\n`,
  );
}
