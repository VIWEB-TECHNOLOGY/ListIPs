import type { AuthContext, Env, User } from '../types';
import { clearSessionCookie, parseCookies, sessionCookie } from './cookies';
import { randomToken, sha256Hex } from './crypto';
import { applySecurityHeaders, errorJson, json } from './response';

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const OAUTH_STATE_TTL_SECONDS = 60 * 10;
const SESSION_LAST_SEEN_UPDATE_SECONDS = 60 * 15;
const RESERVED_OAUTH_USERNAMES = new Set(['viweb', 'viweb-technology']);

interface GitHubUser {
  id: number;
  login: string;
  avatar_url: string | null;
  email: string | null;
}

interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

export async function requireAuth(request: Request, env: Env): Promise<AuthContext | Response> {
  const auth = await getAuthContext(request, env);
  if (!auth) return errorJson(401, 'unauthorized', 'Authentication required.');
  if (auth.user.status !== 'active') return errorJson(403, 'account_inactive', 'Account is not active.');
  return auth;
}

export async function getAuthContext(request: Request, env: Env): Promise<AuthContext | null> {
  const token = parseCookies(request).get('li_session') ?? bearerToken(request);
  if (!token) return null;

  const tokenHash = await sha256Hex(`${env.SESSION_SECRET}:${token}`);
  const row = await env.DB.prepare(
    `SELECT
      sessions.id AS session_id,
      users.id,
      users.username,
      users.email,
      users.auth_provider,
      users.auth_subject,
      users.avatar_url,
      users.role,
      users.status,
      users.list_quota,
      users.item_quota_per_list,
      sessions.last_seen_at
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ?
      AND sessions.expires_at > datetime('now')`
  ).bind(tokenHash).first<User & { session_id: string; last_seen_at: string | null }>();

  if (!row) return null;

  if (shouldUpdateLastSeen(row.last_seen_at)) {
    await env.DB.prepare(
      `UPDATE sessions SET last_seen_at = datetime('now') WHERE id = ?`
    ).bind(row.session_id).run();
  }

  const { session_id: sessionId, last_seen_at: _lastSeenAt, ...user } = row;
  return { user, sessionId };
}

export async function startGitHubOAuth(request: Request, env: Env): Promise<Response> {
  const state = randomToken('oauth_', 24);
  const stateHash = await sha256Hex(`${env.SESSION_SECRET}:${state}`);
  const redirectPath = new URL(request.url).searchParams.get('redirect') ?? '/dashboard';

  await env.DB.prepare(
    `INSERT INTO oauth_states (state_hash, provider, redirect_path, expires_at)
     VALUES (?, 'github', ?, datetime('now', ?))`
  ).bind(stateHash, safeRedirectPath(redirectPath), `+${OAUTH_STATE_TTL_SECONDS} seconds`).run();

  const authorizeUrl = new URL('https://github.com/login/oauth/authorize');
  authorizeUrl.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  authorizeUrl.searchParams.set('redirect_uri', env.GITHUB_OAUTH_REDIRECT_URI);
  authorizeUrl.searchParams.set('scope', 'read:user user:email');
  authorizeUrl.searchParams.set('state', state);

  const githubHeaders = new Headers({ Location: authorizeUrl.toString() });
  applySecurityHeaders(githubHeaders);
  return new Response(null, { status: 302, headers: githubHeaders });
}

