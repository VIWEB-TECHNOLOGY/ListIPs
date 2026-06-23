export function isAllowedExternalSource(input: string, allowedPatterns: string): boolean {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:') return false;

  const host = url.hostname.toLowerCase();
  return allowedPatterns
    .split(',')
    .map((pattern) => pattern.trim().toLowerCase())
    .filter(Boolean)
    .some((pattern) => hostMatchesPattern(host, pattern));
}

function hostMatchesPattern(host: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }

  return host === pattern;
}
