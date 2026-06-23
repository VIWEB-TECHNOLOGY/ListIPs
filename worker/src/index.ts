import type { Env, ExternalSyncQueueMessage } from './types';
import { handleAuth } from './routes/auth';
import { handleLists } from './routes/lists';
import { handleRaw } from './routes/raw';
import { processExternalSyncQueueMessage, syncConfiguredExternalLists } from './services/sync';
import { errorJson } from './services/response';

export { RateLimitCounter } from './services/rate-limit';

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith('/api/auth/')) {
        return handleAuth(request, env);
      }

      if (url.pathname.startsWith('/api/lists')) {
        return handleLists(request, env, _ctx);
      }

      if (url.pathname.startsWith('/api/')) {
        return errorJson(404, 'not_found', 'Endpoint not found.');
      }

      return handleRaw(request, env);
    } catch (error) {
      console.error('Worker request failed', error);
      return errorJson(500, 'internal_error', 'Internal server error.');
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(syncConfiguredExternalLists(env));
  },

  async queue(batch: MessageBatch<ExternalSyncQueueMessage>, env: Env, _ctx: ExecutionContext): Promise<void> {
    for (const message of batch.messages) {
      await processExternalSyncQueueMessage(env, message.body);
    }
  }
};
