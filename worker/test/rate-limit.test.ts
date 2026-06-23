import { describe, expect, it } from 'vitest';
import { checkRateLimit, RateLimitCounter, requestIdentifier } from '../src/services/rate-limit';
import type { Env } from '../src/types';

class MemoryKv {
  values = new Map<string, string>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string) {
    this.values.set(key, value);
  }
}

class MemoryDurableObjectStorage {
  values = new Map<string, unknown>();
  alarmAt: number | Date | null = null;

  async transaction<T>(closure: (txn: DurableObjectTransaction) => Promise<T>): Promise<T> {
    return closure({
      get: async (key: string) => this.values.get(key),
      put: async (key: string, value: unknown) => {
        this.values.set(key, value);
      },
      setAlarm: async (scheduledTime: number | Date) => {
        this.alarmAt = scheduledTime;
      }
    } as unknown as DurableObjectTransaction);
  }

  async list<T>(): Promise<Map<string, T>> {
    return new Map(this.values) as Map<string, T>;
  }

  async delete(keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      if (this.values.delete(key)) deleted += 1;
    }
    return deleted;
  }
}

function rateLimitCounterRequest(limit = 2, windowSeconds = 60) {
  return new Request('https://rate-limit.test/check', {
    method: 'POST',
    body: JSON.stringify({ limit, windowSeconds })
  });
}

describe('rate limit helper', () => {
  it('allows requests up to the limit and blocks after with the KV fallback', async () => {
    const kv = new MemoryKv();
    const env = { LISTS_KV: kv } as unknown as Env;
    const options = {
      scope: 'test',
      identifier: 'user:1',
      limit: 2,
      windowSeconds: 60
    };

    await expect(checkRateLimit(env, options)).resolves.toMatchObject({ allowed: true, remaining: 1 });
    await expect(checkRateLimit(env, options)).resolves.toMatchObject({ allowed: true, remaining: 0 });
    await expect(checkRateLimit(env, options)).resolves.toMatchObject({ allowed: false, remaining: 0 });
  });

  it('counts requests inside the Durable Object limiter', async () => {
    const storage = new MemoryDurableObjectStorage();
    const counter = new RateLimitCounter({ storage } as unknown as DurableObjectState);

    const first = await counter.fetch(rateLimitCounterRequest());
    const second = await counter.fetch(rateLimitCounterRequest());
    const third = await counter.fetch(rateLimitCounterRequest());

    await expect(first.json()).resolves.toMatchObject({ allowed: true, remaining: 1 });
    await expect(second.json()).resolves.toMatchObject({ allowed: true, remaining: 0 });
    await expect(third.json()).resolves.toMatchObject({ allowed: false, remaining: 0 });
    expect(storage.alarmAt).toEqual(expect.any(Number));
  });

  it('uses Cloudflare connecting IP as the request identifier', () => {
    const request = new Request('https://listips.com', {
      headers: {
        'CF-Connecting-IP': '203.0.113.10',
        'X-Forwarded-For': '198.51.100.1'
      }
    });

    expect(requestIdentifier(request)).toBe('203.0.113.10');
  });
});
