#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';

const config = {
  appOrigin: process.env.LISTIPS_CANARY_APP_ORIGIN ?? 'https://listips.com',
  wranglerConfig: process.env.LISTIPS_CANARY_WRANGLER_CONFIG ?? 'worker/wrangler.toml',
  database: process.env.LISTIPS_CANARY_D1_DATABASE ?? 'listips',
  r2Bucket: process.env.LISTIPS_CANARY_R2_BUCKET ?? 'listips-compiled',
  username: process.env.LISTIPS_CANARY_USERNAME ?? 'listips-canary',
  size: envInteger('LISTIPS_CANARY_SIZE', 10000),
  expectedCacheSeconds: process.env.LISTIPS_CANARY_CACHE_SECONDS ?? '60',
  keep: process.env.LISTIPS_CANARY_KEEP === '1'
};

const runId = process.env.LISTIPS_CANARY_RUN_ID ?? Date.now().toString(36);
const slug = process.env.LISTIPS_CANARY_SLUG ?? `large-${config.size}-${runId}`;
const userId = `usr_canary_${config.username.replace(/[^a-z0-9]+/g, '_')}`;
const listId = `lst_canary_${slug.replace(/[^a-z0-9]+/g, '_')}`;
const kvKey = `lists/${config.username}/${slug}`;
const rawUrl = `${config.appOrigin}/u/${config.username}/${slug}`;
const content = generateList(config.size);
const hash = await sha256Label(content);
const tempDir = mkdtempSync(join(tmpdir(), 'listips-canary-'));
const sqlFile = join(tempDir, 'canary.sql');
const artifactFile = join(tempDir, 'artifact.txt');

