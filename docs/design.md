# ListIPs System Design

## Purpose

ListIPs is a centralized allowlist and blocklist management service for SysAdmins and DevOps teams. It stores list metadata in Cloudflare D1, publishes compiled plain-text IP/CIDR lists through Cloudflare R2, and serves raw list output from the edge for direct consumption by firewalls, HestiaCP, iptables, UFW, Nginx, automation scripts, and monitoring tools.

## Tech Stack Overview

| Layer | Technology | Responsibility |
| --- | --- | --- |
| Frontend | Astro with Cloudflare adapter | Dashboard, authentication screens, list management UI |
| Hosting | Cloudflare Pages | Static frontend deployment and edge routing |
| API | Cloudflare Workers | REST endpoints, validation, auth checks, D1 writes, R2 publication |
| Async Jobs | Cloudflare Queues | Save-triggered external source sync with one-list jobs and managed retries |
| Database | Cloudflare D1 | Users, list metadata, source configuration, audit metadata |
| Object Storage | Cloudflare R2 | Strongly consistent compiled raw text artifacts with custom metadata |
| Bot Protection | Cloudflare Turnstile | Optional protection for suspicious or future unauthenticated high-risk flows |
| Auth | GitHub OAuth, session cookie, later Google OAuth | User dashboard and API authorization |
| Abuse Controls | Cloudflare WAF, Worker-side limits, validation, quotas | Keep usage inside free-tier and prevent malicious payload delivery |
| Verification | GitHub Actions, production raw smoke script | Keep test/build/audit checks repeatable before and after deploy |
| Observability | Sampled Worker structured logs | Track raw delivery and sync behavior without logging tokens, client IPs, source content, or source URLs |

## Product Decisions

- Primary auth is GitHub OAuth. Google OAuth is a later provider using the same account-linking model.
- Keep the current Cloudflare-first stack. Supabase is not expected to reduce cost for this product shape because the hot path is edge-cached raw text delivery, where Workers, R2, and Cloudflare cache are a strong fit.
- Raw public URL format is `https://listips.com/u/{username}/{list_slug}`.
- Raw private URL format is `https://listips.com/u/{username}/{list_slug}?token=sec_...`.
- External sync sources are restricted to an explicit domain allowlist: `*.cloudflare.com`, `*.githubusercontent.com`, and `*.amazonaws.com`.
- Saving a list with enabled external sources queues a background sync for that specific list; Save does not wait on remote source fetching.
- A list marked as `queued` is not enqueued again by repeated Save clicks until the pending sync completes or fails.
- IP/CIDR parsing may use a small tested parser dependency.
- Default quotas are `100` lists per user and `500` output lines per list, counting both comments and IP/CIDR entries.
- Raw output may contain only full-line comments beginning with `#` and valid IP/CIDR entries.
- Raw edge cache TTL is 1 minute and must be shown in the dashboard near raw URLs.
- Production deploys should run the release checklist in `docs/release-checklist.md`, including public and private raw smoke tests.

## High-Level Architecture

```text
Browser Dashboard
  |
  | Astro UI over Cloudflare Pages
  v
Cloudflare Worker API
  |        |        ^
  |        |        |
  |        +------> Cloudflare Queue: one-list external sync jobs
  |        |
  |        +--> Cloudflare D1: users, lists, source metadata, sync state
  |
  +------------> Cloudflare R2: compiled raw list text + custom metadata
                    |
                    v
            Edge raw endpoint
            https://listips.com/u/{username}/{list_slug}
```

The API is responsible for all mutations. D1 is the source of truth for ownership, configuration, visibility, editable content, and sync state. R2 is a derived delivery artifact for compiled raw text and small custom metadata used by the raw endpoint. Raw responses are additionally cached with the Workers Cache API; private cache entries are keyed by the full tokenized URL.

External source sync has two scheduling paths and one execution path:

