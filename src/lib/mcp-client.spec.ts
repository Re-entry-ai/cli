/**
 * Tests for the MCP client envelope handling. Mocks fetch globally so we
 * exercise the JSON-RPC parsing without hitting the network.
 */

import {
  callMcpTool,
  McpAuthRejected,
  McpToolError,
  getProcessSessionId,
} from './mcp-client';
import { ApiNetworkError } from './api';

function mockFetch(impl: (url: string, init: RequestInit) => Response): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = jest.fn(
    async (url: string, init: RequestInit) => impl(url, init),
  );
}

describe('callMcpTool', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends a JSON-RPC tools/call envelope with bearer auth and session header', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    mockFetch((url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [
              { type: 'text', text: JSON.stringify({ riskScore: 0 }) },
            ],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    await callMcpTool('pre_commit_check', { diff: '...' }, 'mcp_re_secret');

    expect(captured).not.toBeNull();
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer mcp_re_secret');
    expect(headers['X-Reentry-Session-Id']).toBe(getProcessSessionId());

    const body = JSON.parse(captured!.init.body as string);
    expect(body.method).toBe('tools/call');
    expect(body.params.name).toBe('pre_commit_check');
    expect(body.params.arguments).toEqual({ diff: '...' });
  });

  it('parses the success result.content[0].text as JSON', async () => {
    mockFetch(() =>
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ decision: 'allowed', riskScore: 5 }),
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );

    const result = await callMcpTool<{ decision: string; riskScore: number }>(
      'decide_action',
      {},
      'tok',
    );

    expect(result).toEqual({ decision: 'allowed', riskScore: 5 });
  });

  it('throws McpAuthRejected on 401', async () => {
    mockFetch(() => new Response('Unauthorized', { status: 401 }));

    await expect(
      callMcpTool('pre_commit_check', {}, 'tok'),
    ).rejects.toBeInstanceOf(McpAuthRejected);
  });

  it('throws ApiNetworkError on non-401 non-2xx', async () => {
    mockFetch(() => new Response('Server error', { status: 503 }));

    await expect(
      callMcpTool('pre_commit_check', {}, 'tok'),
    ).rejects.toBeInstanceOf(ApiNetworkError);
  });

  it('throws McpToolError when result.isError is true', async () => {
    mockFetch(() =>
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            isError: true,
            content: [{ type: 'text', text: 'tier insufficient' }],
          },
        }),
        { status: 200 },
      ),
    );

    await expect(
      callMcpTool('pre_commit_check', {}, 'tok'),
    ).rejects.toBeInstanceOf(McpToolError);
  });

  it('throws McpToolError when JSON-RPC envelope has an error field', async () => {
    mockFetch(() =>
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32601, message: 'method not found' },
        }),
        { status: 200 },
      ),
    );

    await expect(
      callMcpTool('does_not_exist', {}, 'tok'),
    ).rejects.toBeInstanceOf(McpToolError);
  });

  it('uses one stable session id across multiple calls in the same process', () => {
    const a = getProcessSessionId();
    const b = getProcessSessionId();
    expect(a).toEqual(b);
    // UUID v4 shape
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
