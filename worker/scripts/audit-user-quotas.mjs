#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const defaults = {
  listQuota: envInteger('LISTIPS_QUOTA_DEFAULT_LISTS', 100),
  itemQuota: envInteger('LISTIPS_QUOTA_DEFAULT_ITEMS_PER_LIST', 500)
};
const database = process.env.LISTIPS_QUOTA_D1_DATABASE ?? 'listips';
const wranglerConfig = process.env.LISTIPS_QUOTA_WRANGLER_CONFIG ?? 'worker/wrangler.toml';
const showAll = process.env.LISTIPS_QUOTA_AUDIT_ALL === '1';

const where = showAll
  ? '1 = 1'
  : `list_quota != ${defaults.listQuota} OR item_quota_per_list != ${defaults.itemQuota} OR role != 'user'`;
const command = `
SELECT
  username,
  role,
  status,
  list_quota,
  item_quota_per_list,
  updated_at
FROM users
WHERE ${where}
ORDER BY item_quota_per_list DESC, list_quota DESC, username ASC;
`;

const output = execFileSync('npx', [
  'wrangler',
  'd1',
  'execute',
  database,
  '--remote',
  '--config',
  wranglerConfig,
  '--command',
  command,
  '--json'
], { encoding: 'utf8' });

const parsed = JSON.parse(output);
const rows = parsed.flatMap((entry) => entry.results ?? []);

if (rows.length === 0) {
  console.log(`No non-default quotas found. Defaults: lists=${defaults.listQuota}, itemsPerList=${defaults.itemQuota}.`);
} else {
  console.table(rows.map((row) => ({
    username: row.username,
    role: row.role,
    status: row.status,
    lists: row.list_quota,
    itemsPerList: row.item_quota_per_list,
    updatedAt: row.updated_at
  })));
}

function envInteger(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}
