import type { Env } from '../types';

export interface CompiledListMetadata {
  hash?: string;
  itemCount?: number;
  visibility?: 'public' | 'private';
  privateTokenPolicy?: 'always' | 'one_time';
  rawTokenHash?: string | null;
  updatedAt?: string | null;
}

export interface CompiledListArtifact {
  content: string;
  metadata: CompiledListMetadata;
}

interface PublicationRow {
  content: string;
  compiled_hash: string | null;
  item_count: number;
  visibility: 'public' | 'private';
  private_token_policy: 'always' | 'one_time';
  raw_token_hash: string | null;
  updated_at: string;
}

export async function getCompiledList(env: Env, key: string): Promise<CompiledListArtifact | null> {
  const object = await env.LISTS_R2.get(key);
  if (!object) return null;

  return {
    content: await object.text(),
    metadata: metadataFromR2(object.customMetadata ?? {})
  };
}

export async function getCompiledListForRaw(env: Env, key: string, username: string, slug: string): Promise<CompiledListArtifact | null> {
  const artifact = await getCompiledList(env, key);
  if (artifact && hasRequiredRawMetadata(artifact.metadata)) return artifact;

  const row = await env.DB.prepare(
    `SELECT
       lists.content,
       lists.compiled_hash,
       lists.item_count,
       lists.visibility,
       lists.private_token_policy,
       lists.raw_token_hash,
       lists.updated_at
     FROM lists
     JOIN users ON users.id = lists.user_id
     WHERE users.username = ?
       AND lists.slug = ?
       AND users.status = 'active'`
  ).bind(username, slug).first<PublicationRow>();

  if (!row) return artifact;

  const content = artifact?.content ?? row.content;
  const metadata = publicationMetadata(row);
  await putCompiledList(env, key, content, metadata);
  return { content, metadata };
}

export async function putCompiledList(env: Env, key: string, content: string, metadata: CompiledListMetadata): Promise<void> {
  await env.LISTS_R2.put(key, content, {
    httpMetadata: {
      contentType: 'text/plain; charset=utf-8'
    },
    customMetadata: metadataToR2(metadata)
  });
}

export async function deleteCompiledList(env: Env, key: string): Promise<void> {
  await env.LISTS_R2.delete(key);
}

function metadataToR2(metadata: CompiledListMetadata): Record<string, string> {
  return {
    ...(metadata.hash ? { hash: metadata.hash } : {}),
    ...(metadata.itemCount !== undefined ? { itemCount: String(metadata.itemCount) } : {}),
    ...(metadata.visibility ? { visibility: metadata.visibility } : {}),
    ...(metadata.privateTokenPolicy ? { privateTokenPolicy: metadata.privateTokenPolicy } : {}),
    ...(metadata.rawTokenHash ? { rawTokenHash: metadata.rawTokenHash } : {}),
    ...(metadata.updatedAt ? { updatedAt: metadata.updatedAt } : {})
  };
}

function metadataFromR2(metadata: Record<string, string>): CompiledListMetadata {
  const itemCount = metadata.itemCount ? Number(metadata.itemCount) : undefined;
  return {
    hash: metadata.hash,
    itemCount: Number.isFinite(itemCount) ? itemCount : undefined,
    visibility: metadata.visibility === 'private' ? 'private' : 'public',
    privateTokenPolicy: metadata.privateTokenPolicy === 'one_time' ? 'one_time' : 'always',
    rawTokenHash: metadata.rawTokenHash ?? null,
    updatedAt: metadata.updatedAt ?? null
  };
}

function hasRequiredRawMetadata(metadata: CompiledListMetadata): boolean {
  return Boolean(metadata.hash && metadata.visibility && metadata.itemCount !== undefined);
}

function publicationMetadata(row: PublicationRow): CompiledListMetadata {
  return {
    hash: row.compiled_hash ?? undefined,
    itemCount: row.item_count,
    visibility: row.visibility,
    privateTokenPolicy: row.private_token_policy,
    rawTokenHash: row.raw_token_hash,
    updatedAt: row.updated_at
  };
}
