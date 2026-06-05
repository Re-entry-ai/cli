import kleur from 'kleur';
import select from '@inquirer/select';
import input from '@inquirer/input';
import { ExitCodes } from './exit-codes';
import {
  readCurrentBranch,
  readBaseBranch,
  countFilesChangedVsBase,
  readRepoRoot,
} from './git';
import { preCommitCommand } from '../commands/pre-commit';
import { statusCommand } from '../commands/status';
import { reviewCommand } from '../commands/review';
import { rulesCommand } from '../commands/rules';

/**
 * Context the welcome screen needs to render its header. Every field is
 * nullable — if `git` is missing or we're outside a repo, the header lines
 * that depend on that field are simply omitted.
 */
export interface WelcomeContext {
  repoRoot: string | null;
  currentBranch: string | null;
  baseBranch: string | null;
  filesChanged: number | null;
}

interface ShouldRenderArgs {
  json: boolean | undefined;
}

/**
 * Gate for the cubic-style welcome. We only render it in an interactive
 * terminal where the user can actually use the arrow keys. CI, pipes,
 * redirects, and `--json` get the legacy non-interactive output.
 */
export function shouldRenderWelcome(args: ShouldRenderArgs): boolean {
  if (args.json) {
    return false;
  }
  if (process.env.CI === 'true') {
    return false;
  }
  if (!process.stdout.isTTY) {
    return false;
  }
  return true;
}

export function readWelcomeContext(): WelcomeContext {
  const baseBranch = readBaseBranch();
  return {
    repoRoot: readRepoRoot(),
    currentBranch: readCurrentBranch(),
    baseBranch,
    filesChanged: baseBranch ? countFilesChangedVsBase(baseBranch) : null,
  };
}

// Hand-rolled infinity-loop logo. The "infinite loop" alludes to the
// agentic dev cycle re-entry governs. Block characters keep the chunky
// pixel feel of cubic without pulling in a font library (cfonts is GPL).
const LOGO_LINES: ReadonlyArray<string> = [
  '    ████        ████    ',
  '  ██    ██    ██    ██  ',
  ' ██       ████       ██ ',
  '  ██    ██    ██    ██  ',
  '    ████        ████    ',
];
const LOGO_WIDTH = LOGO_LINES[0].length;

/**
 * Render the chunky-block "reentry" logo + dimmed version line, centered
 * to the current terminal width. The glyphs are hand-typed Unicode blocks
 * so the rendering needs no font library or color codes — works in any
 * UTF-8 terminal, including NO_COLOR / monochrome ones.
 */
export function renderLogo(version: string): void {
  const padding = ' '.repeat(computeCenterPadding(LOGO_WIDTH));
  process.stdout.write('\n');
  for (const line of LOGO_LINES) {
    process.stdout.write(`${padding}${line}\n`);
  }
  process.stdout.write('\n');
  const versionLabel = `v${version}`;
  const versionPadding = ' '.repeat(computeCenterPadding(versionLabel.length));
  process.stdout.write(`${versionPadding}${kleur.dim(versionLabel)}\n`);
  process.stdout.write('\n');
}

/**
 * Render the header block under the logo:
 *   Repo:       /path/to/repo
 *   Comparing:  branch → base (base)
 *   📦  N files changed
 *
 *   AI code review + agent governance
 *
 * Missing context fields collapse cleanly — outside a git repo, only the
 * tagline remains.
 */
export function renderHeader(ctx: WelcomeContext): void {
  const indent = '         ';
  if (ctx.repoRoot) {
    process.stdout.write(
      `${indent}${kleur.dim('Repo:')}        ${ctx.repoRoot}\n`,
    );
  }
  if (ctx.currentBranch && ctx.baseBranch) {
    process.stdout.write(
      `${indent}${kleur.dim('Comparing:')}   ${ctx.currentBranch} ${kleur.dim('→')} ${ctx.baseBranch} ${kleur.dim('(base)')}\n`,
    );
  }
  if (ctx.filesChanged !== null) {
    process.stdout.write(
      `${indent}${kleur.dim('📦')}  ${ctx.filesChanged} files changed\n`,
    );
  }
  process.stdout.write('\n');
  process.stdout.write(
    `${indent}${kleur.bold('AI code review + agent governance')}\n`,
  );
  process.stdout.write('\n');
}

type PresetChoice = 'pre-commit' | 'status' | 'review' | 'rules';

/**
 * Show the four-option preset menu and run the chosen command in-process.
 * The selected command's exit code is returned so `init` propagates it
 * (matters for tests; never reaches CI because the welcome only renders
 * in interactive TTYs).
 */
export async function runReviewPresetMenu(): Promise<number> {
  let choice: PresetChoice;
  try {
    choice = await select<PresetChoice>({
      message: 'Select a review preset',
      choices: [
        {
          name: '1. Review staged changes (pre-commit)',
          value: 'pre-commit',
          description:
            'Run the same risk check your git hook runs, against your staged diff.',
        },
        {
          name: '2. Show governance verdict for this branch',
          value: 'status',
          description:
            'Ask the backend whether this branch would be allowed, blocked, or needs human review.',
        },
        {
          name: '3. Review a specific PR',
          value: 'review',
          description:
            'Full LLM code review for a PR number — same content as the dashboard panel.',
        },
        {
          name: '4. Show team guards',
          value: 'rules',
          description:
            'Show the active policies and high-risk patterns your team has configured.',
        },
      ],
    });
  } catch (err) {
    if (isExitPromptError(err)) {
      return ExitCodes.ALLOWED;
    }
    throw err;
  }

  process.stdout.write('\n');

  if (choice === 'pre-commit') {
    return preCommitCommand({ json: false });
  }
  if (choice === 'status') {
    return statusCommand(undefined, { json: false });
  }
  if (choice === 'review') {
    return runReviewPreset();
  }
  return rulesCommand({ json: false });
}

async function runReviewPreset(): Promise<number> {
  let prNumber: string;
  try {
    prNumber = await input({
      message: 'PR number:',
      validate: (raw: string) => {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          return 'Enter a positive integer.';
        }
        return true;
      },
    });
  } catch (err) {
    if (isExitPromptError(err)) {
      return ExitCodes.ALLOWED;
    }
    throw err;
  }
  process.stdout.write('\n');
  return reviewCommand(prNumber, { json: false });
}

function isExitPromptError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') {
    return false;
  }
  const name = (err as { name?: unknown }).name;
  return name === 'ExitPromptError';
}

function computeCenterPadding(textLength: number): number {
  const width = process.stdout.columns || 80;
  return Math.max(0, Math.floor((width - textLength) / 2));
}
