import type { Env } from '../types';
import { errorJson } from './response';

interface RateLimitOptions {
  scope: string;
  identifier: string;
  limit: number;
  windowSeconds: number;
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetSeconds: number;
}

export async function enforceRateLimit(env: Env, options: RateLimitOptions): Promise<Response | null> {
  const result = await checkRateLimit(env, options);
  if (result.allowed) return null;

  const response = errorJson(429, 'rate_limited', 'Too many requests. Please try again later.');
  response.headers.set('Retry-After', String(result.resetSeconds));
  response.headers.set('X-RateLimit-Limit', String(options.limit));
  response.headers.set('X-RateLimit-Remaining', String(result.remaining));
  response.headers.set('X-RateLimit-Reset', String(result.resetSeconds));
  return response;
}

export async function checkRateLimit(env: Env, options: RateLimitOptions): Promise<RateLimitResult> {
  if (env.RATE_LIMIT_COUNTER) {
    return checkDurableObjectRateLimit(env.RATE_LIMIT_COUNTER, options);
  }

  return checkKvRateLimit(env, options);
}

export class RateLimitCounter {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const input = await request.json<Partial<Pick<RateLimitOptions, 'limit' | 'windowSeconds'>>>();
    const limit = integerField(input.limit, 'limit');
    const windowSeconds = integerField(input.windowSeconds, 'windowSeconds');
    const now = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(now / windowSeconds) * windowSeconds;
    const resetSeconds = windowStart + windowSeconds - now;

    const result = await this.state.storage.transaction(async (txn) => {
      const key = `window:${windowStart}`;
      const current = Number(await txn.get<number>(key) ?? '0');
      const next = current + 1;

      await txn.put(key, next);
      await txn.setAlarm((windowStart + windowSeconds + 30) * 1000);

      return {
        allowed: next <= limit,
        remaining: Math.max(limit - next, 0),
        resetSeconds
      };
    });

    return Response.json(result);
  }

  async alarm(): Promise<void> {
    const cutoff = Math.floor(Date.now() / 1000) - 3600;
    const entries = await this.state.storage.list<number>({ prefix: 'window:' });
    const expiredKeys = [...entries.keys()].filter((key) => {
      const windowStart = Number(key.replace(/^window:/, ''));
      return Number.isFinite(windowStart) && windowStart < cutoff;
    });

    if (expiredKeys.length > 0) {
      await this.state.storage.delete(expiredKeys);
    }
  }
}

async function checkDurableObjectRateLimit(namespace: DurableObjectNamespace, options: RateLimitOptions): Promise<RateLimitResult> {
  const id = namespace.idFromName(`${options.scope}:${sanitizeIdentifier(options.identifier)}`);
  const stub = namespace.get(id);
  const response = await stub.fetch('https://rate-limit.local/check', {
    method: 'POST',
    body: JSON.stringify({
      limit: options.limit,
      windowSeconds: options.windowSeconds
    })
  });

  if (!response.ok) {
    throw new Error(`Rate limit Durable Object failed with status ${response.status}.`);
  }

  return response.json<RateLimitResult>();
}

async function checkKvRateLimit(env: Env, options: RateLimitOptions): Promise<RateLimitResult> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / options.windowSeconds) * options.windowSeconds;
  const resetSeconds = windowStart + options.windowSeconds - now;
  const key = `ratelimit/${options.scope}/${sanitizeIdentifier(options.identifier)}/${windowStart}`;
  const current = Number(await env.LISTS_KV.get(key) ?? '0');
  const next = current + 1;

  await env.LISTS_KV.put(key, String(next), {
    expirationTtl: options.windowSeconds + 30
  });

  return {
    allowed: next <= options.limit,
    remaining: Math.max(options.limit - next, 0),
    resetSeconds
  };
}

export function requestIdentifier(request: Request, fallback = 'unknown'): string {
  return request.headers.get('CF-Connecting-IP')
    ?? request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
    ?? fallback;
}

function sanitizeIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9:._-]/g, '_').slice(0, 120);
}

function integerField(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid rate limit ${field}.`);
  }

  return value;
}
