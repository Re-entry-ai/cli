/**
 * Tests for `reentry doctor` — diagnostic command.
 *
 * `doctor` reads many state surfaces (credentials, git hook, agent
 * configs, backend reachability, CLI version). We mock the network
 * (callMcpTool) and the credentials store; the git-hook + agent-config
 * checks run against a real tmp dir so we exercise the actual filesystem
 * branches.
 *
 * Security focus:
 *  - JSON envelope is the CI surface. Schema must be stable.
 *  - "Credentials missing" or "credentials mode wrong" must NOT crash
 *    downstream checks — `doctor` reports every check independently.
 *  - Bearer token never appears in JSON output (we only render
 *    `creds.issuedAt`, never `creds.accessToken`).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { doctorCommand } from './doctor';
import { ExitCodes } from '../lib/exit-codes';

jest.mock('../lib/storage', () => ({
  readCredentials: jest.fn(),
  credentialsPath: jest.fn(),
}));
jest.mock('../lib/config', () => {
  const actual = jest.requireActual('../lib/config');
  return {
    ...actual,
    credentialsPath: jest.fn(),
  };
});
jest.mock('../lib/mcp-client', () => {
  const actual = jest.requireActual('../lib/mcp-client');
  return { ...actual, callMcpTool: jest.fn() };
});
// `readRemoteOriginUrl` shells out to `git remote get-url origin`. Mocking
// the module here keeps the tests pure (no real git subprocess) and lets
// each scenario drive the inferred-repo value explicitly.
jest.mock('../lib/git', () => ({
  readRemoteOriginUrl: jest.fn(),
}));

import * as storage from '../lib/storage';
import * as configModule from '../lib/config';
import * as mcpClient from '../lib/mcp-client';
import * as git from '../lib/git';

const readCredentials = storage.readCredentials as jest.MockedFunction<
  typeof storage.readCredentials
>;
const credentialsPathMock = configModule.credentialsPath as jest.MockedFunction<
  typeof configModule.credentialsPath
>;
const callMcpTool = mcpClient.callMcpTool as jest.MockedFunction<
  typeof mcpClient.callMcpTool
>;
const readRemoteOriginUrl = git.readRemoteOriginUrl as jest.MockedFunction<
  typeof git.readRemoteOriginUrl
>;

const stdoutSpy = jest
  .spyOn(process.stdout, 'write')
  .mockImplementation(() => true);
const stderrSpy = jest
  .spyOn(process.stderr, 'write')
  .mockImplementation(() => true);

const CREDS = {
  apiUrl: 'https://api.example.test',
  accessToken: 'mcp_re_secret_token',
  issuedAt: '2026-05-11T10:00:00.000Z',
};

let prevCwd: string;
let tmpRoot: string;
let credsFile: string;

function writeCredsFile(perms: number): void {
  fs.mkdirSync(path.dirname(credsFile), { recursive: true });
  fs.writeFileSync(credsFile, JSON.stringify(CREDS), { mode: perms });
  fs.chmodSync(credsFile, perms);
}

beforeEach(() => {
  prevCwd = process.cwd();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reentry-doctor-'));
  process.chdir(tmpRoot);
  credsFile = path.join(tmpRoot, 'reentry', 'credentials.json');
  credentialsPathMock.mockReturnValue(credsFile);
  stdoutSpy.mockClear();
  stderrSpy.mockClear();
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  readCredentials.mockReset();
  callMcpTool.mockReset();
  credentialsPathMock.mockReset();
  readRemoteOriginUrl.mockReset();
});

describe('doctorCommand — JSON output', () => {
  it('reports credentials.status=fail when not logged in (other checks still run)', async () => {
    readCredentials.mockReturnValue(null);

    const code = await doctorCommand({ json: true });
    expect(code).toBe(ExitCodes.INTERNAL); // any FAIL → non-zero

    const output = stdoutSpy.mock.calls.map((call) => call[0]).join('').trim();
    const parsed = JSON.parse(output);
    expect(parsed.success).toBe(false);
    const credsCheck = parsed.checks.find(
      (check: { name: string }) => check.name === 'credentials',
    );
    expect(credsCheck.status).toBe('fail');
    // Backend check skipped because no token; doctor doesn't abort.
    const backendCheck = parsed.checks.find(
      (check: { name: string }) => check.name === 'backend',
    );
    expect(backendCheck.status).toBe('skip');
  });

  it('reports credentials.status=ok when token is present and file mode is 0600', async () => {
    readCredentials.mockReturnValue(CREDS);
    writeCredsFile(0o600);
    callMcpTool.mockResolvedValue({ policies: [] });

    const code = await doctorCommand({ json: true });
    expect(code).toBe(ExitCodes.ALLOWED);

    const output = stdoutSpy.mock.calls.map((call) => call[0]).join('').trim();
    const parsed = JSON.parse(output);
    const credsCheck = parsed.checks.find(
      (check: { name: string }) => check.name === 'credentials',
    );
    expect(credsCheck.status).toBe('ok');
  });

  it('flags credentials with overly-loose file mode as warn', async () => {
    readCredentials.mockReturnValue(CREDS);
    writeCredsFile(0o644);
    callMcpTool.mockResolvedValue({ policies: [] });

    await doctorCommand({ json: true });

    const output = stdoutSpy.mock.calls.map((call) => call[0]).join('').trim();
    const parsed = JSON.parse(output);
    const credsCheck = parsed.checks.find(
      (check: { name: string }) => check.name === 'credentials',
    );
    expect(credsCheck.status).toBe('warn');
    expect(credsCheck.detail).toContain('0644');
  });

  it('reports backend.status=fail when the MCP probe throws', async () => {
    readCredentials.mockReturnValue(CREDS);
    writeCredsFile(0o600);
    callMcpTool.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const code = await doctorCommand({ json: true });
    expect(code).toBe(ExitCodes.INTERNAL);

    const output = stdoutSpy.mock.calls.map((call) => call[0]).join('').trim();
    const parsed = JSON.parse(output);
    const backendCheck = parsed.checks.find(
      (check: { name: string }) => check.name === 'backend',
    );
    expect(backendCheck.status).toBe('fail');
    expect(backendCheck.detail).toContain('connect ECONNREFUSED');
  });

  it('NEVER includes the bearer token in JSON output', async () => {
    readCredentials.mockReturnValue(CREDS);
    writeCredsFile(0o600);
    callMcpTool.mockResolvedValue({ policies: [] });

    await doctorCommand({ json: true });

    const output = stdoutSpy.mock.calls.map((call) => call[0]).join('').trim();
    expect(output).not.toContain('mcp_re_secret_token');
    // Sanity: the issuedAt timestamp IS present (so callers can see token age).
    expect(output).toContain('2026-05-11T10:00:00.000Z');
  });

  it('includes the cli version in the JSON envelope', async () => {
    readCredentials.mockReturnValue(CREDS);
    writeCredsFile(0o600);
    callMcpTool.mockResolvedValue({ policies: [] });

    await doctorCommand({ json: true });

    const output = stdoutSpy.mock.calls.map((call) => call[0]).join('').trim();
    const parsed = JSON.parse(output);
    expect(parsed.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('doctorCommand — repo scope check', () => {
  // Tests for the 7th check added to catch git-remote drift. Without it,
  // users hit confusing SCOPE_VIOLATION errors with no obvious clue that
  // `git remote -v` is the culprit (the typical cause is a repo rename
  // / org transfer; redirects keep pushes working but every MCP call
  // sends the stale slug). All branches must report `skip` or `warn`,
  // never `fail` — doctor is informational, not a gate.

  /** Helper: route mock to the right response per MCP tool. */
  function mockMcpRouter(routes: Record<string, unknown>) {
    callMcpTool.mockImplementation(((toolName: string) => {
      if (toolName in routes) {
        return Promise.resolve(routes[toolName]);
      }
      return Promise.reject(new Error(`unmocked tool: ${toolName}`));
    }) as unknown as typeof mcpClient.callMcpTool);
  }

  function findRepoCheck(stdout: string): { status: string; detail: string } {
    const parsed = JSON.parse(stdout);
    return parsed.checks.find(
      (check: { name: string }) => check.name === 'repo scope',
    );
  }

  it('reports repo scope = skip when not logged in', async () => {
    readCredentials.mockReturnValue(null);

    await doctorCommand({ json: true });
    const output = stdoutSpy.mock.calls.map((call) => call[0]).join('').trim();
    const repoCheck = findRepoCheck(output);
    expect(repoCheck.status).toBe('skip');
    expect(repoCheck.detail).toContain('not logged in');
  });

  it('reports repo scope = skip when there is no github.com origin', async () => {
    readCredentials.mockReturnValue(CREDS);
    writeCredsFile(0o600);
    readRemoteOriginUrl.mockReturnValue(null);
    mockMcpRouter({
      get_team_rules: { policies: [] },
      list_recent_assessments: { items: [{ repository: 'team/repo' }] },
    });

    await doctorCommand({ json: true });
    const output = stdoutSpy.mock.calls.map((call) => call[0]).join('').trim();
    const repoCheck = findRepoCheck(output);
    expect(repoCheck.status).toBe('skip');
    expect(repoCheck.detail).toContain('--repository');
  });

  it('reports repo scope = warn when inferred repo is NOT in monitored set', async () => {
    readCredentials.mockReturnValue(CREDS);
    writeCredsFile(0o600);
    readRemoteOriginUrl.mockReturnValue('wrong/stale-repo');
    mockMcpRouter({
      get_team_rules: { policies: [] },
      list_recent_assessments: {
        items: [
          { repository: 'team/repo-a' },
          { repository: 'team/repo-b' },
        ],
      },
    });

    await doctorCommand({ json: true });
    const output = stdoutSpy.mock.calls.map((call) => call[0]).join('').trim();
    const repoCheck = findRepoCheck(output);
    expect(repoCheck.status).toBe('warn');
    expect(repoCheck.detail).toContain('wrong/stale-repo');
    expect(repoCheck.detail).toContain('SCOPE_VIOLATION');
    // The sample of monitored repos must be present so the user can
    // spot a typo / stale remote at a glance.
    expect(repoCheck.detail).toContain('team/repo-a');
  });

  it('normalises case + `.git` suffix differences when comparing inferred repo to monitored set', async () => {
    // Real-world drift: git remote often returns `Owner/Repo.git`
    // (mixed case + suffix) while the backend persists `owner/repo`
    // (lowercased). Without normalisation this combination silently
    // warns despite the repo being monitored — the worst kind of
    // bug because the user has no clue why doctor disagrees with
    // every other command.
    readCredentials.mockReturnValue(CREDS);
    writeCredsFile(0o600);
    readRemoteOriginUrl.mockReturnValue('Team/Repo-A.git');
    mockMcpRouter({
      get_team_rules: { policies: [] },
      list_recent_assessments: {
        items: [{ repository: 'team/repo-a' }],
      },
    });

    await doctorCommand({ json: true });
    const output = stdoutSpy.mock.calls.map((call) => call[0]).join('').trim();
    const repoCheck = findRepoCheck(output);
    expect(repoCheck.status).toBe('ok');
    // Detail must echo the RAW remote string back to the user
    // (so they recognise their config), not the normalised form.
    expect(repoCheck.detail).toContain('Team/Repo-A.git');
  });

  it('reports repo scope = warn with a +N-more suffix when the team has many monitored repos', async () => {
    readCredentials.mockReturnValue(CREDS);
    writeCredsFile(0o600);
    readRemoteOriginUrl.mockReturnValue('wrong/stale-repo');
    mockMcpRouter({
      get_team_rules: { policies: [] },
      list_recent_assessments: {
        items: [
          { repository: 'team/repo-a' },
          { repository: 'team/repo-b' },
          { repository: 'team/repo-c' },
          { repository: 'team/repo-d' },
          { repository: 'team/repo-e' },
        ],
      },
    });

    await doctorCommand({ json: true });
    const output = stdoutSpy.mock.calls.map((call) => call[0]).join('').trim();
    const repoCheck = findRepoCheck(output);
    expect(repoCheck.status).toBe('warn');
    // 5 unique repos, sample shows 3, so we expect "+2 more".
    expect(repoCheck.detail).toContain('+2 more');
  });

  it('reports repo scope = ok when inferred repo IS in monitored set', async () => {
    readCredentials.mockReturnValue(CREDS);
    writeCredsFile(0o600);
    readRemoteOriginUrl.mockReturnValue('team/repo-a');
    mockMcpRouter({
      get_team_rules: { policies: [] },
      list_recent_assessments: {
        items: [
          { repository: 'team/repo-a' },
          { repository: 'team/repo-b' },
        ],
      },
    });

    await doctorCommand({ json: true });
    const output = stdoutSpy.mock.calls.map((call) => call[0]).join('').trim();
    const repoCheck = findRepoCheck(output);
    expect(repoCheck.status).toBe('ok');
    expect(repoCheck.detail).toContain('team/repo-a');
  });

  it('reports repo scope = skip when the backend assessments call fails (never fail — doctor is informational)', async () => {
    readCredentials.mockReturnValue(CREDS);
    writeCredsFile(0o600);
    readRemoteOriginUrl.mockReturnValue('team/repo-a');
    // get_team_rules succeeds (so the prior backend check is OK and we
    // still reach the repo-scope branch), list_recent_assessments
    // throws → checkGitRemoteScope catches → null → skip.
    mockMcpRouter({
      get_team_rules: { policies: [] },
    });

    await doctorCommand({ json: true });
    const output = stdoutSpy.mock.calls.map((call) => call[0]).join('').trim();
    const repoCheck = findRepoCheck(output);
    expect(repoCheck.status).toBe('skip');
  });

  it('reports repo scope = skip when team has no recent assessments', async () => {
    readCredentials.mockReturnValue(CREDS);
    writeCredsFile(0o600);
    readRemoteOriginUrl.mockReturnValue('team/repo-a');
    mockMcpRouter({
      get_team_rules: { policies: [] },
      list_recent_assessments: { items: [] },
    });

    await doctorCommand({ json: true });
    const output = stdoutSpy.mock.calls.map((call) => call[0]).join('').trim();
    const repoCheck = findRepoCheck(output);
    expect(repoCheck.status).toBe('skip');
    expect(repoCheck.detail).toContain('no recent assessments');
  });
});

describe('doctorCommand — exit code summary', () => {
  it('returns 0 when every check is ok / warn / skip', async () => {
    readCredentials.mockReturnValue(CREDS);
    writeCredsFile(0o600);
    callMcpTool.mockResolvedValue({ policies: [] });

    const code = await doctorCommand({ json: true });
    expect(code).toBe(ExitCodes.ALLOWED);
  });

  it('returns INTERNAL (non-zero) on any fail check (CI-friendly)', async () => {
    readCredentials.mockReturnValue(null);

    const code = await doctorCommand({ json: true });
    expect(code).toBe(ExitCodes.INTERNAL);
  });
});
