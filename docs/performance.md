# ListIPs Performance Notes

Use benchmarks to decide quota changes. Do not raise list-size limits only by intuition.

## Large List Benchmark

Run the local compile/publish/raw-read benchmark:

```bash
npm run benchmark:large-lists
```

Optional settings:

- `LISTIPS_BENCH_SIZES`: comma-separated output sizes. Defaults to `500,1000,5000,10000,50000`.
- `LISTIPS_BENCH_RUNS`: runs per size. Defaults to `3`.
- `LISTIPS_BENCH_COMMENT_EVERY`: insert one comment every N generated IP lines. Defaults to `0`.

Example:

```bash
LISTIPS_BENCH_SIZES='500,1000,5000,10000' LISTIPS_BENCH_RUNS=5 npm run benchmark:large-lists
```

The benchmark mirrors the production validation and normalization rules, uses the same `ipaddr.js` parser, and measures:

- compile and SHA-256 hash time
- simulated R2 artifact publication overhead
- raw response construction/read overhead
- input/output artifact size

It does not replace production smoke testing. It is a local decision tool for future quota tiers.

## Current Quota Posture

The default list limit remains `500` output lines. Oversized manual or synced lists fail with a clear limit error instead of being truncated.

Before raising quotas, capture benchmark output for the target sizes and then test one realistic production artifact through R2 and raw edge cache.

## Production Large-Artifact Canary

Run a temporary production canary through D1, R2, the raw Worker route, and edge cache:

```bash
npm run canary:large-artifact
```

Optional settings:

- `LISTIPS_CANARY_SIZE`: generated output lines. Defaults to `10000`.
- `LISTIPS_CANARY_KEEP`: set to `1` to keep the canary D1 row and R2 artifact after the run. Defaults to cleanup.
- `LISTIPS_CANARY_USERNAME`: canary username path segment. Defaults to `listips-canary`.
- `LISTIPS_CANARY_SLUG`: canary list slug. Defaults to a unique `large-{size}-{run_id}` slug.
- `LISTIPS_CANARY_APP_ORIGIN`: app origin. Defaults to `https://listips.com`.

The canary creates a temporary public D1 list row, lets the raw route backfill the compiled R2 artifact, checks item count, ETag, body line count, cache headers, cache HIT behavior, and conditional `304`, then deletes the row and artifact unless kept.

### Canary Results

Captured on May 7, 2026:

| Output lines | Result | Notes |
| --- | --- | --- |
| 10,000 | Passed | D1 metadata row, R2 artifact body, raw route metadata backfill, edge cache HIT, conditional `304`, cleanup |
| 50,000 | Passed | Same path as 10k; artifact body was about 586 KB in local benchmark |

An earlier attempt to place the full 10k-line body directly in D1 SQL failed with `SQLITE_TOOBIG`. This confirms the intended architecture: D1 should store metadata and editable/manual content, while large compiled artifacts belong in R2.

## Quota Recommendation

Keep the default free/user quota at `500` output lines for now.

Recommended future tiers:

| Tier | Suggested limit | Status |
| --- | ---: | --- |
| Free/default | 500 | Current production default |
| Internal/admin test | 10,000 | Production canary passed; reasonable next controlled tier |
| Larger paid/admin | 50,000 | Production canary passed, but needs abuse controls, UX confirmation, and monitoring before user rollout |

Do not raise the global default until these controls exist:

- per-user quota assignment and admin-only quota changes
- clear UI copy for large-list sync/publish limits
- production alerts for sync failures and raw delivery errors
- abuse/rate-limit policy for large raw consumers
- at least one retained large-list fixture for release canaries

## Controlled Quota Updates

The global default remains unchanged. For controlled testing, update a specific user with the script-only quota tool:

```bash
LISTIPS_QUOTA_USERNAME='alice' LISTIPS_QUOTA_ITEMS_PER_LIST=10000 npm run quota:set-user
```

Optional settings:

- `LISTIPS_QUOTA_LISTS`: list count quota. Defaults to `100`.
- `LISTIPS_QUOTA_ROLE`: optionally set the user's role.
- `LISTIPS_QUOTA_D1_DATABASE`: D1 database name. Defaults to `listips`.
- `LISTIPS_QUOTA_WRANGLER_CONFIG`: Wrangler config path. Defaults to `worker/wrangler.toml`.

After changing a user quota, verify `/settings/` shows the account type/group and the exact account limits.

Audit non-default quota accounts:

```bash
npm run quota:audit
```

Set `LISTIPS_QUOTA_AUDIT_ALL=1` to list every account, including default-quota users.

## Initial Local Baseline

Captured on May 7, 2026 with the default benchmark settings:

| Output lines | Output size | Compile p50 | Compile p95 | Raw read p50 |
| --- | ---: | ---: | ---: | ---: |
| 500 | 5.16 KB | 1.94 ms | 5.09 ms | 0.15 ms |
| 1,000 | 10.31 KB | 2.01 ms | 2.04 ms | 0.17 ms |
| 5,000 | 53.95 KB | 5.53 ms | 5.74 ms | 0.18 ms |
| 10,000 | 110.47 KB | 10.92 ms | 17.74 ms | 0.24 ms |
| 50,000 | 586.23 KB | 55.62 ms | 57.56 ms | 0.68 ms |

This is encouraging for future paid/admin quotas, but it is still local-only. Production quota changes need a real R2 and edge-cache test before rollout.
