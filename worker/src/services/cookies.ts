export function parseCookies(request: Request): Map<string, string> {
  const header = request.headers.get('Cookie') ?? '';
  const cookies = new Map<string, string>();

  for (const part of header.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (!rawName || rawValue.length === 0) continue;
    cookies.set(rawName, decodeURIComponent(rawValue.join('=')));
  }

  return cookies;
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return [
    `li_session=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAgeSeconds}`
  ].join('; ');
}

export function clearSessionCookie(): string {
  return [
    'li_session=',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=0'
  ].join('; ');
}
