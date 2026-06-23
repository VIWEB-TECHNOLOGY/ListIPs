#!/usr/bin/env node

const DEFAULT_APP_ORIGIN = 'https://listips.com';
const DEFAULT_SMOKE_USERNAME = 'viweb-technology';

const config = {
  appOrigin: process.env.LISTIPS_SMOKE_APP_ORIGIN ?? DEFAULT_APP_ORIGIN,
  username: process.env.LISTIPS_SMOKE_USERNAME ?? DEFAULT_SMOKE_USERNAME,
  fixtureMode: process.env.LISTIPS_SMOKE_FIXTURES !== '0',
  publicUrl: envUrl('LISTIPS_SMOKE_PUBLIC_URL', null),
  privateUrl: envUrl('LISTIPS_SMOKE_PRIVATE_URL', null),
  expectedCacheSeconds: process.env.LISTIPS_SMOKE_CACHE_SECONDS ?? '60',
  expectedPublicSnippets: envList('LISTIPS_SMOKE_PUBLIC_EXPECTS'),
  expectedPrivateSnippets: envList('LISTIPS_SMOKE_PRIVATE_EXPECTS')
};

const results = [];

try {
  if (config.fixtureMode) {
    for (const item of smokeFixtures()) {
      await smokeRawUrl(item.label, item.url, {
        expectedSnippets: item.expectedSnippets,
        expectedItems: item.expectedItems,
        requireCacheHit: true
      });
    }
  } else {
    if (!config.publicUrl) {
      throw new Error('LISTIPS_SMOKE_PUBLIC_URL is required when LISTIPS_SMOKE_FIXTURES=0.');
    }

    await smokeRawUrl('public', config.publicUrl, {
      expectedSnippets: config.expectedPublicSnippets,
      requireCacheHit: true
    });

    if (config.privateUrl) {
      await smokeRawUrl('private', config.privateUrl, {
        expectedSnippets: config.expectedPrivateSnippets,
        requireCacheHit: true
      });
    } else {
      skip('private raw URL checks', 'LISTIPS_SMOKE_PRIVATE_URL is not set');
    }
  }

  printSummary();
} catch (error) {
  printSummary();
  console.error(`\nSmoke failed: ${error.message}`);
  process.exit(1);
}

async function smokeRawUrl(label, url, options) {
  const firstHead = await request(`${label} HEAD warm`, url, { method: 'HEAD' });
  assertStatus(`${label} HEAD warm`, firstHead, 200);
  assertHeader(`${label} HEAD warm`, firstHead, 'x-listips-cache-seconds', config.expectedCacheSeconds);
  if (options.expectedItems !== undefined) {
    assertHeader(`${label} HEAD warm`, firstHead, 'x-listips-items', String(options.expectedItems));
  }
  assertCacheControl(`${label} HEAD warm`, firstHead);
  const etag = requiredHeader(`${label} HEAD warm`, firstHead, 'etag');

  const secondHead = await request(`${label} HEAD cached`, url, { method: 'HEAD' });
  assertStatus(`${label} HEAD cached`, secondHead, 200);
  if (options.requireCacheHit) assertEdgeHit(`${label} HEAD cached`, secondHead);

  const getResponse = await request(`${label} GET`, url);
  assertStatus(`${label} GET`, getResponse, 200);
  assertHeader(`${label} GET`, getResponse, 'x-listips-cache-seconds', config.expectedCacheSeconds);
  if (options.expectedItems !== undefined) {
    assertHeader(`${label} GET`, getResponse, 'x-listips-items', String(options.expectedItems));
  }
  assertCacheControl(`${label} GET`, getResponse);
  assertEdgeCacheHeader(`${label} GET`, getResponse);
  assertBody(`${label} GET`, getResponse.body, options.expectedSnippets);

  const conditionalUrl = cacheBypassUrl(url);
  const conditional = await request(`${label} conditional GET`, conditionalUrl, {
    headers: { 'If-None-Match': etag }
  });
  assertStatus(`${label} conditional GET`, conditional, 304);
  assertEtag(`${label} conditional GET`, conditional, etag);

  const finalHead = await request(`${label} final HEAD`, url, { method: 'HEAD' });
  assertStatus(`${label} final HEAD`, finalHead, 200);
  if (options.requireCacheHit) assertEdgeHit(`${label} final HEAD`, finalHead);
}

async function request(name, url, init = {}) {
  const response = await fetch(url, {
    redirect: 'manual',
    ...init
  });
  const body = init.method === 'HEAD' ? '' : await response.text();
  const headers = Object.fromEntries(response.headers.entries());

  results.push({
    name,
    status: response.status,
    edgeCache: headers['x-listips-edge-cache'] ?? 'missing',
    cfCache: headers['cf-cache-status'] ?? 'missing',
    age: headers.age ?? 'missing'
  });

  return { response, body, headers };
}

