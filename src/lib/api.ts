import { apiUrl, userAgent } from './config';

export interface ApiOptions {
  /** Bearer token. Omit for unauthenticated calls (device flow init / poll). */
  token?: string;
  /** AbortSignal — let callers wire ^C handlers and request timeouts. */
  signal?: AbortSignal;
  /** JSON body to POST. Omit for GET. */
  json?: unknown;
  /** HTTP method override. Defaults to GET if no body, POST otherwise. */
  method?: 'GET' | 'POST';
  /** Extra headers (e.g., X-Reentry-Session-Id). */
  headers?: Record<string, string>;
}

export interface ApiResponse<T> {
  status: number;
  ok: boolean;
  body: T;
}

/**
 * Thin wrapper around fetch. Adds User-Agent + bearer auth, parses JSON
 * (or returns raw text under a synthetic key for non-JSON bodies), and
 * normalizes error shapes so commands don't reimplement HTTP plumbing.
 *
 * Throws ApiNetworkError on connect/abort/timeout — those are exit-code
 * 66 (NETWORK) territory; anything else is a structured ApiResponse the
 * caller branches on.
 */
export async function apiCall<T = unknown>(
  pathname: string,
  options: ApiOptions = {},
): Promise<ApiResponse<T>> {
  const url = `${apiUrl()}${pathname}`;
  const method = options.method ?? (options.json !== undefined ? 'POST' : 'GET');

  const headers: Record<string, string> = {
    'User-Agent': userAgent(),
    Accept: 'application/json',
    ...options.headers,
  };

  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  let body: string | undefined;
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.json);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body,
      signal: options.signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    throw new ApiNetworkError(`Request to ${url} failed: ${message}`);
  }

  const text = await response.text();
  let parsed: T;
  try {
    parsed = (text.length > 0 ? JSON.parse(text) : {}) as T;
  } catch {
    parsed = { raw: text } as unknown as T;
  }

  return {
    status: response.status,
    ok: response.ok,
    body: parsed,
  };
}

export class ApiNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiNetworkError';
  }
}