export async function finishGitHubOAuth(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code || !state) {
    return errorJson(400, 'invalid_oauth_callback', 'Missing OAuth callback parameters.');
  }

  const stateHash = await sha256Hex(`${env.SESSION_SECRET}:${state}`);
  const storedState = await env.DB.prepare(
    `SELECT state_hash, redirect_path
     FROM oauth_states
     WHERE state_hash = ?
       AND provider = 'github'
       AND expires_at > datetime('now')`
  ).bind(stateHash).first<{ state_hash: string; redirect_path: string }>();

  if (!storedState) {
    return errorJson(400, 'invalid_oauth_state', 'OAuth state is invalid or expired.');
  }

  await env.DB.prepare(`DELETE FROM oauth_states WHERE state_hash = ?`).bind(stateHash).run();

  const accessToken = await exchangeGitHubCode(env, code);
  const githubUser = await fetchGitHubUser(accessToken);
  const email = githubUser.email ?? await fetchGitHubPrimaryEmail(accessToken);

  if (!email) {
    return errorJson(400, 'github_email_required', 'GitHub account must expose a verified email address.');
  }

  if (isReservedOAuthUsername(githubUser.login)) {
    return errorJson(403, 'username_reserved', 'This username is reserved.');
  }

  const user = await upsertOAuthUser(env, {
    provider: 'github',
    subject: String(githubUser.id),
    username: githubUser.login,
    email,
    avatarUrl: githubUser.avatar_url
  });

  const token = randomToken('sess_', 32);
  const sessionId = crypto.randomUUID();
  const tokenHash = await sha256Hex(`${env.SESSION_SECRET}:${token}`);

  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at)
     VALUES (?, ?, ?, datetime('now', ?))`
  ).bind(sessionId, user.id, tokenHash, `+${SESSION_TTL_SECONDS} seconds`).run();

  const redirectUrl = new URL(storedState.redirect_path, env.APP_ORIGIN);
  const sessionHeaders = new Headers({
    Location: redirectUrl.toString(),
    'Set-Cookie': sessionCookie(token, SESSION_TTL_SECONDS)
  });
  applySecurityHeaders(sessionHeaders);

  return new Response(null, {
    status: 302,
    headers: sessionHeaders
  });
}

export async function logout(request: Request, env: Env): Promise<Response> {
  const auth = await getAuthContext(request, env);
  if (auth) {
    await env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(auth.sessionId).run();
  }

  return json({ ok: true }, {
    headers: {
      'Set-Cookie': clearSessionCookie()
    }
  });
}

export async function me(request: Request, env: Env): Promise<Response> {
  const auth = await getAuthContext(request, env);
  if (!auth) return errorJson(401, 'unauthorized', 'Authentication required.');

  const usage = await getAccountUsage(env, auth.user.id);

  return json({
    user: {
      id: auth.user.id,
      username: auth.user.username,
      email: auth.user.email,
      avatarUrl: auth.user.avatar_url,
      listQuota: auth.user.list_quota,
      itemQuotaPerList: auth.user.item_quota_per_list,
      authProvider: auth.user.auth_provider
    },
    usage
  });
}

export async function accountSummary(request: Request, env: Env): Promise<Response> {
  const auth = await getAuthContext(request, env);
  if (!auth) return errorJson(401, 'unauthorized', 'Authentication required.');

  const usage = await getAccountUsage(env, auth.user.id);
  return json({
    account: {
      id: auth.user.id,
      username: auth.user.username,
      email: auth.user.email,
      avatarUrl: auth.user.avatar_url,
      authProvider: auth.user.auth_provider,
      role: auth.user.role,
      accountType: accountType(auth.user),
      accountGroup: auth.user.role,
      status: auth.user.status,
      quotas: {
        lists: auth.user.list_quota,
        itemsPerList: auth.user.item_quota_per_list
      },
      usage
    }
  });
}

async function getAccountUsage(env: Env, userId: string) {
  const row = await env.DB.prepare(
    `SELECT
      COUNT(*) AS list_count,
      COALESCE(SUM(item_count), 0) AS total_items,
      COALESCE(MAX(item_count), 0) AS max_items,
      SUM(CASE WHEN visibility = 'public' THEN 1 ELSE 0 END) AS public_lists,
      SUM(CASE WHEN visibility = 'private' THEN 1 ELSE 0 END) AS private_lists,
      SUM(CASE WHEN external_sync_enabled = 1 THEN 1 ELSE 0 END) AS synced_lists
     FROM lists
     WHERE user_id = ?`
  ).bind(userId).first<{
    list_count: number;
    total_items: number;
    max_items: number;
    public_lists: number;
    private_lists: number;
    synced_lists: number;
  }>();

  return {
    listCount: row?.list_count ?? 0,
    totalItems: row?.total_items ?? 0,
    maxItemsInList: row?.max_items ?? 0,
    publicLists: row?.public_lists ?? 0,
    privateLists: row?.private_lists ?? 0,
    syncedLists: row?.synced_lists ?? 0
  };
}

function accountType(user: User): string {
  if (user.role === 'admin') return 'Admin';
  if (user.item_quota_per_list >= 50000) return 'Large';
  if (user.item_quota_per_list >= 10000) return 'Internal test';
  return 'Free';
}

async function exchangeGitHubCode(env: Env, code: string): Promise<string> {
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'ListIPs'
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: env.GITHUB_OAUTH_REDIRECT_URI
    })
  });

  const payload = await response.json<{ access_token?: string; error?: string }>();
  if (!response.ok || !payload.access_token) {
    throw new Error(`GitHub token exchange failed: ${payload.error ?? response.status}`);
  }

  return payload.access_token;
}

async function fetchGitHubUser(accessToken: string): Promise<GitHubUser> {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ListIPs'
    }
  });

  if (!response.ok) throw new Error(`GitHub user fetch failed: ${response.status}`);
  return response.json<GitHubUser>();
}

async function fetchGitHubPrimaryEmail(accessToken: string): Promise<string | null> {
  const response = await fetch('https://api.github.com/user/emails', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ListIPs'
    }
  });

  if (!response.ok) return null;
  const emails = await response.json<GitHubEmail[]>();
  return emails.find((item) => item.primary && item.verified)?.email ?? null;
}

async function upsertOAuthUser(
  env: Env,
  input: { provider: string; subject: string; username: string; email: string; avatarUrl: string | null }
): Promise<User> {
  const existing = await env.DB.prepare(
    `SELECT id, username, email, auth_provider, auth_subject, avatar_url, role, status, list_quota, item_quota_per_list
     FROM users
     WHERE auth_provider = ? AND auth_subject = ?`
  ).bind(input.provider, input.subject).first<User>();

  const username = await resolveOAuthUsername(env, input.username, existing);

  if (existing) {
    await env.DB.prepare(
      `UPDATE users
       SET email = ?, avatar_url = ?, last_login_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`
    ).bind(input.email, input.avatarUrl, existing.id).run();

    return { ...existing, username, email: input.email, avatar_url: input.avatarUrl };
  }

  const userId = `usr_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO users (id, username, email, auth_provider, auth_subject, avatar_url, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
  ).bind(userId, username, input.email, input.provider, input.subject, input.avatarUrl).run();

  const user = await env.DB.prepare(
    `SELECT id, username, email, auth_provider, auth_subject, avatar_url, role, status, list_quota, item_quota_per_list
     FROM users
     WHERE id = ?`
  ).bind(userId).first<User>();

  if (!user) throw new Error('Failed to create user.');
  return user;
}

