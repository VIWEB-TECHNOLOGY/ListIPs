import { describe, expect, it } from 'vitest';
import { accountSummary, getAuthContext, isReservedOAuthUsername, resolveOAuthUsername } from '../src/services/auth';
import { createSession, createTestEnv } from './helpers';

function authRequest(token = 'test-session') {
  return new Request('https://listips.test/api/auth/me', {
    headers: { Cookie: `li_session=${token}` }
  });
}

describe('auth session tracking', () => {
  it('reserves smoke fixture usernames from OAuth registration', () => {
    expect(isReservedOAuthUsername('viweb')).toBe(true);
    expect(isReservedOAuthUsername('VIWEB')).toBe(true);
    expect(isReservedOAuthUsername('viweb-technology')).toBe(true);
    expect(isReservedOAuthUsername('ViWeb Technology')).toBe(true);
    expect(isReservedOAuthUsername('jaredchu')).toBe(false);
  });

  it('keeps existing OAuth usernames immutable when provider logins change', async () => {
    const env = createTestEnv();

    await expect(resolveOAuthUsername(env, 'jaredchu', {
      id: 'usr_1',
      username: 'alice'
    })).resolves.toBe('alice');
  });

  it('updates last_seen_at when the session has not been seen before', async () => {
    const env = createTestEnv();
    await createSession(env, 'usr_1', 'test-session', null);

    const auth = await getAuthContext(authRequest(), env);

    expect(auth?.user.username).toBe('alice');
    expect(env.__db.sessionLastSeenUpdates).toBe(1);
    expect(env.__db.sessions[0].last_seen_at).not.toBeNull();
  });

  it('does not write last_seen_at for fresh sessions', async () => {
    const env = createTestEnv();
    await createSession(env, 'usr_1', 'test-session', new Date().toISOString());

    const auth = await getAuthContext(authRequest(), env);

    expect(auth?.user.username).toBe('alice');
    expect(env.__db.sessionLastSeenUpdates).toBe(0);
  });

  it('updates last_seen_at for stale sessions', async () => {
    const env = createTestEnv();
    const stale = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    await createSession(env, 'usr_1', 'test-session', stale);

    const auth = await getAuthContext(authRequest(), env);

    expect(auth?.user.username).toBe('alice');
    expect(env.__db.sessionLastSeenUpdates).toBe(1);
  });

  it('returns account type, group, and quotas in the account summary', async () => {
    const env = createTestEnv({
      id: 'usr_1',
      username: 'alice',
      email: 'alice@example.com',
      auth_provider: 'github',
      auth_subject: '1',
      avatar_url: null,
      role: 'user',
      status: 'active',
      list_quota: 100,
      item_quota_per_list: 10000
    });
    await createSession(env);

    const response = await accountSummary(authRequest(), env);
    const payload = await response.json<{ account: Record<string, unknown> }>();

    expect(response.status).toBe(200);
    expect(payload.account).toMatchObject({
      username: 'alice',
      role: 'user',
      accountType: 'Internal test',
      accountGroup: 'user',
      quotas: {
        lists: 100,
        itemsPerList: 10000
      }
    });
  });
});
