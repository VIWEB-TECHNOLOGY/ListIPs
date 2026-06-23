# ListIPs Project Context

## Current Status

The MVP implementation phases are complete and deployed.

| Area | Status |
| --- | --- |
| Astro frontend on Cloudflare Pages | Complete |
| Worker API on `listips.com/api/*` | Complete |
| Raw list delivery on `listips.com/u/*` | Complete |
| GitHub OAuth login | Complete |
| D1 schema and migrations | Complete |
| R2 compiled list publication | Complete |
| List CRUD | Complete |
| Public raw URLs | Complete |
| Private tokenized raw URLs | Complete |
| External source sync | Complete |
| Save-triggered Queue sync | Complete |
| Cron-triggered sync | Complete |
| Rate limiting and security headers | Complete |
| Validation for comments and IP/CIDR output | Complete |
| Production UI refresh and brand assets | Complete |
| CI test/build/audit workflow | Complete |
| Production raw smoke test | Complete |

## Production Routing

- `https://listips.com/` is the Cloudflare Pages frontend.
- `https://listips.com/api/*` is handled by the `listips-api` Worker.
- `https://listips.com/u/{username}/{list_slug}` is handled by the Worker for raw text delivery.
- `https://listips.com/u/{username}/{list_slug}?token=sec_...` is handled by the Worker for private raw text delivery.

## Current Product Rules

- GitHub OAuth is the primary login method.
- Google OAuth is a later optional provider.
- The production frontend uses the dark blue ListIPs UI refresh with brand assets served from `public/images/`.
- Private lists use one-time-visible tokenized raw URLs.
- Switching a public list to private generates a new private token URL.
- Switching a private list to public clears private token state.
- Comments are allowed only as full lines beginning with `#`.
- Comments count toward the 500 output-line limit.
- Comments are cut to 100 characters before publication.
- Raw output contains only sanitized `#` comments and valid IPv4, IPv6, IPv4 CIDR, or IPv6 CIDR lines.
- External sources are restricted to `*.cloudflare.com`, `*.githubusercontent.com`, and `*.amazonaws.com`.
- Saving a list with enabled external sources queues a background sync for that list on Cloudflare Queue `listips-external-sync`.
- The dashboard no longer has a permanent manual sync button; Save reports when an external source sync is queued.
- Queue dedupe is DB-backed: a list marked `last_sync_status = 'queued'` will not enqueue another Save-triggered sync until the pending job finishes or fails.
- Compiled raw list artifacts are stored in Cloudflare R2 with custom metadata; KV is reserved for the rate-limit fallback.
- Raw responses use a 1-minute cache TTL and expose the cache time to users.
- Clean public raw URLs and valid tokenized private raw URLs are eligible for Workers Cache API storage before the R2/rate-limit hot path. Private cache entries are keyed by the full tokenized URL.
- Production raw delivery must pass the smoke checks in `npm run smoke:raw` after Worker deploys.
- Production raw smoke uses the stable `viweb-technology` fixture account after `npm run smoke:provision`; it covers public/private, manual/synced, and both private token policies.
- Large-list quota changes should be guided by `npm run benchmark:large-lists` and the notes in `docs/performance.md`.
- Production large-artifact canaries can be run with `npm run canary:large-artifact` before raising list quotas.
- Production canaries passed at 10k and 50k output lines, but the default user quota remains 500 until quota management, abuse controls, UX copy, and monitoring are ready.
- Per-user quota testing can be done with `npm run quota:set-user`; `/settings/` shows account type, group, and the current account limits.
- Non-default quota accounts can be audited with `npm run quota:audit`.
- Worker-side rate limits use an atomic Durable Object counter in production, with the older KV counter retained only as a fallback when the Durable Object binding is unavailable.
- Authenticated session `last_seen_at` writes are throttled to at most once every 15 minutes per session.
- Cron-triggered external sync is now a bounded scheduler: it runs hourly, enqueues at most 100 due lists per run, and does not fetch external sources inline.
- Healthy synced lists are scheduled for refresh every 24 hours after a successful sync.
- Due-list scheduling uses `next_sync_at`, skips lists already marked `queued`, prioritizes never-synced lists first, and uses failure backoff of 1 hour, 6 hours, then 24 hours.
- Queue-triggered external sync processes one requested list per message; Save-triggered and cron-triggered sync now share the same Queue consumer.
- Raw delivery emits sampled structured `raw_delivery` logs controlled by `OBSERVABILITY_SAMPLE_RATE`; tokens and client IPs are intentionally excluded from log fields.
- External sync emits structured `sync_started`, `sync_success`, and `sync_failed` logs. Failure logs are forced, source URLs are masked in logs, and sync failures are persisted to `last_sync_status`/`last_sync_error`.

## Scale Readiness Direction

ListIPs will move toward large-scale readiness incrementally, with tests added for each step before broader rollout. Current priorities:

- Add Cloudflare WAF/rate-limit rules for `/u/*`, `/api/auth/*`, and `/api/lists*`.
- Add monitoring and alerts for Worker 5xx responses, raw delivery failures, sync failure spikes, and rate-limit spikes.
- Formalize plan/quota governance beyond script-only quota changes.
- Keep CI green for `npm test`, `npm run build`, and `npm audit --omit=dev`.
- Keep production raw smoke, quota audit, and large-artifact canaries in the release flow.
- Benchmark larger quota candidates before raising the default 500-output-line limit.

## Launch Readiness

Current readiness opinion:

| Launch level | Status | Notes |
| --- | --- | --- |
| Personal/internal use | Ready | Current stack and checks are sufficient. |
| Small private beta | Ready | Invite-only usage is reasonable with current quotas and smoke checks. |
| Multiple real users, invite-only | Mostly ready | Watch quota changes, sync failures, and raw traffic. |
| Public free SaaS launch | Not yet | Needs WAF/rate rules, alerts, and plan/quota governance first. |
| High-availability public SaaS | Not yet | Needs monitoring, incident process, abuse policy, and stronger operational controls. |

The architecture is pointed in the right direction for high availability because raw delivery is Cloudflare-native: Worker routing, R2 compiled artifacts, and edge cache. The remaining risks are mostly operational and abuse-related, not a reason to switch stacks.

Top priorities before a public free SaaS launch:

1. Cloudflare WAF/rate-limit rules for raw and API paths.
2. Monitoring and alerts for errors, sync failures, and abuse signals.
3. Explicit plan/quota model with admin-managed or product-managed tiers.

## Optional Hardening Backlog

These are not required for the MVP to function, but are useful before wider launch:

- Run a full logged-in production smoke test with a real account.
- Add Google OAuth using the existing provider/subject account model.
- Add API tokens for CLI or server automation.
- Add Turnstile only for suspicious or high-risk unauthenticated flows.
- Add more route/integration tests around raw delivery and sync failure behavior.
- Add metrics/alerts on top of the current sampled raw-delivery logs while staying within the free-tier target.
