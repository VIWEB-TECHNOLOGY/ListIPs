export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  applySecurityHeaders(headers);
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function errorJson(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, { status });
}

export function notFound(): Response {
  const headers = new Headers({
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff'
  });
  applySecurityHeaders(headers);

  return new Response('Not found\n', {
    status: 404,
    headers
  });
}

export async function readJson<T>(request: Request, maxBytes: number): Promise<T> {
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new RequestError(415, 'unsupported_media_type', 'Expected application/json.');
  }

  const contentLength = Number(request.headers.get('Content-Length') ?? '0');
  if (contentLength > maxBytes) {
    throw new RequestError(413, 'request_too_large', 'Request body is too large.');
  }

  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > maxBytes) {
    throw new RequestError(413, 'request_too_large', 'Request body is too large.');
  }

  try {
    return JSON.parse(body) as T;
  } catch {
    throw new RequestError(400, 'invalid_json', 'Request body must be valid JSON.');
  }
}

export class RequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export function handleError(error: unknown): Response {
  if (error instanceof RequestError) {
    return errorJson(error.status, error.code, error.message);
  }

  console.error('Unhandled request error', error);
  return errorJson(500, 'internal_error', 'Internal server error.');
}

export function applySecurityHeaders(headers: Headers): Headers {
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('X-Frame-Options', 'DENY');
  return headers;
}