- Save-triggered sync writes the list changes first, marks the list as `queued`, and publishes one message to Cloudflare Queue `listips-external-sync`.
- Cron sync remains a periodic backstop, but it only schedules work: it runs hourly, scans up to 100 due enabled active-user lists per run, marks each as `queued`, and publishes one queue message per list.
- Healthy synced lists are scheduled for refresh every 24 hours after a successful sync.
- Due scheduling uses `next_sync_at`, skips lists already marked `queued`, prioritizes never-synced and oldest-synced lists, and backs off failures for 1 hour, then 6 hours, then 24 hours.

The queue consumer fetches the latest list row when processing a message, combines manual content with enabled source content, validates and compiles the result, updates sync status/hash/count in D1, and writes the compiled artifact to R2. Fetched source bodies are not stored in D1.

## Availability And Cost Posture

The product should optimize for a Cloudflare-native read path:

- D1 stores account, list metadata, editable manual content, sync state, quotas, and audit-oriented fields.
- R2 stores compiled raw artifacts and custom metadata used by the raw endpoint.
- Workers Cache API absorbs repeated public and valid tokenized private raw reads for the short TTL window.
- Cloudflare Queues moves save-triggered external sync out of the request path and provides retry handling for one-list sync jobs.
- Durable Objects provide atomic Worker-side rate limiting where precise counters matter.

This design is suitable for internal use and small private beta traffic. It should not be marketed as a high-availability public free SaaS until operational controls are in place:

- Cloudflare WAF/rate-limit rules in front of raw and API routes.
- alerts for Worker errors, raw delivery failures, sync failure spikes, and rate-limit spikes.
- explicit plan/quota governance instead of ad hoc special cases.
- release canaries for large artifacts and raw cache behavior.
- documented incident/rollback process.

Supabase may be useful later for relational tooling, admin workflows, backups, or analytics, but it should not replace R2 raw artifact delivery, Workers raw routing, Workers Cache API, or Durable Object rate limiting for cost reasons.

## Cloudflare D1 Schema

### `users`

Stores account identity and quota metadata.

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  auth_provider TEXT NOT NULL DEFAULT 'github',
  auth_subject TEXT NOT NULL,
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  turnstile_required INTEGER NOT NULL DEFAULT 1,
  list_quota INTEGER NOT NULL DEFAULT 100,
  item_quota_per_list INTEGER NOT NULL DEFAULT 500,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_username ON users(username);
CREATE UNIQUE INDEX idx_users_provider_subject ON users(auth_provider, auth_subject);
```

### `sessions`

Stores hashed session tokens for dashboard and API access.

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
```

### `oauth_states`

Stores short-lived OAuth state hashes for CSRF protection during provider callbacks.

```sql
CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  redirect_path TEXT NOT NULL DEFAULT '/dashboard',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_oauth_states_expires_at ON oauth_states(expires_at);
```

### `lists`

Stores list ownership, routing, compiled state, and publication settings.

```sql
CREATE TABLE lists (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  visibility TEXT NOT NULL DEFAULT 'private',
  mode TEXT NOT NULL DEFAULT 'allowlist',
  content TEXT NOT NULL DEFAULT '',
  compiled_hash TEXT,
  kv_key TEXT NOT NULL,
  raw_token_hash TEXT,
  raw_token_prefix TEXT,
  item_count INTEGER NOT NULL DEFAULT 0,
  external_sync_enabled INTEGER NOT NULL DEFAULT 0,
  external_sources_json TEXT NOT NULL DEFAULT '[]',
  last_synced_at TEXT,
  last_sync_status TEXT,
  last_sync_error TEXT,
  next_sync_at TEXT,
  sync_failure_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (user_id, slug)
);

CREATE INDEX idx_lists_user_id ON lists(user_id);
CREATE INDEX idx_lists_kv_key ON lists(kv_key);
CREATE INDEX idx_lists_visibility ON lists(visibility);
CREATE INDEX idx_lists_external_sync_enabled ON lists(external_sync_enabled);
```

### Optional `api_tokens`

Use token-scoped automation access for CLI and infrastructure integrations.