try {
  writeFileSync(sqlFile, setupSql(), 'utf8');
  writeFileSync(artifactFile, content, 'utf8');
  wrangler(['d1', 'execute', config.database, '--remote', '--config', config.wranglerConfig, '--file', sqlFile, '--yes']);
  deleteR2Object();
  putR2Object();

  await smokeCanary();

  console.log(`Large artifact canary passed: ${rawUrl}`);
  if (config.keep) {
    console.log('LISTIPS_CANARY_KEEP=1 set; leaving D1 row and R2 artifact in place.');
  } else {
    cleanup();
    console.log('Cleaned up canary D1 row and R2 artifact.');
  }
} catch (error) {
  console.error(`Large artifact canary failed: ${error.message}`);
  console.error(`Canary URL: ${rawUrl}`);
  if (!config.keep) cleanup({ bestEffort: true });
  process.exit(1);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

async function smokeCanary() {
  const firstHead = await request('HEAD warm', rawUrl, { method: 'HEAD' });
  assertStatus('HEAD warm', firstHead, 200);
  assertHeader('HEAD warm', firstHead, 'x-listips-items', String(config.size));
  assertHeader('HEAD warm', firstHead, 'x-listips-cache-seconds', config.expectedCacheSeconds);
  assertCacheControl('HEAD warm', firstHead);
  const etag = requiredHeader('HEAD warm', firstHead, 'etag');
  if (normalizeEtag(etag) !== `"${hash}"`) {
    throw new Error(`HEAD warm: expected ETag "${hash}", got ${etag}`);
  }

  const secondHead = await request('HEAD cached', rawUrl, { method: 'HEAD' });
  assertStatus('HEAD cached', secondHead, 200);
  assertCacheHit('HEAD cached', secondHead);

  const getResponse = await request('GET cached body', rawUrl);
  assertStatus('GET cached body', getResponse, 200);
  assertCacheHit('GET cached body', getResponse);
  assertHeader('GET cached body', getResponse, 'x-listips-items', String(config.size));
  assertBody(getResponse.body);

  const conditionalUrl = new URL(rawUrl);
  conditionalUrl.searchParams.set('__canary_conditional', String(Date.now()));
  const conditional = await request('conditional GET', conditionalUrl.toString(), {
    headers: { 'If-None-Match': etag }
  });
  assertStatus('conditional GET', conditional, 304);
}

async function request(name, url, init = {}) {
  const response = await fetch(url, {
    redirect: 'manual',
    ...init
  });
  const body = init.method === 'HEAD' ? '' : await response.text();
  const headers = Object.fromEntries(response.headers.entries());
  console.log(`${name}: status=${response.status} edge=${headers['x-listips-edge-cache'] ?? 'missing'} cf=${headers['cf-cache-status'] ?? 'missing'} age=${headers.age ?? 'missing'}`);
  return { response, body, headers };
}

function assertBody(body) {
  if (!body.endsWith('\n')) throw new Error('GET cached body: raw body must end with newline.');
  const lines = body.trimEnd().split('\n');
  if (lines.length !== config.size) {
    throw new Error(`GET cached body: expected ${config.size} output lines, got ${lines.length}.`);
  }

  if (lines[0] !== '10.0.0.0') throw new Error(`GET cached body: unexpected first line ${lines[0]}.`);
  if (lines.at(-1) !== generatedIp(config.size - 1)) {
    throw new Error(`GET cached body: unexpected last line ${lines.at(-1)}.`);
  }
}

function assertStatus(name, result, expected) {
  if (result.response.status !== expected) {
    throw new Error(`${name}: expected status ${expected}, got ${result.response.status}.`);
  }
}

function assertHeader(name, result, header, expected) {
  const actual = result.headers[header.toLowerCase()];
  if (actual !== expected) {
    throw new Error(`${name}: expected ${header}=${expected}, got ${actual ?? 'missing'}.`);
  }
}

function requiredHeader(name, result, header) {
  const actual = result.headers[header.toLowerCase()];
  if (!actual) throw new Error(`${name}: missing required header ${header}.`);
  return actual;
}

function assertCacheControl(name, result) {
  const cacheControl = requiredHeader(name, result, 'cache-control');
  for (const directive of [`max-age=${config.expectedCacheSeconds}`, `s-maxage=${config.expectedCacheSeconds}`]) {
    if (!cacheControl.includes(directive)) {
      throw new Error(`${name}: expected Cache-Control to include ${directive}, got ${cacheControl}.`);
    }
  }
}

function assertCacheHit(name, result) {
  const edgeCache = result.headers['x-listips-edge-cache'];
  const cfCache = result.headers['cf-cache-status'];
  if (edgeCache !== 'HIT' && cfCache !== 'HIT') {
    throw new Error(`${name}: expected cache HIT, got x-listips-edge-cache=${edgeCache ?? 'missing'}, cf-cache-status=${cfCache ?? 'missing'}.`);
  }
}

function setupSql() {
  return `
INSERT INTO users (
  id, username, email, auth_provider, auth_subject, avatar_url, role, status,
  turnstile_required, list_quota, item_quota_per_list, updated_at
) VALUES (
  ${sql(userId)}, ${sql(config.username)}, ${sql(`${config.username}@listips.local`)}, 'canary', ${sql(config.username)},
  NULL, 'admin', 'active', 0, 100, ${config.size}, datetime('now')
)
ON CONFLICT(id) DO UPDATE SET
  username = excluded.username,
  email = excluded.email,
  status = 'active',
  item_quota_per_list = excluded.item_quota_per_list,
  updated_at = datetime('now');

DELETE FROM lists WHERE id = ${sql(listId)};

INSERT INTO lists (
  id, user_id, name, slug, description, visibility, mode, private_token_policy,
  content, compiled_hash, kv_key, raw_token_hash, raw_token_prefix, raw_token_ciphertext,
  item_count, external_sync_enabled, external_sources_json, last_sync_status, updated_at
) VALUES (
  ${sql(listId)}, ${sql(userId)}, ${sql(`Large canary ${config.size}`)}, ${sql(slug)}, 'Temporary production large-artifact canary.',
  'public', 'allowlist', 'always', ${sql(`${generatedIp(0)}\n`)}, ${sql(hash)}, ${sql(kvKey)}, NULL, NULL, NULL,
  ${config.size}, 0, '[]', NULL, datetime('now')
);
`;
}

function cleanup(options = {}) {
  try {
    const cleanupFile = join(tempDir, 'cleanup.sql');
    writeFileSync(cleanupFile, `DELETE FROM lists WHERE id = ${sql(listId)};\nDELETE FROM users WHERE id = ${sql(userId)};\n`, 'utf8');
    wrangler(['d1', 'execute', config.database, '--remote', '--config', config.wranglerConfig, '--file', cleanupFile, '--yes']);
    deleteR2Object();
  } catch (error) {
    if (!options.bestEffort) throw error;
    console.error(`Best-effort cleanup failed: ${error.message}`);
  }
}

function deleteR2Object() {
  wrangler(['r2', 'object', 'delete', `${config.r2Bucket}/${kvKey}`, '--remote', '--config', config.wranglerConfig, '--force'], { allowFailure: true });
}

function putR2Object() {
  wrangler([
    'r2',
    'object',
    'put',
    `${config.r2Bucket}/${kvKey}`,
    '--remote',
    '--config',
    config.wranglerConfig,
    '--file',
    artifactFile,
    '--content-type',
    'text/plain; charset=utf-8',
    '--force'
  ]);
}

function wrangler(args, options = {}) {
  try {
    execFileSync('npx', ['wrangler', ...args], {
      stdio: options.quiet ? 'pipe' : 'inherit'
    });
  } catch (error) {
    if (options.allowFailure) return;
    throw error;
  }
}

function generateList(size) {
  const lines = [];
  for (let index = 0; index < size; index += 1) {
    lines.push(generatedIp(index));
  }

  return `${lines.join('\n')}\n`;
}

function generatedIp(index) {
  const second = Math.floor(index / 65536) % 256;
  const third = Math.floor(index / 256) % 256;
  const fourth = index % 256;
  return `10.${second}.${third}.${fourth}`;
}

async function sha256Label(value) {
  const bytes = new TextEncoder().encode(value);
  const hashBuffer = await webcrypto.subtle.digest('SHA-256', bytes);
  return `sha256:${[...new Uint8Array(hashBuffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function sql(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function normalizeEtag(value) {
  return value.trim().replace(/^W\//, '');
}

function envInteger(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}
