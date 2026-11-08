import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { getAuthContext, logout, requireAuth } from '../src/services/auth';
import { sha256Hex } from '../src/services/crypto';

const databases = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

async function fixture(testSession = true) {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  db.exec(`CREATE TABLE users (
    id TEXT PRIMARY KEY, username TEXT, email TEXT, auth_provider TEXT,
    auth_subject TEXT, avatar_url TEXT, role TEXT, status TEXT,
    list_quota INTEGER, item_quota_per_list INTEGER
  ); CREATE TABLE sessions (
    id TEXT PRIMARY KEY, user_id TEXT, token_hash TEXT,
    created_at TEXT DEFAULT (datetime('now')), expires_at TEXT, last_seen_at TEXT
  ); INSERT INTO users VALUES (
    'usr_smoke_viweb_technology', 'viweb-technology', 'smoke@example.invalid',
    'smoke', 'viweb-technology', NULL, 'user', 'active', 100, 500
  );`);
  const token = (testSession ? 'test_sess_' : 'sess_') + randomBytes(32).toString('hex');
  const secret = 'ordinary-session-secret';
  const hash = testSession ? `test:${await sha256Hex(token)}` : await sha256Hex(`${secret}:${token}`);
  db.prepare(`INSERT INTO sessions (id, user_id, token_hash, expires_at)
    VALUES (?, 'usr_smoke_viweb_technology', ?, datetime('now', '+10 minutes'))`
  ).run(testSession ? 'testsign_11111111-1111-4111-8111-111111111111' : 'ordinary-session', hash);
  // Execute the application's actual SQL against SQLite, including its guards.
  const env = { SESSION_SECRET: secret, DB: { prepare(sql) {
    return { bind(...args) { return {
      async first() { return db.prepare(sql).get(...args) ?? null; },
      async run() { db.prepare(sql).run(...args); return { success: true }; }
    }; } };
  } } };
  const request = new Request('https://listips.com/api/auth/me', { headers: { Cookie: `li_session=${token}` } });
  return { db, env, request, token };
}

describe('operator-issued fixture sessions', () => {
  it('authenticates the dedicated fixture and updates last seen using the ordinary cookie path', async () => {
    const { db, env, request } = await fixture();
    expect(await getAuthContext(request, env)).toMatchObject({ user: { username: 'viweb-technology' } });
    expect(db.prepare('SELECT last_seen_at FROM sessions').get()?.last_seen_at).toBeTruthy();
  });

  it.each([
    ['another identity', "UPDATE users SET id = 'another-user'; UPDATE sessions SET user_id = 'another-user'"],
    ['another username', "UPDATE users SET username = 'ordinary-user'"],
    ['GitHub identity', "UPDATE users SET auth_provider = 'github'"],
    ['admin role', "UPDATE users SET role = 'admin'"],
    ['inactive account', "UPDATE users SET status = 'disabled'"],
    ['elevated item quota', 'UPDATE users SET item_quota_per_list = 10000'],
    ['elevated list quota', 'UPDATE users SET list_quota = 1000'],
    ['unscoped session ID', "UPDATE sessions SET id = 'ordinary-session'"],
    ['expired token', "UPDATE sessions SET expires_at = datetime('now', '-1 minute')"],
    ['TTL above 15 minutes', "UPDATE sessions SET expires_at = datetime(created_at, '+16 minutes')"],
    ['old issuance', "UPDATE sessions SET created_at = datetime('now', '-16 minutes')"],
    ['future issuance', "UPDATE sessions SET created_at = datetime('now', '+1 minute')"],
    ['invalid issuance', "UPDATE sessions SET created_at = 'invalid'"],
  ])('rejects %s even if an operator inserted a matching token hash', async (_name, sql) => {
    const { db, env, request } = await fixture();
    db.exec(sql);
    expect(await getAuthContext(request, env)).toBeNull();
  });

  it('accepts the exact maximum lifetime', async () => {
    const { db, env, request } = await fixture();
    db.exec("UPDATE sessions SET expires_at = datetime(created_at, '+15 minutes')");
    expect(await getAuthContext(request, env)).not.toBeNull();
  });

  it('requires the full random token and supports revocation through ordinary logout', async () => {
    const { db, env, request, token } = await fixture();
    const wrong = new Request(request.url, { headers: { Cookie: `li_session=${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}` } });
    expect(await getAuthContext(wrong, env)).toBeNull();
    const response = await logout(request, env);
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect(db.prepare('SELECT COUNT(*) AS count FROM sessions').get()?.count).toBe(0);
    expect(await requireAuth(request, env)).toBeInstanceOf(Response);
    expect((await requireAuth(request, env)).status).toBe(401);
  });

  it('keeps ordinary secret-keyed sessions working without fixture-only restrictions', async () => {
    const { db, env, request } = await fixture(false);
    db.exec("UPDATE users SET username = 'ordinary-user', auth_provider = 'github', role = 'admin'; UPDATE sessions SET expires_at = datetime('now', '+30 days')");
    expect(await getAuthContext(request, env)).toMatchObject({ user: { username: 'ordinary-user' } });
  });
});
