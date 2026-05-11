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

import * as storage from '../lib/storage';
import * as configModule from '../lib/config';
import * as mcpClient from '../lib/mcp-client';

const readCredentials = storage.readCredentials as jest.MockedFunction<
  typeof storage.readCredentials
>;
const credentialsPathMock = configModule.credentialsPath as jest.MockedFunction<
  typeof configModule.credentialsPath
>;
const callMcpTool = mcpClient.callMcpTool as jest.MockedFunction<
  typeof mcpClient.callMcpTool
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
