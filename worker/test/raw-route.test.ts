import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleRaw } from '../src/routes/raw';
import { sha256Hex } from '../src/services/crypto';
import { createTestEnv } from './helpers';

class MemoryCache {
  store = new Map<string, Response>();

  async match(request: Request): Promise<Response | undefined> {
    return this.store.get(request.url)?.clone();
  }

  async put(request: Request, response: Response): Promise<void> {
    this.store.set(request.url, response.clone());
  }
}

function rawRequest(path: string, method = 'GET') {
  return new Request(`https://listips.test${path}`, { method });
}

describe('raw route', () => {
  let cache: MemoryCache;

  beforeEach(() => {
    cache = new MemoryCache();
    vi.stubGlobal('caches', { default: cache });
  });

  it('returns 1-minute cache headers and supports conditional requests', async () => {
    const env = createTestEnv();
    await env.__r2.put('lists/alice/office', '192.0.2.10\n', {
      customMetadata: {
        hash: 'sha256:test-hash',
        itemCount: '1',
        visibility: 'public',
      }
    });

    const response = await handleRaw(rawRequest('/u/alice/office'), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60, s-maxage=60, stale-while-revalidate=60');
    expect(response.headers.get('X-ListIPs-Cache-Seconds')).toBe('60');
    expect(response.headers.get('X-ListIPs-Edge-Cache')).toBe('MISS');
    expect(response.headers.get('ETag')).toBe('"sha256:test-hash"');
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow, nosnippet');

    const conditional = await handleRaw(new Request('https://listips.test/u/alice/office', {
      headers: { 'If-None-Match': '"sha256:test-hash"' }
    }), env);

    expect(conditional.status).toBe(304);
    expect(await conditional.text()).toBe('');
  });

  it('matches weak and strong etags for conditional raw requests', async () => {
    const env = createTestEnv();
    await env.__r2.put('lists/alice/office', '192.0.2.10\n', {
      customMetadata: {
        hash: 'sha256:test-hash',
        itemCount: '1',
        visibility: 'public',
      }
    });

    const conditional = await handleRaw(new Request('https://listips.test/u/alice/office', {
      headers: { 'If-None-Match': 'W/"sha256:test-hash"' }
    }), env);

    expect(conditional.status).toBe(304);
    expect(await conditional.text()).toBe('');
  });

  it('serves repeat public raw GETs from cache before rate limiting', async () => {
    const env = createTestEnv();
    await env.__r2.put('lists/alice/office', '192.0.2.10\n', {
      customMetadata: {
        hash: 'sha256:test-hash',
        itemCount: '1',
        visibility: 'public',
      }
    });

    const first = await handleRaw(rawRequest('/u/alice/office'), env);
    const second = await handleRaw(rawRequest('/u/alice/office'), env);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers.get('X-ListIPs-Edge-Cache')).toBe('MISS');
    expect(second.headers.get('X-ListIPs-Edge-Cache')).toBe('HIT');
    expect(await second.text()).toBe('192.0.2.10\n');
    expect(cache.store.has('https://listips.test/u/alice/office')).toBe(true);

    const rateLimitKeys = [...env.__kv.store.keys()].filter((key) => key.startsWith('ratelimit/raw_fetch/'));
    expect(rateLimitKeys).toHaveLength(1);
    expect(env.__kv.store.get(rateLimitKeys[0])?.value).toBe('1');
  });

  it('warms the public raw cache from HEAD requests', async () => {
    const env = createTestEnv();
    await env.__r2.put('lists/alice/office', '192.0.2.10\n', {
      customMetadata: {
        hash: 'sha256:test-hash',
        itemCount: '1',
        visibility: 'public',
      }
    });

    const first = await handleRaw(rawRequest('/u/alice/office', 'HEAD'), env);
    const second = await handleRaw(rawRequest('/u/alice/office', 'HEAD'), env);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers.get('X-ListIPs-Edge-Cache')).toBe('MISS');
    expect(second.headers.get('X-ListIPs-Edge-Cache')).toBe('HIT');
    expect(await first.text()).toBe('');
    expect(await second.text()).toBe('');
    expect(cache.store.has('https://listips.test/u/alice/office')).toBe(true);
  });

  it('serves repeat tokenized private raw GETs from cache keyed by token URL', async () => {
    const env = createTestEnv();
    const token = 'sec_private-token';
    await env.__r2.put('lists/alice/private', '192.0.2.10\n', {
      customMetadata: {
        hash: 'sha256:private-hash',
        itemCount: '1',
        visibility: 'private',
        rawTokenHash: await sha256Hex(token)
      }
    });

    const first = await handleRaw(rawRequest(`/u/alice/private?token=${token}`), env);
    const second = await handleRaw(rawRequest(`/u/alice/private?token=${token}`), env);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers.get('X-ListIPs-Edge-Cache')).toBe('MISS');
    expect(second.headers.get('X-ListIPs-Edge-Cache')).toBe('HIT');
    expect(cache.store.has(`https://listips.test/u/alice/private?token=${token}`)).toBe(true);
  });

  it('logs private raw delivery without exposing the token', async () => {
    const env = createTestEnv();
    env.OBSERVABILITY_SAMPLE_RATE = '1';
    const token = 'sec_private-token';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await env.__r2.put('lists/alice/private', '192.0.2.10\n', {
      customMetadata: {
        hash: 'sha256:private-hash',
        itemCount: '1',
        visibility: 'private',
        rawTokenHash: await sha256Hex(token)
      }
    });

    try {
      const response = await handleRaw(rawRequest(`/u/alice/private?token=${token}`), env);

      expect(response.status).toBe(200);
      const payload = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
      expect(payload).toContain('"event":"raw_delivery"');
      expect(payload).toContain('"visibility":"private"');
      expect(payload).toContain('"slug":"private"');
      expect(payload).not.toContain(token);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('bypasses cache for non-token query strings', async () => {
    const env = createTestEnv();
    await env.__r2.put('lists/alice/office', '192.0.2.10\n', {
      customMetadata: {
        hash: 'sha256:test-hash',
        itemCount: '1',
        visibility: 'public',
      }
    });

    const response = await handleRaw(rawRequest('/u/alice/office?probe=1'), env);

    expect(response.status).toBe(200);
    expect(response.headers.get('X-ListIPs-Edge-Cache')).toBe('BYPASS');
    expect(cache.store.size).toBe(0);
  });

  it('bypasses cache for token URLs with extra query strings', async () => {
    const env = createTestEnv();
    const token = 'sec_private-token';
    await env.__r2.put('lists/alice/private', '192.0.2.10\n', {
      customMetadata: {
        hash: 'sha256:private-hash',
        itemCount: '1',
        visibility: 'private',
        rawTokenHash: await sha256Hex(token)
      }
    });

    const response = await handleRaw(rawRequest(`/u/alice/private?token=${token}&probe=1`), env);

    expect(response.status).toBe(200);
    expect(response.headers.get('X-ListIPs-Edge-Cache')).toBe('BYPASS');
    expect(cache.store.size).toBe(0);
  });

  it('backfills a missing R2 artifact from D1 publication data', async () => {
    const env = createTestEnv();
    env.__db.lists.push({
      id: 'lst_1',
      user_id: 'usr_1',
      name: 'Office',
      slug: 'office',
      description: null,
      visibility: 'public',
      mode: 'allowlist',
      private_token_policy: 'always',
      content: '192.0.2.10\n',
      compiled_hash: 'sha256:d1-hash',
      kv_key: 'lists/alice/office',
      raw_token_hash: null,
      raw_token_prefix: null,
      raw_token_ciphertext: null,
      item_count: 1,
      external_sync_enabled: 0,
      external_sources_json: '[]',
      last_synced_at: null,
      last_sync_status: null,
      last_sync_error: null,
      next_sync_at: null,
      sync_failure_count: 0,
      created_at: '2026-05-06T00:00:00Z',
      updated_at: '2026-05-06T00:00:00Z'
    });

    const response = await handleRaw(rawRequest('/u/alice/office'), env);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('192.0.2.10\n');
    expect(env.__r2.store.get('lists/alice/office')?.customMetadata).toMatchObject({
      hash: 'sha256:d1-hash',
      itemCount: '1',
      visibility: 'public'
    });
  });
});
