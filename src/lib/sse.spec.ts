import { parseSseChunk } from './sse';

describe('parseSseChunk', () => {
  it('parses one complete frame', () => {
    const { frames, leftover } = parseSseChunk(
      'event: session.started\ndata: {"x":1}\n\n',
    );
    expect(frames).toEqual([
      { event: 'session.started', data: '{"x":1}' },
    ]);
    expect(leftover).toBe('');
  });

  it('defaults event to "message" when not specified', () => {
    const { frames } = parseSseChunk('data: hello\n\n');
    expect(frames).toEqual([{ event: 'message', data: 'hello' }]);
  });

  it('parses multiple frames in one chunk', () => {
    const { frames } = parseSseChunk(
      'event: a\ndata: 1\n\nevent: b\ndata: 2\n\n',
    );
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual({ event: 'a', data: '1' });
    expect(frames[1]).toEqual({ event: 'b', data: '2' });
  });

  it('preserves an unterminated frame as leftover', () => {
    const { frames, leftover } = parseSseChunk(
      'event: a\ndata: 1\n\nevent: b\ndata: 2',
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ event: 'a', data: '1' });
    expect(leftover).toBe('event: b\ndata: 2');
  });

  it('returns no frames when nothing is terminated yet', () => {
    const { frames, leftover } = parseSseChunk('event: a\ndata: 1');
    expect(frames).toEqual([]);
    expect(leftover).toBe('event: a\ndata: 1');
  });

  it('ignores comment / heartbeat lines starting with :', () => {
    const { frames } = parseSseChunk(
      ': ping\n\nevent: a\ndata: 1\n\n: another ping\n\n',
    );
    expect(frames).toEqual([{ event: 'a', data: '1' }]);
  });

  it('joins multi-line data with newlines', () => {
    const { frames } = parseSseChunk(
      'event: a\ndata: line1\ndata: line2\n\n',
    );
    expect(frames[0].data).toBe('line1\nline2');
  });

  it('strips a single leading space in the value (per SSE spec)', () => {
    const { frames } = parseSseChunk('data: hello\n\n');
    expect(frames[0].data).toBe('hello');
  });

  it('handles \\r\\n line endings', () => {
    const { frames } = parseSseChunk(
      'event: a\r\ndata: 1\r\n\r\nevent: b\r\ndata: 2\r\n\r\n',
    );
    expect(frames).toHaveLength(2);
    expect(frames[1]).toEqual({ event: 'b', data: '2' });
  });
});
