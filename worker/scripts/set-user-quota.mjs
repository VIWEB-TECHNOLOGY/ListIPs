#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const username = requiredEnv('LISTIPS_QUOTA_USERNAME');
const itemQuota = envInteger('LISTIPS_QUOTA_ITEMS_PER_LIST', 500);
const listQuota = envInteger('LISTIPS_QUOTA_LISTS', 100);
const role = process.env.LISTIPS_QUOTA_ROLE;
const database = process.env.LISTIPS_QUOTA_D1_DATABASE ?? 'listips';
const wranglerConfig = process.env.LISTIPS_QUOTA_WRANGLER_CONFIG ?? 'worker/wrangler.toml';

const assignments = [
  `item_quota_per_list = ${itemQuota}`,
  `list_quota = ${listQuota}`,
  ...(role ? [`role = ${sql(role)}`] : []),
  "updated_at = datetime('now')"
].join(', ');

const command = `UPDATE users SET ${assignments} WHERE username = ${sql(username)};`;

execFileSync('npx', [
  'wrangler',
  'd1',
  'execute',
  database,
  '--remote',
  '--config',
  wranglerConfig,
  '--command',
  command,
  '--yes'
], { stdio: 'inherit' });

console.log(`Updated quota for ${username}: lists=${listQuota}, itemsPerList=${itemQuota}${role ? `, role=${role}` : ''}`);

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) {
    throw new Error(`${name} must be a valid ListIPs username.`);
  }
  return value;
}

function envInteger(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function sql(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