```sql
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  scopes TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_api_tokens_user_id ON api_tokens(user_id);
```

## Cloudflare R2 Structure

R2 stores compiled plain-text list artifacts. It must be treated as a derived read model, not as the primary database.

### Raw List Key

```text
lists/{username}/{list_slug}
```

Example:

```text
lists/alice/office-allowlist
```

Published URL:

```text
https://listips.com/u/alice/office-allowlist
```

Private published URL:

```text
https://listips.com/u/alice/office-allowlist?token=sec_...
```

Value format:

```text
# Office ranges
192.0.2.10
198.51.100.0/24
# IPv6 ranges
2001:db8::/32
```

Compiled values may contain only full-line comments beginning with `#` and valid IP/CIDR entries. Comments are optional, count toward the list limit, must be sanitized to safe printable ASCII, and are cut to 100 characters.

Metadata is stored in R2 custom metadata on the same object to avoid sidecar reads. Current metadata includes compiled hash, item count, visibility, private-token policy, raw token hash when private, and update time.

### R2 Write Rules

- Write R2 only after the D1 mutation succeeds.
- Normalize line endings to `\n`.
- Trim whitespace and remove empty lines before compilation.
- Deduplicate IP/CIDR entries in stable order.
- Preserve sanitized full-line comments beginning with `#`; cut comments to 100 characters.
- Store only valid IPv4, IPv6, IPv4 CIDR, or IPv6 CIDR entries.
- Store private raw token hashes in D1 and R2 custom metadata, never plaintext tokens.
- Delete R2 objects when a list is deleted or unpublished.

## API Endpoints

All API endpoints live under `/api`. Raw list delivery intentionally avoids `/api` to keep firewall configuration URLs short.

### Authentication

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/auth/github/start` | Start GitHub OAuth |
| `GET` | `/api/auth/github/callback` | Complete GitHub OAuth and issue secure session cookie |
| `POST` | `/api/auth/logout` | Clear current session |
| `GET` | `/api/auth/me` | Return current authenticated user |
| `GET` | `/api/auth/account` | Return account, quota, and usage summary |

### Lists CRUD

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/lists` | List current user's lists |
| `POST` | `/api/lists` | Create a list and publish compiled content to R2 |
| `GET` | `/api/lists/{id}` | Read list metadata and editable content |
| `PUT` | `/api/lists/{id}` | Update metadata/content and sync R2 |
| `DELETE` | `/api/lists/{id}` | Delete list and remove R2 artifact |

### Raw Delivery

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/u/{username}/{list_slug}` | Return compiled public raw text from R2 or Workers Cache |
| `GET` | `/u/{username}/{list_slug}?token=sec_...` | Return compiled private raw text after token validation |
| `HEAD` | `/u/{username}/{list_slug}` | Return cache, ETag, and content metadata |

Successful raw response:

```http
HTTP/1.1 200 OK
Content-Type: text/plain; charset=utf-8
Cache-Control: public, max-age=60, s-maxage=60, stale-while-revalidate=60
ETag: "sha256-..."
X-ListIPs-Items: 128
X-ListIPs-Cache-Seconds: 60
```

### External Sync

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/lists/{id}/sync` | Legacy/API-only manual retry for one list |

External sources are configured as part of `POST /api/lists` and `PUT /api/lists/{id}`. Saving a list with enabled sources queues a background sync for that list; the dashboard does not expose a permanent manual sync button. Sources must be explicitly allowlisted by scheme and host policy. Fetch only `https` URLs whose host matches `*.cloudflare.com`, `*.githubusercontent.com`, or `*.amazonaws.com`. Enforce size, timeout, redirect, and content-type limits.

## Input Validation

### List Name And Slug

- `name`: `1..80` visible characters after trimming.
- `slug`: lowercase ASCII only, generated from `name` or supplied explicitly.
- Slug regex:

```regex
^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$
```

### IP/CIDR Entries

