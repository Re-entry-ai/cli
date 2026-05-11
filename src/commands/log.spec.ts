/**
 * Tests for the `reentry log` command.
 *
 * Security focus:
 *  - Auth gate before any network call.
 *  - Input validation: --limit, --offset, --kind enforced client-side
 *    so a bad value doesn't reach the backend.
 *  - JSON envelope shape stable for CI consumers.
 */

import { logCommand } from './log';
import { ExitCodes } from '../lib/exit-codes';

jest.mock('../lib/storage', () => ({ readCredentials: jest.fn() }));
jest.mock('../lib/mcp-client', () => {
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

afterEach(() => {
  stdoutSpy.mockClear();
  stderrSpy.mockClear();
  readCredentials.mockReset();
  callMcpTool.mockReset();
});

describe('logCommand — auth gate', () => {
  it('returns AUTH and never calls MCP when not logged in', async () => {
    readCredentials.mockReturnValue(null);
    const code = await logCommand({});
    expect(code).toBe(ExitCodes.AUTH);
    expect(callMcpTool).not.toHaveBeenCalled();
  });
});

describe('logCommand — input validation', () => {
  beforeEach(() => readCredentials.mockReturnValue(CREDS));

  it('rejects --limit > 100 with USAGE', async () => {
    const code = await logCommand({ json: true, limit: '500' });
    expect(code).toBe(ExitCodes.USAGE);
    expect(callMcpTool).not.toHaveBeenCalled();
  });

  it('rejects --limit < 1', async () => {
    const code = await logCommand({ json: true, limit: '0' });
    expect(code).toBe(ExitCodes.USAGE);
  });

  it('rejects non-numeric --limit', async () => {
    const code = await logCommand({ json: true, limit: 'abc' });
    expect(code).toBe(ExitCodes.USAGE);
  });

  it('rejects negative --offset', async () => {
    const code = await logCommand({ json: true, offset: '-5' });
    expect(code).toBe(ExitCodes.USAGE);
  });

  it('rejects unknown --kind', async () => {
    const code = await logCommand({ json: true, kind: 'incident' });
    expect(code).toBe(ExitCodes.USAGE);
  });

  it("accepts kind in {pr,push,both}", async () => {
    callMcpTool.mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 });
    for (const kind of ['pr', 'push', 'both']) {
      const code = await logCommand({ json: true, kind });
      expect(code).toBe(ExitCodes.ALLOWED);
    }
  });
});

describe('logCommand — JSON envelope', () => {
  beforeEach(() => readCredentials.mockReturnValue(CREDS));

  it('emits the raw backend response in --json mode', async () => {
    callMcpTool.mockResolvedValue({
      items: [
        {
          type: 'pr',
          assessmentId: 'a1',
          repository: 'acme/api',
          prNumber: 7,
          prTitle: 'Title',
          riskScore: 36,
          riskLevel: 'medium',
          summary: '',
          analyzedAt: '2026-05-11T09:00:00.000Z',
        },
      ],
      total: 1,
      limit: 20,
      offset: 0,
    });

    const code = await logCommand({ json: true });
    expect(code).toBe(ExitCodes.ALLOWED);

    const output = stdoutSpy.mock.calls.map((args) => args[0]).join('').trim();
    const parsed = JSON.parse(output);
    expect(parsed.total).toBe(1);
    expect(parsed.items[0].assessmentId).toBe('a1');
  });

  it('passes limit, offset, and kind through to the MCP call', async () => {
    callMcpTool.mockResolvedValue({ items: [], total: 0, limit: 5, offset: 10 });
    await logCommand({ json: true, limit: '5', offset: '10', kind: 'pr' });
    expect(callMcpTool).toHaveBeenCalledWith(
      'list_recent_assessments',
      expect.objectContaining({ limit: 5, offset: 10, kind: 'pr' }),
      'mcp_re_test',
    );
  });
});
