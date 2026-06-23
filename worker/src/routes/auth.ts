import type { Env } from '../types';
import { accountSummary, finishGitHubOAuth, logout, me, startGitHubOAuth } from '../services/auth';
import { errorJson } from '../services/response';
import { enforceRateLimit, requestIdentifier } from '../services/rate-limit';

export async function handleAuth(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/api/auth/github/start') {
    const limited = await enforceRateLimit(env, {
      scope: 'auth_start',
      identifier: requestIdentifier(request),
      limit: 20,
      windowSeconds: 60
    });
    if (limited) return limited;

    return startGitHubOAuth(request, env);
  }

  if (request.method === 'GET' && url.pathname === '/api/auth/github/callback') {
    return finishGitHubOAuth(request, env);
  }

  if (request.method === 'GET' && url.pathname === '/api/auth/google/start') {
    return errorJson(501, 'google_oauth_not_ready', 'Google OAuth is planned for a later phase.');
  }

  if (request.method === 'GET' && url.pathname === '/api/auth/google/callback') {
    return errorJson(501, 'google_oauth_not_ready', 'Google OAuth is planned for a later phase.');
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
    return logout(request, env);
  }

  if (request.method === 'GET' && url.pathname === '/api/auth/me') {
    return me(request, env);
  }

  if (request.method === 'GET' && url.pathname === '/api/auth/account') {
    return accountSummary(request, env);
  }

  return errorJson(404, 'not_found', 'Endpoint not found.');
}
