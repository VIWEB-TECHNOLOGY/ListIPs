import type { Env } from '../types';
import { requireAuth } from '../services/auth';
import {
  createList,
  deleteList,
  getOwnedList,
  listResponse,
  listUserLists,
  rotatePrivateToken,
  updateList,
  validateSourceAllowlist
} from '../services/lists';
import { errorJson, handleError, json, readJson } from '../services/response';
import { enforceRateLimit, requestIdentifier } from '../services/rate-limit';
import { enqueueExternalSyncForList, syncOwnedList } from '../services/sync';

export async function handleLists(request: Request, env: Env, _ctx?: ExecutionContext): Promise<Response> {
  try {
    const auth = await requireAuth(request, env);
    if (auth instanceof Response) return auth;

    const url = new URL(request.url);
    const maxBodyBytes = Number(env.MAX_LIST_BODY_BYTES || '524288');
    const parts = url.pathname.split('/').filter(Boolean);
    const listId = parts[2];
    const action = parts[3];
    const writeLimiterId = `${auth.user.id}:${requestIdentifier(request)}`;

    if (request.method === 'GET' && parts.length === 2) {
      const rows = await listUserLists(env, auth.user);
      return json({
        lists: await Promise.all(rows.map((row) => listResponse(row, auth.user.username, env.APP_ORIGIN, env.SESSION_SECRET)))
      });
    }

    if (request.method === 'POST' && parts.length === 2) {
      const limited = await enforceRateLimit(env, {
        scope: 'list_write',
        identifier: writeLimiterId,
        limit: 30,
        windowSeconds: 60
      });
      if (limited) return limited;

      const body = await readJson<Record<string, unknown>>(request, maxBodyBytes);
      const sources = Array.isArray(body.externalSources) ? body.externalSources as Array<{ url: string; enabled: boolean }> : [];
      validateSourceAllowlist(sources, env.EXTERNAL_SOURCE_ALLOWED_HOSTS);
      const result = await createList(env, auth.user, body);
      const syncQueued = await enqueueExternalSyncForList(env, auth.user, result.row);
      return json({
        list: await listResponse(result.row, auth.user.username, env.APP_ORIGIN, env.SESSION_SECRET, result.rawToken),
        syncQueued
      }, { status: 201 });
    }

    if (!listId) return errorJson(404, 'not_found', 'Endpoint not found.');

    if (request.method === 'GET' && parts.length === 3) {
      const row = await getOwnedList(env, auth.user.id, listId);
      if (!row) return errorJson(404, 'list_not_found', 'List not found.');
      return json({ list: await listResponse(row, auth.user.username, env.APP_ORIGIN, env.SESSION_SECRET) });
    }

    if (request.method === 'PUT' && parts.length === 3) {
      const limited = await enforceRateLimit(env, {
        scope: 'list_write',
        identifier: writeLimiterId,
        limit: 30,
        windowSeconds: 60
      });
      if (limited) return limited;

      const body = await readJson<Record<string, unknown>>(request, maxBodyBytes);
      const sources = Array.isArray(body.externalSources) ? body.externalSources as Array<{ url: string; enabled: boolean }> : [];
      validateSourceAllowlist(sources, env.EXTERNAL_SOURCE_ALLOWED_HOSTS);
      const result = await updateList(env, auth.user, listId, body);
      const syncQueued = await enqueueExternalSyncForList(env, auth.user, result.row);
      return json({
        list: await listResponse(result.row, auth.user.username, env.APP_ORIGIN, env.SESSION_SECRET, result.rawToken),
        syncQueued
      });
    }

    if (request.method === 'DELETE' && parts.length === 3) {
      const limited = await enforceRateLimit(env, {
        scope: 'list_write',
        identifier: writeLimiterId,
        limit: 30,
        windowSeconds: 60
      });
      if (limited) return limited;

      await deleteList(env, auth.user, listId);
      return json({ ok: true });
    }

    if (request.method === 'POST' && action === 'rotate-token') {
      const limited = await enforceRateLimit(env, {
        scope: 'token_rotate',
        identifier: writeLimiterId,
        limit: 10,
        windowSeconds: 300
      });
      if (limited) return limited;

      const result = await rotatePrivateToken(env, auth.user, listId);
      return json({
        list: await listResponse(result.row, auth.user.username, env.APP_ORIGIN, env.SESSION_SECRET, result.rawToken)
      });
    }

    if (request.method === 'POST' && action === 'sync') {
      const limited = await enforceRateLimit(env, {
        scope: 'manual_sync',
        identifier: `${auth.user.id}:${listId}`,
        limit: 6,
        windowSeconds: 300
      });
      if (limited) return limited;

      const result = await syncOwnedList(env, auth.user, listId);
      const row = await getOwnedList(env, auth.user.id, listId);
      return json({
        ...result,
        list: row ? await listResponse(row, auth.user.username, env.APP_ORIGIN, env.SESSION_SECRET) : null
      });
    }

    return errorJson(404, 'not_found', 'Endpoint not found.');
  } catch (error) {
    return handleError(error);
  }
}
