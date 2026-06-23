import type { Env } from '../types';
import { getCompiledListForRaw } from '../services/compiled-list-store';
import { constantTimeEqual, sha256Hex } from '../services/crypto';
import { logEvent } from '../services/observability';
import { applySecurityHeaders, notFound } from '../services/response';
import { enforceRateLimit, requestIdentifier } from '../services/rate-limit';

interface RawMetadata {
  hash?: string;
  itemCount?: number;
  visibility?: 'public' | 'private';
  rawTokenHash?: string | null;
}

const SEGMENT_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export async function handleRaw(request: Request, env: Env): Promise<Response> {
  const startedAt = Date.now();
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return notFound();
  }

  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 3 || parts[0] !== 'u') return notFound();

  const [, username, slug] = parts;
  if (!SEGMENT_PATTERN.test(username) || !SEGMENT_PATTERN.test(slug)) return notFound();

  const cacheRequest = publicCacheRequest(request, url);
  const cache = edgeCache();
  const cached = cacheRequest && cache ? await cache.match(cacheRequest) : undefined;
  if (cached) {
    const response = cachedRawResponse(request, cached, 'HIT');
    logRawDelivery(env, request, username, slug, response, {
      edgeCache: 'HIT',
      cacheable: true,
      durationMs: Date.now() - startedAt
    });
    return response;
  }

  const limited = await enforceRateLimit(env, {
    scope: 'raw_fetch',
    identifier: `${requestIdentifier(request)}:${username}:${slug}`,
    limit: 120,
    windowSeconds: 60
  });
  if (limited) {
    logRawDelivery(env, request, username, slug, limited, {
      edgeCache: cacheRequest ? 'MISS' : 'BYPASS',
      cacheable: Boolean(cacheRequest),
      durationMs: Date.now() - startedAt,
      force: true
    });
    return limited;
  }

  const key = `lists/${username}/${slug}`;
  const artifact = await getCompiledListForRaw(env, key, username, slug);
  if (!artifact) {
    const response = notFound();
    logRawDelivery(env, request, username, slug, response, {
      edgeCache: cacheRequest ? 'MISS' : 'BYPASS',
      cacheable: Boolean(cacheRequest),
      durationMs: Date.now() - startedAt
    });
    return response;
  }
  const value: { value: string; metadata: RawMetadata } = {
    value: artifact.content,
    metadata: artifact.metadata
  };

  if (value.metadata?.visibility === 'private') {
    const token = url.searchParams.get('token');
    if (!token?.startsWith('sec_') || !value.metadata.rawTokenHash) {
      const response = notFound();
      logRawDelivery(env, request, username, slug, response, {
        edgeCache: cacheRequest ? 'MISS' : 'BYPASS',
        cacheable: Boolean(cacheRequest),
        visibility: 'private',
        itemCount: value.metadata?.itemCount,
        durationMs: Date.now() - startedAt
      });
      return response;
    }

    const tokenHash = await sha256Hex(token);
    if (!constantTimeEqual(tokenHash, value.metadata.rawTokenHash)) {
      const response = notFound();
      logRawDelivery(env, request, username, slug, response, {
        edgeCache: cacheRequest ? 'MISS' : 'BYPASS',
        cacheable: Boolean(cacheRequest),
        visibility: 'private',
        itemCount: value.metadata?.itemCount,
        durationMs: Date.now() - startedAt
      });
      return response;
    }
  }

  const cacheSeconds = Number(env.RAW_LIST_CACHE_SECONDS || '60');
  const headers = new Headers({
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds}`,
    'X-Content-Type-Options': 'nosniff',
    'X-ListIPs-Items': String(value.metadata?.itemCount ?? ''),
    'X-ListIPs-Cache-Seconds': String(cacheSeconds),
    'X-ListIPs-Edge-Cache': cacheRequest ? 'MISS' : 'BYPASS'
  });
  applySecurityHeaders(headers);

  if (value.metadata?.hash) {
    headers.set('ETag', `"${value.metadata.hash}"`);
  }

  const ifNoneMatch = request.headers.get('If-None-Match');
  if (etagMatches(ifNoneMatch, headers.get('ETag'))) {
    const response = new Response(null, { status: 304, headers });
    logRawDelivery(env, request, username, slug, response, {
      edgeCache: cacheRequest ? 'MISS' : 'BYPASS',
      cacheable: Boolean(cacheRequest),
      visibility: value.metadata?.visibility,
      itemCount: value.metadata?.itemCount,
      durationMs: Date.now() - startedAt
    });
    return response;
  }

  const response = new Response(value.value.endsWith('\n') ? value.value : `${value.value}\n`, {
    status: 200,
    headers
  });

  if (cacheRequest && cache) {
    await cache.put(cacheRequest, response.clone());
  }

  if (request.method === 'HEAD') {
    const headResponse = new Response(null, { status: 200, headers });
    logRawDelivery(env, request, username, slug, headResponse, {
      edgeCache: cacheRequest ? 'MISS' : 'BYPASS',
      cacheable: Boolean(cacheRequest),
      visibility: value.metadata?.visibility,
      itemCount: value.metadata?.itemCount,
      durationMs: Date.now() - startedAt
    });
    return headResponse;
  }

  logRawDelivery(env, request, username, slug, response, {
    edgeCache: cacheRequest ? 'MISS' : 'BYPASS',
    cacheable: Boolean(cacheRequest),
    visibility: value.metadata?.visibility,
    itemCount: value.metadata?.itemCount,
    durationMs: Date.now() - startedAt
  });
  return response;
}

function publicCacheRequest(request: Request, url: URL): Request | null {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  if (url.search) {
    const token = url.searchParams.get('token');
    if (!token?.startsWith('sec_')) return null;
    if ([...url.searchParams.keys()].some((key) => key !== 'token')) return null;
    return new Request(url.toString(), { method: 'GET' });
  }

  return new Request(`${url.origin}${url.pathname}`, { method: 'GET' });
}

function edgeCache(): Cache | null {
  return (globalThis.caches as unknown as { default?: Cache } | undefined)?.default ?? null;
}

function cachedRawResponse(request: Request, cached: Response, cacheStatus: 'HIT'): Response {
  const headers = new Headers(cached.headers);
  headers.set('X-ListIPs-Edge-Cache', cacheStatus);
  const ifNoneMatch = request.headers.get('If-None-Match');
  const etag = headers.get('ETag');
  if (etagMatches(ifNoneMatch, etag)) {
    return new Response(null, { status: 304, headers });
  }

  return request.method === 'HEAD'
    ? new Response(null, { status: cached.status, headers })
    : new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers });
}

function etagMatches(candidate: string | null, current: string | null): boolean {
  if (!candidate || !current) return false;
  return normalizeEtag(candidate) === normalizeEtag(current);
}

function normalizeEtag(value: string): string {
  return value.trim().replace(/^W\//, '');
}

function logRawDelivery(
  env: Env,
  request: Request,
  username: string,
  slug: string,
  response: Response,
  options: {
    edgeCache: 'MISS' | 'HIT' | 'BYPASS';
    cacheable: boolean;
    durationMs: number;
    visibility?: 'public' | 'private';
    itemCount?: number;
    force?: boolean;
  }
): void {
  logEvent(env, 'raw_delivery', {
    method: request.method,
    username,
    slug,
    status: response.status,
    edgeCache: options.edgeCache,
    cacheable: options.cacheable,
    visibility: options.visibility,
    itemCount: options.itemCount,
    durationMs: options.durationMs
  }, { force: options.force });
}
