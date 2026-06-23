import { describe, expect, it } from 'vitest';
import { isAllowedExternalSource } from '../src/validation/source';

const allowed = '*.cloudflare.com,*.githubusercontent.com,*.amazonaws.com';

describe('isAllowedExternalSource', () => {
  it('allows configured HTTPS domains', () => {
    expect(isAllowedExternalSource('https://www.cloudflare.com/ips-v4', allowed)).toBe(true);
    expect(isAllowedExternalSource('https://raw.githubusercontent.com/org/repo/main/list.txt', allowed)).toBe(true);
    expect(isAllowedExternalSource('https://bucket.s3.amazonaws.com/list.txt', allowed)).toBe(true);
  });

  it('rejects non-HTTPS and unlisted domains', () => {
    expect(isAllowedExternalSource('http://www.cloudflare.com/ips-v4', allowed)).toBe(false);
    expect(isAllowedExternalSource('https://example.com/list.txt', allowed)).toBe(false);
    expect(isAllowedExternalSource('not a url', allowed)).toBe(false);
  });
});
