import { randomUUID } from 'crypto';
import { apiCall, ApiNetworkError } from './api';

/**
 * One UUID per CLI process. Sent on every MCP call as `X-Reentry-Session-Id`
 * so a multi-call command (e.g., `reentry init` running login + pre-commit)
 * groups into one row in the Observe surface's `agent_sessions` table.
 *
 * Single-call invocations (just `reentry pre-commit`) still group sensibly —
 * one process = one session.
 */
const PROCESS_SESSION_ID = randomUUID();

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: number;
  result: {
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  };
}

interface JsonRpcError {
  jsonrpc: '2.0';
  id: number;
  error: { code: number; message: string };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

export class McpAuthRejected extends Error {
  constructor() {
    super('Token rejected by backend');
    this.name = 'McpAuthRejected';
  }
}

export class McpToolError extends Error {
  constructor(
    message: string,
    public readonly toolName: string,
    /** Structured error code from the backend (e.g. SCOPE_VIOLATION) when
     *  the tool error was an HttpException with a `{error: {code}}` body.
     *  Lets the command layer map to the right exit code without parsing
     *  the message text. */
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'McpToolError';
  }
}

let nextRequestId = 1;

/**
 * Call an MCP tool over the Streamable HTTP endpoint. Returns the parsed
 * tool response. Throws:
 *  - McpAuthRejected on 401 (caller maps to ExitCodes.AUTH)
 *  - ApiNetworkError on connect/abort errors (ExitCodes.NETWORK)
 *  - McpToolError if the tool itself reports `isError: true`
 *  - Generic Error for malformed or non-success JSON-RPC envelopes
 */
export async function callMcpTool<T = unknown>(
  toolName: string,
  args: Record<string, unknown>,
  token: string,
): Promise<T> {
  const id = nextRequestId++;
  const result = await apiCall<JsonRpcResponse>('/mcp/sse', {
    method: 'POST',
    token,
    headers: { 'X-Reentry-Session-Id': PROCESS_SESSION_ID },
    json: {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    },
  });

  if (result.status === 401) {
    throw new McpAuthRejected();
  }

  if (!result.ok) {
    throw new ApiNetworkError(
      `MCP endpoint returned HTTP ${result.status} for ${toolName}`,
    );
  }

  const envelope = result.body;

  if ('error' in envelope) {
    throw new McpToolError(
      `${envelope.error.message} (code ${envelope.error.code})`,
      toolName,
    );
  }

  if (envelope.result?.isError) {
    const text = envelope.result.content?.[0]?.text ?? 'unknown tool error';
    const { message, code } = formatToolErrorText(text);
    throw new McpToolError(message, toolName, code);
  }

  const text = envelope.result?.content?.[0]?.text;
  if (typeof text !== 'string') {
    throw new Error(
      `MCP tool ${toolName} returned no content — unexpected envelope shape`,
    );
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `MCP tool ${toolName} returned non-JSON content: ${text.slice(0, 200)}`,
    );
  }
}

/** Exposed for tests + the observe command (which wants the same id). */
export function getProcessSessionId(): string {
  return PROCESS_SESSION_ID;
}

/**
 * The backend forwards HttpException response bodies as JSON in the MCP error
 * envelope's text field. Try to parse it and lift the human-readable message
 * (and remediation if present) into a single line plus the structured code;
 * fall back to the raw text if it isn't JSON.
 */
function formatToolErrorText(raw: string): { message: string; code?: string } {
  try {
    const parsed = JSON.parse(raw) as {
      error?: { message?: string; code?: string; remediation?: string };
    };
    if (parsed?.error?.message) {
      const parts: string[] = [];
      if (parsed.error.code) {
        parts.push(`[${parsed.error.code}]`);
      }
      parts.push(parsed.error.message);
      if (parsed.error.remediation) {
        parts.push(`— ${parsed.error.remediation}`);
      }
      return { message: parts.join(' '), code: parsed.error.code };
    }
  } catch {
    // Not JSON — fall through to raw text.
  }
  return { message: raw };
}
