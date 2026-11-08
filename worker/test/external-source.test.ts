import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSource } from '../src/services/external-source';

const LIMIT = 262144;
const URL = 'https://www.cloudflare.com/ips-v4';

function fixture(chunks: Uint8Array[], init: ResponseInit = {}, cancel = vi.fn()) {
  let index = 0;
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (index < chunks.length) controller.enqueue(chunks[index++]);
    else controller.close();
  });
  const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
  const response = new Response(body, init);
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal('fetch', fetchMock);
  return { body, pull, cancel, fetchMock };
}

describe('bounded external source consumption', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([undefined, '1', '999999'])('accepts the exact byte limit with Content-Length %s', async (length) => {
    const headers: Record<string, string> = length ? { 'Content-Length': length } : {};
    const source = fixture([new Uint8Array(LIMIT - 1).fill(97), new Uint8Array([98])], { headers });
    expect(await fetchSource(URL)).toBe('a'.repeat(LIMIT - 1) + 'b');
    expect(source.cancel).not.toHaveBeenCalled();
    expect(source.body.locked).toBe(false);
    expect(source.fetchMock).toHaveBeenCalledWith(URL, expect.objectContaining({
      redirect: 'manual', headers: { Accept: 'text/plain,*/*;q=0.1' }, signal: expect.any(AbortSignal)
    }));
  });

  it.each([undefined, '1'])('rejects byte limit + 1 early with Content-Length %s', async (length) => {
    const source = fixture([
      new Uint8Array(LIMIT).fill(97), new Uint8Array([98]), new Uint8Array([99])
    ], { headers: length ? { 'Content-Length': length } : {} });
    const decode = vi.spyOn(TextDecoder.prototype, 'decode');
    await expect(fetchSource(URL)).rejects.toThrow('Source response exceeds 256 KB.');
    expect(source.pull).toHaveBeenCalledTimes(2);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(source.cancel).toHaveBeenCalledOnce();
    expect(source.body.locked).toBe(false);
  });

  it('rejects an oversized first chunk without decoding and does not await cancellation', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const source = fixture([new Uint8Array(LIMIT + 1)], {}, cancel);
    const decode = vi.spyOn(TextDecoder.prototype, 'decode');
    await expect(fetchSource(URL)).rejects.toThrow('Source response exceeds 256 KB.');
    expect(decode).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(source.body.locked).toBe(false);
  });

  it('matches response.text UTF-8 semantics for split BOM, multibyte, malformed and incomplete sequences', async () => {
    const bytes = new Uint8Array([
      0xef, 0xbb, 0xbf, 0x61, 0xc3, 0xa9, 0xf0, 0x9f, 0x98, 0x80,
      0xff, 0xef, 0xbb, 0xbf, 0xe2, 0x82
    ]);
    const expected = await new Response(bytes).text();
    const source = fixture(Array.from(bytes, (byte) => new Uint8Array([byte])), {
      headers: { 'Content-Type': 'text/plain; charset=iso-8859-1' }
    });
    expect(await fetchSource(URL)).toBe(expected);
    expect(source.body.locked).toBe(false);
  });

  it('counts malformed delivered bytes rather than the longer replacement encoding', async () => {
    fixture([new Uint8Array(LIMIT).fill(0xff)]);
    expect(await fetchSource(URL)).toBe('\ufffd'.repeat(LIMIT));
  });

  it('keeps deadline reactions constant for an exact-limit body of one-byte chunks', async () => {
    let delivered = 0;
    const byte = new Uint8Array([97]);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (delivered++ < LIMIT) controller.enqueue(byte);
        else controller.close();
      }
    }, { highWaterMark: 0 });
    vi.stubGlobal('fetch', async () => new Response(body));
    // Count registrations per promise, rather than relying on GC/heap timing.
    // The old per-read race attaches LIMIT + 2 reactions to one deadline.
    const registrations = new WeakMap<Promise<unknown>, number>();
    let maximum = 0;
    const originalThen = Promise.prototype.then;
    // Avoid mock call-history retention while measuring promise retention.
    Object.defineProperty(Promise.prototype, 'then', { value: function (this: Promise<unknown>, ...args: Parameters<typeof originalThen>) {
      const count = (registrations.get(this) ?? 0) + 1;
      registrations.set(this, count);
      maximum = Math.max(maximum, count);
      return originalThen.apply(this, args);
    } });
    let result: string;
    try {
      result = await fetchSource(URL);
    } finally {
      Object.defineProperty(Promise.prototype, 'then', { value: originalThen });
    }
    expect(result).toBe('a'.repeat(LIMIT));
    expect(maximum).toBeLessThanOrEqual(2);
    expect(body.locked).toBe(false);
  });

  it.each([null, new Uint8Array()])('preserves empty body semantics (%s)', async (body) => {
    vi.stubGlobal('fetch', async () => new Response(body));
    expect(await fetchSource(URL)).toBe('');
  });

  it.each([
    [{ status: 302, headers: { Location: 'https://www.cloudflare.com/other' } }, 'Fetch failed with status 302'],
    [{ status: 503 }, 'Fetch failed with status 503'],
    [{ headers: { 'Content-Type': 'text/html' } }, 'Unsupported content type: text/html']
  ] satisfies Array<[ResponseInit, string]>)('cancels rejected responses without reading or masking the error (%s)', async (init, message) => {
    const cancel = vi.fn(() => Promise.reject(new Error('cleanup failed')));
    const source = fixture([new Uint8Array([97])], init, cancel);
    await expect(fetchSource(URL)).rejects.toThrow(message);
    expect(source.pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(source.body.locked).toBe(false);
  });

  it('accepts application/octet-stream', async () => {
    fixture([new Uint8Array([97])], { headers: { 'Content-Type': 'application/octet-stream' } });
    expect(await fetchSource(URL)).toBe('a');
  });

  it('preserves a body read error and releases its lock', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(new Error('producer failed')); }
    }, { highWaterMark: 0 });
    vi.stubGlobal('fetch', async () => new Response(body));
    await expect(fetchSource(URL)).rejects.toThrow('producer failed');
    expect(body.locked).toBe(false);
  });

  it.each(['producer failure', 'timeout', 'success'])('handles releaseLock errors after %s', async (outcome) => {
    vi.useFakeTimers();
    const primary = new Error('producer failed');
    const cleanup = new Error('release failed');
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (outcome === 'producer failure') controller.error(primary);
        if (outcome === 'success') controller.close();
      }
    }, { highWaterMark: 0 });
    const getReader = body.getReader.bind(body);
    vi.spyOn(body, 'getReader').mockImplementation(() => {
      const reader = getReader();
      const release = reader.releaseLock.bind(reader);
      vi.spyOn(reader, 'releaseLock').mockImplementation(() => {
        release();
        throw cleanup;
      });
      return reader;
    });
    vi.stubGlobal('fetch', async () => new Response(body));
    const expected = outcome === 'producer failure' ? primary
      : outcome === 'timeout' ? expect.objectContaining({ message: 'Source fetch timed out.' }) : cleanup;
    const rejection = expect(fetchSource(URL)).rejects.toEqual(expected);
    if (outcome === 'timeout') await vi.advanceTimersByTimeAsync(8000);
    await rejection;
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the remaining fetch budget for a stalled read despite uncooperative cancellation', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ pull() {}, cancel }, { highWaterMark: 0 });
    let deliver!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { deliver = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const pending = fetchSource(URL);
    const rejection = expect(pending).rejects.toThrow('Source fetch timed out.');
    await vi.advanceTimersByTimeAsync(6000);
    deliver(new Response(body));
    await vi.advanceTimersByTimeAsync(1999);
    expect(cancel).not.toHaveBeenCalled();
    expect(body.locked).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts a stalled read after partial content without returning that content', async () => {
    vi.useFakeTimers();
    let pulls = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(new TextEncoder().encode('198.51.100.1\n'));
      }, cancel
    }, { highWaterMark: 0 });
    let signal!: AbortSignal;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      signal = init.signal!;
      return new Response(body);
    });
    const rejection = expect(fetchSource(URL)).rejects.toThrow('Source fetch timed out.');
    await vi.advanceTimersByTimeAsync(8000);
    await rejection;
    expect(signal.aborted).toBe(true);
    expect(pulls).toBe(2);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out fetch even if abort is ignored and cancels a late response', async () => {
    vi.useFakeTimers();
    let deliver!: (response: Response) => void;
    let signal!: AbortSignal;
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      signal = init.signal!;
      return new Promise<Response>((resolve) => { deliver = resolve; });
    });
    const rejection = expect(fetchSource(URL)).rejects.toThrow('Source fetch timed out.');
    await vi.advanceTimersByTimeAsync(8000);
    await rejection;
    expect(signal.aborted).toBe(true);
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    deliver(new Response(body));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
});