export async function resolveOAuthUsername(env: Env, rawUsername: string, existing?: Pick<User, 'id' | 'username'> | null): Promise<string> {
  if (existing) return existing.username;
  return uniqueUsername(env, rawUsername);
}

async function uniqueUsername(env: Env, rawUsername: string, currentUserId?: string): Promise<string> {
  const base = slugifyUsername(rawUsername);
  for (let suffix = 0; suffix < 50; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base}-${suffix}`;
    const row = await env.DB.prepare(
      `SELECT id FROM users WHERE username = ?`
    ).bind(candidate).first<{ id: string }>();
    if (!row || row.id === currentUserId) return candidate;
  }

  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

function slugifyUsername(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return slug || `user-${crypto.randomUUID().slice(0, 8)}`;
}

export function isReservedOAuthUsername(value: string): boolean {
  return RESERVED_OAUTH_USERNAMES.has(slugifyUsername(value));
}

function bearerToken(request: Request): string | null {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  return auth.slice('Bearer '.length).trim();
}

function shouldUpdateLastSeen(lastSeenAt: string | null): boolean {
  if (!lastSeenAt) return true;

  const lastSeenMs = Date.parse(lastSeenAt);
  if (!Number.isFinite(lastSeenMs)) return true;

  return Date.now() - lastSeenMs >= SESSION_LAST_SEEN_UPDATE_SECONDS * 1000;
}

function safeRedirectPath(value: string): string {
  if (!value.startsWith('/') || value.startsWith('//')) return '/dashboard';
  return value;
}
