/**
 * Minimal SSE parser. Consumes a Node ReadableStream of bytes from `fetch`
 * and yields `{event, data}` records as the server emits them.
 *
 * We deliberately don't pull in `eventsource` or similar — the SSE wire
 * format is small and a custom parser saves us a dep + lets us pass the
 * `Authorization: Bearer ...` header that EventSource doesn't support.
 */

export interface SseFrame {
  event: string;
  data: string;
}

/**
 * Parse a chunk of SSE text into discrete frames. SSE messages are
 * separated by a blank line; each line is `field: value`. We support
 * `event:` and `data:` (multi-line `data:` is concatenated with newlines).
 *
 * Lines starting with `:` are comments / heartbeats — skipped.
 *
 * The function returns parsed frames AND any leftover unterminated text
 * the caller should prepend to the next chunk.
 */
export function parseSseChunk(chunk: string): {
  frames: SseFrame[];
  leftover: string;
} {
  const frames: SseFrame[] = [];

  // Find the last frame separator. Anything past it is unterminated.
  const lastSep = Math.max(
    chunk.lastIndexOf('\n\n'),
    chunk.lastIndexOf('\r\n\r\n'),
  );
  const completed = lastSep === -1 ? '' : chunk.slice(0, lastSep);
  const leftover = lastSep === -1 ? chunk : chunk.slice(lastSep + 2);

  if (completed.length === 0) {
    return { frames, leftover };
  }

  for (const block of completed.split(/\r?\n\r?\n/)) {
    if (block.length === 0) {
      continue;
    }
    let event = 'message';
    const dataParts: string[] = [];

    for (const line of block.split(/\r?\n/)) {
      if (line.length === 0) {
        continue;
      }
      if (line.startsWith(':')) {
        // SSE comment / heartbeat — ignore.
        continue;
      }

      const colonIdx = line.indexOf(':');
      const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
      const valueRaw = colonIdx === -1 ? '' : line.slice(colonIdx + 1);
      // SSE spec: a single leading space in the value is stripped.
      const value = valueRaw.startsWith(' ') ? valueRaw.slice(1) : valueRaw;

      if (field === 'event') {
        event = value;
      } else if (field === 'data') {
        dataParts.push(value);
      }
      // ignore id:, retry:, unknown fields
    }

    if (dataParts.length > 0) {
      frames.push({ event, data: dataParts.join('\n') });
    }
  }

  return { frames, leftover };
}
