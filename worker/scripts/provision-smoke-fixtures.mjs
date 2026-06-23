#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';

const config = {
  appOrigin: process.env.LISTIPS_SMOKE_APP_ORIGIN ?? 'https://listips.com',
  wranglerConfig: process.env.LISTIPS_SMOKE_WRANGLER_CONFIG ?? 'worker/wrangler.toml',
  database: process.env.LISTIPS_SMOKE_D1_DATABASE ?? 'listips',
  r2Bucket: process.env.LISTIPS_SMOKE_R2_BUCKET ?? 'listips-compiled',
  username: process.env.LISTIPS_SMOKE_USERNAME ?? 'viweb-technology',
  tokens: {
    alwaysManual: smokeToken('LISTIPS_SMOKE_TOKEN_ALWAYS_MANUAL', 'sec_local_smoke_always_manual'),
    alwaysSynced: smokeToken('LISTIPS_SMOKE_TOKEN_ALWAYS_SYNCED', 'sec_local_smoke_always_synced'),
    oneTimeManual: smokeToken('LISTIPS_SMOKE_TOKEN_ONE_TIME_MANUAL', 'sec_local_smoke_one_time_manual'),
    oneTimeSynced: smokeToken('LISTIPS_SMOKE_TOKEN_ONE_TIME_SYNCED', 'sec_local_smoke_one_time_synced')
  }
};

const userId = `usr_smoke_${config.username.replace(/[^a-z0-9]+/g, '_')}`;
const fixtureIdPrefix = `lst_smoke_${config.username.replace(/[^a-z0-9]+/g, '_')}`;
const tempDir = mkdtempSync(join(tmpdir(), 'listips-smoke-fixtures-'));
const sqlFile = join(tempDir, 'fixtures.sql');

const fixtures = [
  fixture({
    slug: 'public-manual',
    name: 'Smoke public manual',
    visibility: 'public',
    token: null,
    externalSources: [],
    content: '# smoke public manual\n192.0.2.10\n'
  }),
  fixture({
    slug: 'public-synced',
    name: 'Smoke public synced',
    visibility: 'public',
    token: null,
    externalSources: [{ url: 'https://www.cloudflare.com/ips-v4', enabled: true }],
    content: '# smoke public synced\n192.0.2.20\n173.245.48.0/20\n'
  }),
  fixture({
    slug: 'private-always-manual',
    name: 'Smoke private always manual',
    visibility: 'private',
    privateTokenPolicy: 'always',
    token: config.tokens.alwaysManual,
    externalSources: [],
    content: '# smoke private always manual\n192.0.2.30\n'
  }),
  fixture({
    slug: 'private-always-synced',
    name: 'Smoke private always synced',
    visibility: 'private',
    privateTokenPolicy: 'always',
    token: config.tokens.alwaysSynced,
    externalSources: [{ url: 'https://www.cloudflare.com/ips-v4', enabled: true }],
    content: '# smoke private always synced\n192.0.2.40\n173.245.48.0/20\n'
  }),
  fixture({
    slug: 'private-one-time-manual',
    name: 'Smoke private one-time manual',
    visibility: 'private',
    privateTokenPolicy: 'one_time',
    token: config.tokens.oneTimeManual,
    externalSources: [],
    content: '# smoke private one-time manual\n192.0.2.50\n'
  }),
  fixture({
    slug: 'private-one-time-synced',
    name: 'Smoke private one-time synced',
    visibility: 'private',
    privateTokenPolicy: 'one_time',
    token: config.tokens.oneTimeSynced,
    externalSources: [{ url: 'https://www.cloudflare.com/ips-v4', enabled: true }],
    content: '# smoke private one-time synced\n192.0.2.60\n173.245.48.0/20\n'
  })
];

