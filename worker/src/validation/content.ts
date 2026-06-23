import ipaddr from 'ipaddr.js';
import { sha256Label } from '../services/crypto';

const IP_CIDR_CHARS = /^[0-9A-Fa-f:.]+(?:\/[0-9]{1,3})?$/;
const COMMENT_LINE = /^#[ A-Za-z0-9._:\/,+()[\]-]{0,99}$/;
const COMMENT_MAX_CHARS = 100;

export interface CompiledList {
  content: string;
  items: string[];
  comments: string[];
  entryCount: number;
  hash: string;
}

export interface ValidationIssue {
  line: number;
  message: string;
}

export class ContentValidationError extends Error {
  constructor(public readonly issues: ValidationIssue[]) {
    super('List content contains invalid lines.');
  }
}

export async function compileListContent(input: string, itemLimit: number): Promise<CompiledList> {
  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  const output: string[] = [];
  const items: string[] = [];
  const comments: string[] = [];
  const seenItems = new Set<string>();
  const issues: ValidationIssue[] = [];

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

    if (new TextEncoder().encode(line).byteLength > 128) {
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
    throw new ContentValidationError(issues);
  }

  if (items.length === 0) {
    throw new ContentValidationError([{ line: 1, message: 'At least one IP or CIDR entry is required.' }]);
  }

  if (output.length > itemLimit) {
    throw new ContentValidationError([{
      line: 1,
      message: `Compiled list has ${output.length} output lines; the current limit is ${itemLimit}. Remove entries/comments or increase the list quota.`
    }]);
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

function normalizeIpOrCidr(value: string): string | null {
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
