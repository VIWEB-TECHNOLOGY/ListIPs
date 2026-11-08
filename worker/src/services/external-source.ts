const MAX_SOURCE_BYTES = 262144;

export async function fetchSource(url: string): Promise<string> {
  const controller = new AbortController();
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let failed = false;
  const deadlineError = new Error('Source fetch timed out.');
  let timeout: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(deadlineError);
      controller.abort();
    }, 8000);
  });

  // Race the whole consumption operation once. Racing each read against the
  // same deadline retains one promise reaction per chunk until the timer fires.
  const consume = async (): Promise<string> => {
    response = await fetch(url, {
      redirect: 'manual',
      signal: controller.signal,
      headers: { Accept: 'text/plain,*/*;q=0.1' }
    });
    // A producer may ignore abort and deliver a response after the deadline.
    if (controller.signal.aborted) {
      cancelBody(response.body, deadlineError);
      throw deadlineError;
    }
    if (!response.ok) throw new Error(`Fetch failed with status ${response.status}`);

    const contentType = response.headers.get('Content-Type') ?? '';
    if (contentType && !contentType.includes('text/plain') && !contentType.includes('application/octet-stream')) {
      throw new Error(`Unsupported content type: ${contentType}`);
    }

    if (!response.body) return '';
    reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    const text: string[] = [];
    let bytes = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (controller.signal.aborted) throw deadlineError;
      if (done) break;
      // Count delivered bytes, not Content-Length or re-encoded decoded text.
      // Reject the entire offending chunk before retaining or decoding it.
      if (value.byteLength > MAX_SOURCE_BYTES - bytes) {
        throw new Error('Source response exceeds 256 KB.');
      }
      bytes += value.byteLength;
      const decoded = decoder.decode(value, { stream: true });
      if (decoded) text.push(decoded);
    }
    text.push(decoder.decode());
    return text.join('');
  };

  try {
    return await Promise.race([consume(), deadline]);
  } catch (error) {
    failed = true;
    controller.abort();
    cancelBody(reader ?? response?.body, error);
    throw error;
  } finally {
    clearTimeout(timeout!);
    try {
      reader?.releaseLock();
    } catch (error) {
      // Report cleanup errors on success, but preserve any primary failure.
      if (!failed) throw error;
    }
  }
}

function cancelBody(body: ReadableStream<Uint8Array> | ReadableStreamDefaultReader<Uint8Array> | null | undefined, reason: unknown): void {
  // Cancellation can reject or never settle. Neither may hide the primary error
  // or hold up sync failure/backoff; the reader lock is released separately.
  try {
    void body?.cancel(reason).catch(() => {});
  } catch {
    // Preserve the primary failure even if cancellation throws synchronously.
  }
}
