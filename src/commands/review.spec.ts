/**
 * Tests for the `reentry review <pr-number>` command.
 *
 * Security focus:
 *  - Auth gate before any network call.
 *  - PR number must be a positive integer.
 *  - --repository or git origin must resolve before backend contact.
 *  - LLM-derived fields (aiSummary, aiKeyFindings, inlineComments[].body)
 *    must flow through `safeText` so ANSI / control chars never reach
 *    the terminal.
 */

import kleur from 'kleur';
import { reviewCommand } from './review';
import { ExitCodes } from '../lib/exit-codes';

// Disable kleur colors for all tests in this file. These tests assert on
// content correctness, not presentation — and the sanitization test must
// not see escape codes from kleur itself, only from LLM-injected strings.
beforeAll(() => { kleur.enabled = false; });
afterAll(() => { kleur.enabled = true; });

jest.mock('../lib/storage', () => ({ readCredentials: jest.fn() }));
jest.mock('../lib/git', () => ({ readRemoteOriginUrl: jest.fn() }));
jest.mock('../lib/mcp-client', () => {
  const actual = jest.requireActual('../lib/mcp-client');
  return { ...actual, callMcpTool: jest.fn() };
});

import * as storage from '../lib/storage';
import * as git from '../lib/git';
import * as mcpClient from '../lib/mcp-client';

const readCredentials = storage.readCredentials as jest.MockedFunction<
  typeof storage.readCredentials
>;
const readRemoteOriginUrl = git.readRemoteOriginUrl as jest.MockedFunction<
  typeof git.readRemoteOriginUrl
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
  accessToken: 'mcp_re_test',
  issuedAt: '2026-05-11T10:00:00.000Z',
};

const VALID_RESPONSE = {
  prId: 'pr-id-42',
  repository: 'acme/api',
  prNumber: 42,
  prTitle: 'Add admin bypass',
  prAuthor: 'developer',
  branch: 'feature/admin',
  riskScore: 76,
  riskLevel: 'high',
  summary: 'Auth surface modification',
  aiSummary: 'Bypasses auth on admin path',
  aiKeyFindings: ['Hardcoded admin token at src/auth/login.ts:3'],
  aiSuggestions: ['Use env var'],
  inlineComments: [
    {
      path: 'src/auth/login.ts',
      line: 3,
      body: 'Token is hardcoded',
      severity: 'critical' as const,
    },
  ],
  crossFileFindings: [],
  assessedAt: '2026-05-11T09:00:00.000Z',
  dashboardUrl: 'https://re-entry.ai/dashboard',
};

afterEach(() => {
  stdoutSpy.mockClear();
  stderrSpy.mockClear();
  readCredentials.mockReset();
  readRemoteOriginUrl.mockReset();
  callMcpTool.mockReset();
});

describe('reviewCommand — auth gate', () => {
  it('returns AUTH and never calls MCP when not logged in', async () => {
    readCredentials.mockReturnValue(null);
    const code = await reviewCommand('42', {});
    expect(code).toBe(ExitCodes.AUTH);
    expect(callMcpTool).not.toHaveBeenCalled();
  });
});

describe('reviewCommand — input validation', () => {
  beforeEach(() => readCredentials.mockReturnValue(CREDS));

  it('returns USAGE when no repository and no git origin can be resolved', async () => {
    readRemoteOriginUrl.mockReturnValue(null);
    const code = await reviewCommand('42', { json: true });
    expect(code).toBe(ExitCodes.USAGE);
    expect(callMcpTool).not.toHaveBeenCalled();
  });

  it('rejects non-numeric PR numbers', async () => {
    readRemoteOriginUrl.mockReturnValue('acme/api');
    const code = await reviewCommand('not-a-number', { json: true });
    expect(code).toBe(ExitCodes.USAGE);
  });

  it('rejects PR number 0 or negative', async () => {
    readRemoteOriginUrl.mockReturnValue('acme/api');
    expect(await reviewCommand('0', { json: true })).toBe(ExitCodes.USAGE);
    expect(await reviewCommand('-1', { json: true })).toBe(ExitCodes.USAGE);
  });

  it('auto-detects repository from git origin', async () => {
    readRemoteOriginUrl.mockReturnValue('acme/api');
    callMcpTool.mockResolvedValue(VALID_RESPONSE);

    await reviewCommand('42', { json: true });

    expect(callMcpTool).toHaveBeenCalledWith(
      'get_pr_code_review',
      { repository: 'acme/api', prNumber: 42 },
      'mcp_re_test',
    );
  });

  it('prefers --repository over git origin', async () => {
    readRemoteOriginUrl.mockReturnValue('different/repo');
    callMcpTool.mockResolvedValue(VALID_RESPONSE);

    await reviewCommand('42', { json: true, repository: 'acme/api' });

    expect(callMcpTool).toHaveBeenCalledWith(
      'get_pr_code_review',
      { repository: 'acme/api', prNumber: 42 },
      'mcp_re_test',
    );
  });
});

describe('reviewCommand — text rendering', () => {
  beforeEach(() => {
    readCredentials.mockReturnValue(CREDS);
    readRemoteOriginUrl.mockReturnValue('acme/api');
  });

  it('sanitizes LLM-derived fields before printing', async () => {
    callMcpTool.mockResolvedValue({
      ...VALID_RESPONSE,
      aiSummary: '\x1b[31mred\x1b[0m summary text',
      aiKeyFindings: ['plain finding', '\x07bell injection'],
      inlineComments: [
        {
          path: 'src/foo.ts',
          line: 12,
          body: '\x1b]8;;https://attacker.example.com\x07disguised\x1b]8;;\x07 link',
          severity: 'warning' as const,
        },
      ],
    });

    const code = await reviewCommand('42', {});
    expect(code).toBe(ExitCodes.ALLOWED);

    const output = stdoutSpy.mock.calls.map((args) => args[0]).join('');
    expect(output).not.toContain('\x1b');
    expect(output).not.toContain('\x07');
    expect(output).not.toContain('attacker.example.com');
    expect(output).toContain('red summary text');
    expect(output).toContain('disguised link');
  });
});

describe('reviewCommand — JSON mode', () => {
  it('emits the raw response without rendering', async () => {
    readCredentials.mockReturnValue(CREDS);
    readRemoteOriginUrl.mockReturnValue('acme/api');
    callMcpTool.mockResolvedValue(VALID_RESPONSE);

    const code = await reviewCommand('42', { json: true });
    expect(code).toBe(ExitCodes.ALLOWED);

    const output = stdoutSpy.mock.calls.map((args) => args[0]).join('').trim();
    const parsed = JSON.parse(output);
    expect(parsed.prNumber).toBe(42);
    expect(parsed.riskLevel).toBe('high');
  });
});
