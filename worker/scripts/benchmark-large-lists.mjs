#!/usr/bin/env node

import { performance } from 'node:perf_hooks';
import { webcrypto } from 'node:crypto';
import ipaddr from 'ipaddr.js';

const IP_CIDR_CHARS = /^[0-9A-Fa-f:.]+(?:\/[0-9]{1,3})?$/;
const COMMENT_LINE = /^#[ A-Za-z0-9._:\/,+()[\]-]{0,99}$/;
const COMMENT_MAX_CHARS = 100;
const DEFAULT_SIZES = [500, 1000, 5000, 10000, 50000];

const config = {
  sizes: envNumberList('LISTIPS_BENCH_SIZES', DEFAULT_SIZES),
  runs: envNumber('LISTIPS_BENCH_RUNS', 3),
  includeCommentsEvery: envNumber('LISTIPS_BENCH_COMMENT_EVERY', 0, { allowZero: true })
};

const rows = [];

for (const size of config.sizes) {
  const input = generateList(size, config.includeCommentsEvery);
  const inputBytes = byteLength(input);
  const compileTimings = [];
  const publishTimings = [];
  const rawReadTimings = [];
  let compiled = null;

  for (let run = 0; run < config.runs; run += 1) {
    const compileStart = performance.now();
    compiled = await compileListContent(input, Number.MAX_SAFE_INTEGER);
    compileTimings.push(performance.now() - compileStart);

    const publishStart = performance.now();
    const object = await putCompiledList(compiled.content, {
      hash: compiled.hash,
      itemCount: String(compiled.entryCount),
      visibility: 'public'
    });
    publishTimings.push(performance.now() - publishStart);

    const rawStart = performance.now();
    await readRawResponse(object);
    rawReadTimings.push(performance.now() - rawStart);
  }

  rows.push({
    requestedItems: size,
    outputLines: compiled.entryCount,
    inputKB: kb(inputBytes),
    outputKB: kb(byteLength(compiled.content)),
    compileMsP50: rounded(percentile(compileTimings, 0.5)),
    compileMsP95: rounded(percentile(compileTimings, 0.95)),
    publishMsP50: rounded(percentile(publishTimings, 0.5)),
    rawReadMsP50: rounded(percentile(rawReadTimings, 0.5)),
    hash: compiled.hash
  });
}

console.table(rows);

function generateList(size, commentEvery) {
  const lines = [];
  for (let index = 0; index < size; index += 1) {
    if (commentEvery > 0 && index > 0 && index % commentEvery === 0) {
      lines.push(`# generated block ${index}`);
    }

    const second = Math.floor(index / 65536) % 256;
    const third = Math.floor(index / 256) % 256;
    const fourth = index % 256;
    lines.push(`10.${second}.${third}.${fourth}`);
  }

  return `${lines.join('\n')}\n`;
}

async function compileListContent(input, itemLimit) {
  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  const output = [];
  const items = [];
  const comments = [];
  const seenItems = new Set();
  const issues = [];

  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = rawLine.trim();
    if (line.length === 0) return;

    if (line.startsWith('#')) {
      const comment = line.slice(0, COMMENT_MAX_CHARS);
      if (!COMMENT_LINE.test(comment)) {
        issues.push({ line: lineNumber, message: 'Comment must start with # and contain only safe printable characters.' });
        return;
      }

      comments.push(comment);
      output.push(comment);
      return;
    }

    if (byteLength(line) > 128) {
      issues.push({ line: lineNumber, message: 'Line exceeds 128 bytes.' });
      return;
    }

    if (!IP_CIDR_CHARS.test(line)) {
      issues.push({ line: lineNumber, message: 'Line must be an IPv4, IPv6, IPv4 CIDR, IPv6 CIDR, or # comment.' });
      return;
    }

    const normalized = normalizeIpOrCidr(line);
    if (!normalized) {
      issues.push({ line: lineNumber, message: 'Invalid IP or CIDR value.' });
      return;
    }

    if (!seenItems.has(normalized)) {
      seenItems.add(normalized);
      items.push(normalized);
      output.push(normalized);
    }
  });

  if (issues.length > 0) {
    throw new Error(`Generated benchmark input has validation issues: ${JSON.stringify(issues.slice(0, 5))}`);
  }

  if (items.length === 0) {
    throw new Error('Generated benchmark input has no IP/CIDR entries.');
  }

  if (output.length > itemLimit) {
    throw new Error(`Compiled list has ${output.length} output lines; the current limit is ${itemLimit}.`);
  }

  const content = `${output.join('\n')}\n`;
  return {
    content,
    items,
    comments,
    entryCount: output.length,
    hash: await sha256Label(content)
  };
}

function normalizeIpOrCidr(value) {
  try {
    if (value.includes('/')) {
      const [addr, prefix] = ipaddr.parseCIDR(value);
      return `${addr.toNormalizedString()}/${prefix}`;
    }

    return ipaddr.parse(value).toNormalizedString();
  } catch {
    return null;
  }
}

async function putCompiledList(content, metadata) {
  return {
    content,
    metadata
  };
}

async function readRawResponse(object) {
  const response = new Response(object.content, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      ETag: `"${object.metadata.hash}"`,
      'X-ListIPs-Items': object.metadata.itemCount
    }
  });

  return response.text();
}

async function sha256Label(value) {
  const bytes = new TextEncoder().encode(value);
  const hash = await webcrypto.subtle.digest('SHA-256', bytes);
  return `sha256:${[...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function envNumber(name, fallback, options = {}) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  const valid = options.allowZero
    ? Number.isFinite(parsed) && parsed >= 0
    : Number.isFinite(parsed) && parsed > 0;
  if (!valid) throw new Error(`${name} must be a ${options.allowZero ? 'non-negative' : 'positive'} number.`);
  return parsed;
}

function envNumberList(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;

  const parsed = value.split(',').map((item) => Number(item.trim()));
  if (parsed.length === 0 || parsed.some((item) => !Number.isInteger(item) || item <= 0)) {
    throw new Error(`${name} must be a comma-separated list of positive integers.`);
  }

  return parsed;
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[index];
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function kb(bytes) {
  return rounded(bytes / 1024);
}

function rounded(value) {
  return Math.round(value * 100) / 100;
}