try {
  for (const item of fixtures) {
    item.hash = await sha256Label(item.content);
    item.rawTokenHash = item.token ? await sha256Hex(item.token) : null;
    item.artifactFile = join(tempDir, `${item.slug}.txt`);
    writeFileSync(item.artifactFile, item.content, 'utf8');
  }

  writeFileSync(sqlFile, setupSql(), 'utf8');
  wrangler(['d1', 'execute', config.database, '--remote', '--config', config.wranglerConfig, '--file', sqlFile, '--yes']);

  for (const item of fixtures) {
    putR2Object(item);
  }

  console.log(`Provisioned smoke fixtures for ${config.appOrigin}/u/${config.username}/`);
  for (const item of fixtures) {
    console.log(`${item.slug}: ${displayRawUrl(item)}`);
  }
} catch (error) {
  console.error(`Smoke fixture provisioning failed: ${error.message}`);
  process.exit(1);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

function fixture(input) {
  return {
    privateTokenPolicy: 'always',
    mode: 'allowlist',
    ...input,
    id: `${fixtureIdPrefix}_${input.slug.replace(/[^a-z0-9]+/g, '_')}`,
    kvKey: `lists/${config.username}/${input.slug}`,
    itemCount: input.content.trimEnd().split('\n').length
  };
}

function smokeToken(envName, fallback) {
  return process.env[envName] ?? fallback;
}

function setupSql() {
  return `
INSERT INTO users (
  id, username, email, auth_provider, auth_subject, avatar_url, role, status,
  turnstile_required, list_quota, item_quota_per_list, updated_at
) VALUES (
  ${sql(userId)}, ${sql(config.username)}, ${sql(`${config.username}@listips.local`)}, 'smoke', ${sql(config.username)},
  NULL, 'user', 'active', 0, 100, 500, datetime('now')
)
ON CONFLICT(username) DO UPDATE SET
  email = excluded.email,
  auth_provider = excluded.auth_provider,
  auth_subject = excluded.auth_subject,
  status = 'active',
  role = 'user',
  turnstile_required = 0,
  list_quota = 100,
  item_quota_per_list = 500,
  updated_at = datetime('now');

DELETE FROM lists
WHERE user_id = (SELECT id FROM users WHERE username = ${sql(config.username)})
  AND slug IN (${fixtures.map((item) => sql(item.slug)).join(', ')});

${fixtures.map(insertListSql).join('\n')}
`;
}

function insertListSql(item) {
  return `
INSERT INTO lists (
  id, user_id, name, slug, description, visibility, mode, private_token_policy,
  content, compiled_hash, kv_key, raw_token_hash, raw_token_prefix, raw_token_ciphertext,
  item_count, external_sync_enabled, external_sources_json, last_synced_at, last_sync_status, last_sync_error,
  next_sync_at, sync_failure_count, updated_at
) VALUES (
  ${sql(item.id)}, (SELECT id FROM users WHERE username = ${sql(config.username)}), ${sql(item.name)}, ${sql(item.slug)}, 'Stable production raw smoke fixture.',
  ${sql(item.visibility)}, ${sql(item.mode)}, ${sql(item.privateTokenPolicy)}, ${sql(item.content)}, ${sql(item.hash)}, ${sql(item.kvKey)},
  ${item.rawTokenHash ? sql(item.rawTokenHash) : 'NULL'}, ${item.token ? sql(item.token.slice(0, 12)) : 'NULL'}, NULL,
  ${item.itemCount}, ${item.externalSources.length ? 1 : 0}, ${sql(JSON.stringify(item.externalSources))},
  ${item.externalSources.length ? "datetime('now')" : 'NULL'}, ${item.externalSources.length ? "'ok'" : 'NULL'}, NULL,
  ${item.externalSources.length ? "datetime('now', '+24 hours')" : 'NULL'}, 0, datetime('now')
);
`;
}

function putR2Object(item) {
  wrangler([
    'r2',
    'object',
    'put',
    `${config.r2Bucket}/${item.kvKey}`,
    '--remote',
    '--config',
    config.wranglerConfig,
    '--file',
    item.artifactFile,
    '--content-type',
    'text/plain; charset=utf-8',
    '--force'
  ]);
}

function rawUrl(item) {
  const url = new URL(`${config.appOrigin}/u/${config.username}/${item.slug}`);
  if (item.token) url.searchParams.set('token', item.token);
  return url.toString();
}

function displayRawUrl(item) {
  const url = new URL(rawUrl(item));
  if (url.searchParams.has('token')) url.searchParams.set('token', 'redacted');
  return url.toString();
}

function wrangler(args) {
  execFileSync('npx', ['wrangler', ...args], {
    stdio: 'inherit',
    env: {
      ...process.env,
      WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH ?? '.wrangler/logs'
    }
  });
}

async function sha256Label(value) {
  return `sha256:${await sha256Hex(value)}`;
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const hashBuffer = await webcrypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hashBuffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sql(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
