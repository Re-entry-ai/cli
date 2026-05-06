import kleur from 'kleur';
import { ExitCodes } from '../lib/exit-codes';
import { readCredentials } from '../lib/storage';
import { apiUrl, userAgent } from '../lib/config';
import { parseSseChunk } from '../lib/sse';

interface ObserveOptions {
  json?: boolean;
}

interface SessionStartedPayload {
  type: 'session.started';
  sessionId: string;
  teamId: string;
  agentId: string;
  source: string;
  clientName: string | null;
  startedAt: string;
}

interface ToolCompletedPayload {
  type: 'tool.completed';
  sessionId: string;
  agentId: string;
  toolName: string;
  repository: string | null;
  branch: string | null;
  riskScore: number | null;
  riskLevel: string | null;
  result: 'allowed' | 'blocked' | 'requires_human' | 'error' | null;
  latencyMs: number;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

interface SessionEndedPayload {
  type: 'session.ended';
  sessionId: string;
  endedAt: string;
}

type SessionPayload =
  | SessionStartedPayload
  | ToolCompletedPayload
  | SessionEndedPayload;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export async function observeCommand(
  options: ObserveOptions,
): Promise<number> {
  const creds = readCredentials();
  if (!creds) {
    process.stderr.write(
      `${kleur.red('error:')} Not logged in. Run \`reentry login\`.\n`,
    );
    return ExitCodes.AUTH;
  }

  const url = `${apiUrl()}/mcp/observe/stream`;
  const abort = new AbortController();

  // Graceful Ctrl-C: abort the in-flight fetch and exit 0.
  const onSigint = (): void => {
    abort.abort();
  };
  process.on('SIGINT', onSigint);

  if (!options.json) {
    process.stdout.write(
      kleur.dim(`Connecting to ${url} — Ctrl-C to stop.\n`),
    );
  }

  let attempt = 0;
  let firstConnect = true;

  // Reconnect loop. We treat any disconnect (network glitch, server restart)
  // as transient and retry with exponential backoff capped at 30s.
  while (!abort.signal.aborted) {
    try {
      const ok = await streamOnce(
        url,
        creds.accessToken,
        abort.signal,
        options,
        firstConnect,
      );
      if (!ok) {
        // Auth-rejected — don't retry, the token is bad.
        process.off('SIGINT', onSigint);
        return ExitCodes.AUTH;
      }
      firstConnect = false;
      attempt = 0;
    } catch (err) {
      if (abort.signal.aborted) {
        break;
      }
      const message = err instanceof Error ? err.message : 'unknown';
      if (!options.json) {
        process.stderr.write(
          kleur.dim(`disconnected (${message}) — retrying...\n`),
        );
      }
      const wait = Math.min(
        RECONNECT_BASE_MS * 2 ** attempt,
        RECONNECT_MAX_MS,
      );
      attempt = Math.min(attempt + 1, 10);
      try {
        await sleepWithAbort(wait, abort.signal);
      } catch {
        break;
      }
    }
  }

  process.off('SIGINT', onSigint);
  return ExitCodes.ALLOWED;
}

/**
 * Opens one SSE connection and reads until disconnect or abort. Returns
 * true on a normal disconnect (caller should reconnect), false if auth was
 * rejected (caller should NOT reconnect — token is invalid).
 */
async function streamOnce(
  url: string,
  token: string,
  signal: AbortSignal,
  options: ObserveOptions,
  firstConnect: boolean,
): Promise<boolean> {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'text/event-stream',
      'User-Agent': userAgent(),
    },
    signal,
  });

  if (response.status === 401) {
    process.stderr.write(
      `${kleur.red('error:')} Token rejected. Run \`reentry login\` again.\n`,
    );
    return false;
  }

  if (response.status === 429) {
    process.stderr.write(
      `${kleur.yellow('warning:')} Too many concurrent observe connections for this team.\n`,
    );
    return false;
  }

  if (!response.ok || !response.body) {
    throw new Error(`unexpected status ${response.status}`);
  }

  if (firstConnect && !options.json) {
    process.stdout.write(kleur.dim('connected. waiting for events...\n\n'));
  }

  const decoder = new TextDecoder();
  let buffer = '';

  // Node's fetch returns a web ReadableStream; iterate via reader.
  const reader = response.body.getReader();

  // SIGINT propagates here via the AbortSignal — but reader.read() can
  // sit blocked between server frames (heartbeat is every 25s). Cancel
  // the reader explicitly when abort fires so Ctrl-C exits immediately
  // rather than waiting for the next byte.
  const onAbort = (): void => {
    reader.cancel().catch(() => {
      // Already cancelled / already closed — fine.
    });
  };
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      const { frames, leftover } = parseSseChunk(buffer);
      buffer = leftover;

      for (const frame of frames) {
        handleFrame(frame.event, frame.data, options);
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      // Already released — ignore.
    }
  }

  return true;
}

function handleFrame(
  event: string,
  data: string,
  options: ObserveOptions,
): void {
  if (event === 'ready') {
    return;
  }

  let payload: SessionPayload;
  try {
    payload = JSON.parse(data) as SessionPayload;
  } catch {
    // Malformed payload — drop silently.
    return;
  }

  if (options.json) {
    process.stdout.write(JSON.stringify(payload) + '\n');
    return;
  }

  switch (payload.type) {
    case 'session.started':
      process.stdout.write(
        `${timestamp(payload.startedAt)} ${kleur.cyan('▶')} ${kleur.bold('session.started')} ` +
          `${kleur.dim(`agent=${payload.agentId} source=${payload.source} sid=${payload.sessionId.slice(0, 8)}`)}\n`,
      );
      break;
    case 'tool.completed':
      renderToolCompleted(payload);
      break;
    case 'session.ended':
      process.stdout.write(
        `${timestamp(payload.endedAt)} ${kleur.dim('■')} ${kleur.dim(`session.ended sid=${payload.sessionId.slice(0, 8)}`)}\n`,
      );
      break;
  }
}

function renderToolCompleted(p: ToolCompletedPayload): void {
  const verdict = (() => {
    if (p.result === 'blocked') {
      return kleur.red().bold('BLOCKED');
    }
    if (p.result === 'requires_human') {
      return kleur.yellow().bold('REVIEW');
    }
    if (p.result === 'error') {
      return kleur.red().bold('ERROR');
    }
    if (p.result === 'allowed') {
      return kleur.green('OK');
    }
    return kleur.dim('—');
  })();

  const score =
    p.riskScore !== null
      ? kleur.dim(`(${p.riskLevel}/${p.riskScore})`)
      : '';

  const repo = p.repository ? kleur.dim(`${p.repository}@${p.branch ?? '?'}`) : '';

  process.stdout.write(
    `${timestamp(p.createdAt)} ${verdict} ${kleur.bold(p.toolName)} ${score} ` +
      `${kleur.dim(`${p.latencyMs}ms`)} ${repo}\n`,
  );
}

function timestamp(iso: string): string {
  // Render HH:MM:SS in the user's local zone for terminal scanning.
  const d = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return kleur.dim(
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
  );
}

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