Use a parser when possible. Regex is acceptable only as a first-pass filter. Final validation must confirm numeric ranges and CIDR prefix ranges.

Accepted output line formats:

- IPv4: `192.0.2.10`
- IPv4 CIDR: `198.51.100.0/24`
- IPv6: `2001:db8::1`
- IPv6 CIDR: `2001:db8::/32`
- Full-line comment: `# Office ranges`

Reject:

- Hostnames
- URLs
- Shell fragments
- Comments embedded after entries
- Comments that contain control characters or unsafe punctuation
- Private metadata fields inside list content
- Lines exceeding a strict length limit, such as 128 bytes

First-pass IP/CIDR regex:

```regex
^([0-9A-Fa-f:.]+)(?:\/([0-9]{1,3}))?$
```

First-pass comment regex:

```regex
^#[ A-Za-z0-9._:\/,+()[\]-]{0,99}$
```

Then perform strict parsing:

- IPv4 octets must be `0..255`.
- IPv4 CIDR prefix must be `0..32`.
- IPv6 must parse as a valid IPv6 address.
- IPv6 CIDR prefix must be `0..128`.
- Mixed IPv4-mapped IPv6 must be normalized or rejected consistently.
- Full-line comments must be sanitized, cut to 100 characters, and preserved. Inline comments are rejected.
- The raw result must contain only sanitized `#` comments and normalized IP/CIDR lines.

## Security And Anti-Abuse

### Worker Security Controls

- Require authentication for all list mutations.
- Use GitHub OAuth first, with Google OAuth added later through the same provider/subject identity model.
- Use Turnstile for high-risk login callbacks, suspicious write flows, or future unauthenticated endpoints.
- Enforce per-user quotas: list count, output-line count, external source count, sync frequency.
- Validate request `Content-Type` and reject oversized bodies before parsing.
- Use parameterized D1 statements only.
- Never concatenate SQL strings from user input.
- Return generic auth errors to avoid account enumeration.
- Use secure session cookies:

```text
HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=...
```

### Raw Endpoint Controls

- Serve public lists without a token.
- Serve private lists only when `?token=sec_...` matches the hashed private raw token in R2 custom metadata.
- Return `404` for missing, invalid-token, suspended, or deleted lists.
- Do not expose user emails, internal list IDs, or source configuration in raw responses.
- Use ETag and cache headers to reduce Worker invocations and R2 reads.
- Support `HEAD` for health checks and firewall automation.
- Allow users to rotate private raw tokens and invalidate the previous token hash.

### Rate Limiting

Use layered controls:

- Cloudflare WAF rate limiting rules where available.
- Worker-side atomic limits using Durable Objects, with KV counters retained only as fallback.
- Per-session and per-IP mutation limits.
- Per-user sync limits for external sources.
- Hard cap request body size for list content and source responses.

Suggested Worker-side key format:

```text
ratelimit/{scope}/{identifier}/{window}
```

Examples:

```text
ratelimit:login:ip:203.0.113.10:202605050915
ratelimit:write:user:usr_123:2026050509
ratelimit:raw:ip:203.0.113.10:202605050915
```

### External Source Safety

- Allow only `https`.
- Allow only hosts matching `*.cloudflare.com`, `*.githubusercontent.com`, or `*.amazonaws.com`.
- Deny localhost, private RFC1918, link-local, and metadata IP targets.
- Limit response size, for example 256 KB per source on the free tier.
- Disable redirects or allow only one redirect to an approved public host.
- Validate every fetched line with the same IP/CIDR parser.
- Store sync failures in D1 metadata without publishing partial invalid output.

## Cost Controls

- Keep raw list reads on R2 with 1-minute edge cache headers.
- Avoid D1 reads on hot raw paths when possible.
- Compile on writes, not on reads.
- Limit external sync frequency with Cron Triggers and per-user quotas.
- Keep list size and source count bounded.
- Prefer static Astro pages for marketing/help content.
- Use Cloudflare Pages and Workers free-tier-compatible limits as product constraints.
