import { describe, expect, it } from 'vitest';
import { compileListContent, ContentValidationError } from '../src/validation/content';

describe('compileListContent', () => {
  it('accepts comments, IPv4, IPv4 CIDR, IPv6, and IPv6 CIDR', async () => {
    const compiled = await compileListContent(
      '# Office ranges\n192.0.2.10\n198.51.100.0/24\n2001:db8::1\n2001:db8::/32\n',
      500
    );

    expect(compiled.items).toHaveLength(4);
    expect(compiled.comments).toEqual(['# Office ranges']);
    expect(compiled.entryCount).toBe(5);
    expect(compiled.content).toContain('# Office ranges\n');
    expect(compiled.hash).toMatch(/^sha256:/);
  });

  it('deduplicates IP entries but preserves comments', async () => {
    const compiled = await compileListContent(
      '# First\n192.0.2.10\n# Second\n192.0.2.10\n',
      500
    );

    expect(compiled.items).toEqual(['192.0.2.10']);
    expect(compiled.entryCount).toBe(3);
    expect(compiled.content).toBe('# First\n192.0.2.10\n# Second\n');
  });

  it('cuts comments to 100 characters and counts comments toward the limit', async () => {
    const longComment = `# ${'a'.repeat(140)}`;
    const compiled = await compileListContent(`${longComment}\n192.0.2.10\n`, 2);

    expect(compiled.comments[0]).toHaveLength(100);
    expect(compiled.content.split('\n')[0]).toHaveLength(100);
    expect(compiled.entryCount).toBe(2);
    await expect(compileListContent('# First\n192.0.2.10\n', 1)).rejects.toBeInstanceOf(ContentValidationError);
  });

  it('rejects URLs and inline comments', async () => {
    await expect(compileListContent('https://example.com/list.txt\n', 500)).rejects.toBeInstanceOf(ContentValidationError);
    await expect(compileListContent('192.0.2.10 # office\n', 500)).rejects.toBeInstanceOf(ContentValidationError);
  });

  it('rejects invalid CIDR prefixes', async () => {
    await expect(compileListContent('192.0.2.0/33\n', 500)).rejects.toBeInstanceOf(ContentValidationError);
    await expect(compileListContent('2001:db8::/129\n', 500)).rejects.toBeInstanceOf(ContentValidationError);
  });

  it('enforces entry limits for output lines', async () => {
    await expect(compileListContent('192.0.2.1\n192.0.2.2\n', 1)).rejects.toMatchObject({
      issues: [{
        line: 1,
        message: 'Compiled list has 2 output lines; the current limit is 1. Remove entries/comments or increase the list quota.'
      }]
    });
  });
});
