import { describe, expect, it } from 'vitest';
import { handleLists } from '../src/routes/lists';
import { createSession, createTestEnv } from './helpers';

function jsonRequest(path: string, token: string | null, body?: unknown, method = body ? 'POST' : 'GET') {
  return new Request(`https://listips.test${path}`, {
    method,
    headers: {
      ...(token ? { Cookie: `li_session=${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

async function responseJson<T = Record<string, unknown>>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

describe('list routes', () => {
  it('requires authentication for list APIs', async () => {
    const env = createTestEnv();
    const response = await handleLists(jsonRequest('/api/lists', null), env);
    const payload = await responseJson<{ error: { code: string } }>(response);

    expect(response.status).toBe(401);
    expect(payload.error.code).toBe('unauthorized');
  });

  it('keeps always-visible private tokens available on later reads', async () => {
    const env = createTestEnv();
    const token = await createSession(env);

    const createdResponse = await handleLists(jsonRequest('/api/lists', token, {
      name: 'Office',
      visibility: 'private',
      content: '# note\n192.0.2.10\n'
    }), env);
    const created = await responseJson<{ list: { id: string; rawUrl: string; rawUrlTokenVisible: boolean; privateTokenPolicy: string } }>(createdResponse);

    expect(createdResponse.status).toBe(201);
    expect(created.list.privateTokenPolicy).toBe('always');
    expect(created.list.rawUrl).toMatch(/^https:\/\/listips\.test\/u\/alice\/office\?token=sec_/);
    expect(created.list.rawUrlTokenVisible).toBe(true);

    const readResponse = await handleLists(jsonRequest(`/api/lists/${created.list.id}`, token), env);
    const read = await responseJson<{ list: { rawUrl: string | null; rawUrlRequiresToken: boolean; rawUrlTokenVisible: boolean } }>(readResponse);

    expect(readResponse.status).toBe(200);
    expect(read.list.rawUrl).toBe(created.list.rawUrl);
    expect(read.list.rawUrlRequiresToken).toBe(true);
    expect(read.list.rawUrlTokenVisible).toBe(true);
  });

  it('creates one-time private lists and hides tokens on later reads', async () => {
    const env = createTestEnv();
    const token = await createSession(env);

    const createdResponse = await handleLists(jsonRequest('/api/lists', token, {
      name: 'Office',
      visibility: 'private',
      privateTokenPolicy: 'one_time',
      mode: 'allowlist',
      content: '# note\n192.0.2.10\n'
    }), env);
    const created = await responseJson<{ list: { id: string; rawUrl: string; rawUrlTokenVisible: boolean; itemCount: number } }>(createdResponse);

    expect(createdResponse.status).toBe(201);
    expect(created.list.rawUrl).toMatch(/^https:\/\/listips\.test\/u\/alice\/office\?token=sec_/);
    expect(created.list.rawUrlTokenVisible).toBe(true);
    expect(created.list.itemCount).toBe(2);
    expect(env.__r2.store.get('lists/alice/office')?.value).toBe('# note\n192.0.2.10\n');

    const readResponse = await handleLists(jsonRequest(`/api/lists/${created.list.id}`, token), env);
    const read = await responseJson<{ list: { rawUrl: string | null; rawUrlRequiresToken: boolean; rawUrlTokenVisible: boolean } }>(readResponse);

    expect(readResponse.status).toBe(200);
    expect(read.list.rawUrl).toBeNull();
    expect(read.list.rawUrlRequiresToken).toBe(true);
    expect(read.list.rawUrlTokenVisible).toBe(false);
  });

  it('returns a one-time token when updating a public list to one-time private', async () => {
    const env = createTestEnv();
    const token = await createSession(env);

    const createdResponse = await handleLists(jsonRequest('/api/lists', token, {
      name: 'Office',
      visibility: 'public',
      mode: 'allowlist',
      content: '192.0.2.10\n'
    }), env);
    const created = await responseJson<{ list: { id: string; rawUrl: string; rawUrlTokenVisible: boolean } }>(createdResponse);
    expect(created.list.rawUrl).toBe('https://listips.test/u/alice/office');
    expect(created.list.rawUrlTokenVisible).toBe(false);

    const updatedResponse = await handleLists(jsonRequest(`/api/lists/${created.list.id}`, token, {
      visibility: 'private',
      privateTokenPolicy: 'one_time'
    }, 'PUT'), env);
    const updated = await responseJson<{ list: { rawUrl: string; rawUrlTokenVisible: boolean } }>(updatedResponse);

    expect(updatedResponse.status).toBe(200);
    expect(updated.list.rawUrl).toMatch(/^https:\/\/listips\.test\/u\/alice\/office\?token=sec_/);
    expect(updated.list.rawUrlTokenVisible).toBe(true);
    expect(env.__r2.store.get('lists/alice/office')?.customMetadata).toMatchObject({
      visibility: 'private'
    });
  });

  it('rejects invalid list content through the route layer', async () => {
    const env = createTestEnv();
    const token = await createSession(env);

    const response = await handleLists(jsonRequest('/api/lists', token, {
      name: 'Bad',
      visibility: 'public',
      mode: 'allowlist',
      content: 'https://example.com/list.txt\n'
    }), env);
    const payload = await responseJson<{ error: { code: string; message: string } }>(response);

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe('invalid_list_content');
    expect(payload.error.message).toContain('line 1');
    expect(env.__db.lists).toHaveLength(0);
  });

  it('queues external sync once when saving a list with sources', async () => {
    const env = createTestEnv();
    const token = await createSession(env);
    const body = {
      name: 'Cloudflare',
      visibility: 'public',
      mode: 'allowlist',
      content: '192.0.2.10\n',
      externalSources: [{ url: 'https://www.cloudflare.com/ips-v4', enabled: true }]
    };

    const createdResponse = await handleLists(jsonRequest('/api/lists', token, body), env);
    const created = await responseJson<{ list: { id: string }; syncQueued: boolean }>(createdResponse);

    expect(createdResponse.status).toBe(201);
    expect(created.syncQueued).toBe(true);
    expect(env.__queue.messages).toEqual([
      expect.objectContaining({
        listId: created.list.id,
        userId: 'usr_1',
        reason: 'save'
      })
    ]);
    expect(env.__db.lists[0]?.last_sync_status).toBe('queued');

    const updatedResponse = await handleLists(jsonRequest(`/api/lists/${created.list.id}`, token, body, 'PUT'), env);
    const updated = await responseJson<{ syncQueued: boolean }>(updatedResponse);

    expect(updatedResponse.status).toBe(200);
    expect(updated.syncQueued).toBe(false);
    expect(env.__queue.messages).toHaveLength(1);
  });
});
