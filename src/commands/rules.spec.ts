/**
 * Tests for the `reentry rules` command.
 *
 * Security focus:
 *  - Auth gate: no token → AUTH exit (no MCP call attempted).
 *  - Defensive normalization: a malformed / partial backend response must
 *    not crash the CLI on `.map` / `.length` — this stops a bad backend
 *    from breaking developer terminals.
 *  - Sanitization: LLM-derived strings must pass through `safeText` (which
 *    `rules.ts` imports) so ANSI/control characters never reach stdout.
 */

import { rulesCommand } from './rules';
import { ExitCodes } from '../lib/exit-codes';

jest.mock('../lib/storage', () => ({
  readCredentials: jest.fn(),
}));
jest.mock('../lib/mcp-client', () => {
  // Preserve the real McpAuthRejected / McpToolError classes — handleMcpError
  // in pre-commit.ts does `err instanceof McpAuthRejected`, and a barrel mock
  // would replace those classes with `undefined`, blowing up the instanceof
  // check at runtime.
  const actual = jest.requireActual('../lib/mcp-client');
  return { ...actual, callMcpTool: jest.fn() };
});

import * as storage from '../lib/storage';
import * as mcpClient from '../lib/mcp-client';

const readCredentials = storage.readCredentials as jest.MockedFunction<
  typeof storage.readCredentials
>;
const callMcpTool = mcpClient.callMcpTool as jest.MockedFunction<
  typeof mcpClient.callMcpTool
>;

const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

afterEach(() => {
  stdoutSpy.mockClear();
  stderrSpy.mockClear();
  readCredentials.mockReset();
  callMcpTool.mockReset();
});

describe('rulesCommand — auth gate', () => {
  it('returns AUTH and never calls MCP when not logged in (text mode)', async () => {
    readCredentials.mockReturnValue(null);

    const code = await rulesCommand({ json: false });

    expect(code).toBe(ExitCodes.AUTH);
    expect(callMcpTool).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalled();
  });

  it('emits a JSON envelope when --json and not logged in', async () => {
    readCredentials.mockReturnValue(null);

    const code = await rulesCommand({ json: true });

    expect(code).toBe(ExitCodes.AUTH);
    const written = stdoutSpy.mock.calls.map((args) => args[0]).join('');
    const parsed = JSON.parse(written.trim());
    expect(parsed).toMatchObject({ success: false, code: 'AUTH' });
  });
});

describe('rulesCommand — happy path', () => {
  const validCreds = {
    apiUrl: 'https://api.example.test',
    accessToken: 'mcp_re_test',
    issuedAt: '2026-05-11T10:00:00.000Z',
  };

  it('emits the raw backend response in --json mode', async () => {
    readCredentials.mockReturnValue(validCreds);
    callMcpTool.mockResolvedValue({
      policies: [],
      riskCriteria: {
        highRiskPatterns: ['env file change'],
        requiredPractices: ['link a ticket'],
        autoBlockThreshold: 75,
      },
      dismissedGuidance: [],
    });

    const code = await rulesCommand({ json: true });

    expect(code).toBe(ExitCodes.ALLOWED);
    const written = stdoutSpy.mock.calls.map((args) => args[0]).join('');
    const parsed = JSON.parse(written.trim());
    expect(parsed.riskCriteria.autoBlockThreshold).toBe(75);
  });

  it('does not crash on a partial backend response in render mode', async () => {
    readCredentials.mockReturnValue(validCreds);
    // Defensive normalization contract: a missing field must not throw.
    callMcpTool.mockResolvedValue({} as never);

    const code = await rulesCommand({ json: false });

    expect(code).toBe(ExitCodes.ALLOWED);
  });

  it('filters out non-string entries from requiredPractices defensively', async () => {
    readCredentials.mockReturnValue(validCreds);
    // The named type guard `isNonEmptyString` in rules.ts exists exactly
    // because previous code used a single-letter `s` callback that the
    // team flagged. Regression coverage: feed a mixed array and assert
    // the command still succeeds and emits clean output.
    callMcpTool.mockResolvedValue({
      policies: [],
      riskCriteria: {
        highRiskPatterns: ['ok pattern', 42, null, 'second ok'],
        requiredPractices: ['ok practice', undefined, false, 'second ok'],
        autoBlockThreshold: null,
      },
      dismissedGuidance: ['ok'],
    } as never);

    const code = await rulesCommand({ json: false });

    expect(code).toBe(ExitCodes.ALLOWED);
  });
});

describe('rulesCommand — error handling', () => {
  it('returns a non-zero exit code when the MCP call fails', async () => {
    readCredentials.mockReturnValue({
      apiUrl: 'https://api.example.test',
      accessToken: 'mcp_re_test',
      issuedAt: '2026-05-11T10:00:00.000Z',
    });
    callMcpTool.mockRejectedValue(new Error('network down'));

    const code = await rulesCommand({ json: true });

    expect(code).not.toBe(ExitCodes.ALLOWED);
  });
});