function assertStatus(name, result, expected) {
  if (result.response.status !== expected) {
    throw new Error(`${name}: expected status ${expected}, got ${result.response.status}`);
  }
}

function assertHeader(name, result, header, expected) {
  const actual = result.headers[header.toLowerCase()];
  if (actual !== expected) {
    throw new Error(`${name}: expected ${header}=${expected}, got ${actual ?? 'missing'}`);
  }
}

function assertEtag(name, result, expected) {
  const actual = requiredHeader(name, result, 'etag');
  if (normalizeEtag(actual) !== normalizeEtag(expected)) {
    throw new Error(`${name}: expected ETag ${expected}, got ${actual}`);
  }
}

function requiredHeader(name, result, header) {
  const actual = result.headers[header.toLowerCase()];
  if (!actual) throw new Error(`${name}: missing required header ${header}`);
  return actual;
}

function assertCacheControl(name, result) {
  const cacheControl = requiredHeader(name, result, 'cache-control');
  for (const directive of [`max-age=${config.expectedCacheSeconds}`, `s-maxage=${config.expectedCacheSeconds}`]) {
    if (!cacheControl.includes(directive)) {
      throw new Error(`${name}: expected Cache-Control to include ${directive}, got ${cacheControl}`);
    }
  }
}

function assertEdgeCacheHeader(name, result) {
  const value = requiredHeader(name, result, 'x-listips-edge-cache');
  if (!['MISS', 'HIT', 'BYPASS'].includes(value)) {
    throw new Error(`${name}: invalid x-listips-edge-cache=${value}`);
  }
}

function assertEdgeHit(name, result) {
  const edgeCache = result.headers['x-listips-edge-cache'];
  const cfCache = result.headers['cf-cache-status'];
  if (edgeCache !== 'HIT' && cfCache !== 'HIT') {
    throw new Error(`${name}: expected cache HIT, got x-listips-edge-cache=${edgeCache ?? 'missing'}, cf-cache-status=${cfCache ?? 'missing'}`);
  }
}

function assertBody(name, body, expectedSnippets) {
  if (!body.endsWith('\n')) throw new Error(`${name}: raw body must end with newline`);
  if (body.length === 0) throw new Error(`${name}: raw body is empty`);

  for (const snippet of expectedSnippets) {
    if (!body.includes(snippet)) {
      throw new Error(`${name}: expected body to include ${JSON.stringify(snippet)}`);
    }
  }
}

function envUrl(name, fallback) {
  const value = process.env[name] || fallback;
  if (!value) return null;

  try {
    return new URL(value).toString();
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
}

function envList(name) {
  return (process.env[name] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function smokeFixtures() {
  return [
    {
      label: 'public manual',
      slug: 'public-manual',
      expectedItems: 2,
      expectedSnippets: ['# smoke public manual', '192.0.2.10']
    },
    {
      label: 'public synced',
      slug: 'public-synced',
      expectedSnippets: ['# smoke public synced', '192.0.2.20', '173.245.48.0/20']
    },
    {
      label: 'private always manual',
      slug: 'private-always-manual',
      token: 'sec_viweb_technology_smoke_always_manual_2026',
      expectedItems: 2,
      expectedSnippets: ['# smoke private always manual', '192.0.2.30']
    },
    {
      label: 'private always synced',
      slug: 'private-always-synced',
      token: 'sec_viweb_technology_smoke_always_synced_2026',
      expectedSnippets: ['# smoke private always synced', '192.0.2.40', '173.245.48.0/20']
    },
    {
      label: 'private one-time manual',
      slug: 'private-one-time-manual',
      token: 'sec_viweb_technology_smoke_one_time_manual_2026',
      expectedItems: 2,
      expectedSnippets: ['# smoke private one-time manual', '192.0.2.50']
    },
    {
      label: 'private one-time synced',
      slug: 'private-one-time-synced',
      token: 'sec_viweb_technology_smoke_one_time_synced_2026',
      expectedSnippets: ['# smoke private one-time synced', '192.0.2.60', '173.245.48.0/20']
    }
  ].map((item) => ({ ...item, url: fixtureUrl(item) }));
}

function fixtureUrl(item) {
  const url = new URL(`${config.appOrigin}/u/${config.username}/${item.slug}`);
  if (item.token) url.searchParams.set('token', item.token);
  return url.toString();
}

function cacheBypassUrl(value) {
  const url = new URL(value);
  url.searchParams.set('__smoke_conditional', String(Date.now()));
  return url.toString();
}

function normalizeEtag(value) {
  return value.trim().replace(/^W\//, '');
}

function skip(name, reason) {
  results.push({ name, status: 'SKIP', edgeCache: reason, cfCache: '', age: '' });
}

function printSummary() {
  console.table(results);
}
