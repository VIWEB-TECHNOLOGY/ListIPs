# ListIPs Release Checklist

Use this checklist for production Worker or frontend changes.

## Before Deploy

- Confirm the working tree only contains intended changes: `git status --short`
- Run worker tests: `npm test`
- Run the frontend build/type check: `npm run build`
- Check production dependency advisories: `npm audit --omit=dev`
- Audit non-default quota accounts: `npm run quota:audit`

## Deploy Worker

Apply any pending D1 migrations before deploying Worker code that depends on new columns:

```bash
npx wrangler d1 migrations apply listips --remote --config worker/wrangler.toml
```

Before deploying a Worker config that references the external sync queue, ensure the queue exists:

```bash
npx wrangler queues create listips-external-sync
```

If Wrangler reports that the queue already exists, continue.

```bash
npx wrangler deploy --config worker/wrangler.toml
```

Record the Worker version ID from Wrangler output. Confirm Wrangler lists both `Producer for listips-external-sync` and `Consumer for listips-external-sync`.

## Deploy Frontend

For frontend or static asset changes:

```bash
npx wrangler pages deploy dist --project-name listips --commit-dirty=true
```

Record the Pages deployment URL from Wrangler output.

## Verify Raw Delivery

Provision or refresh the stable `viweb-technology` smoke account and raw fixtures:

```bash
npm run smoke:provision
```

Fixture smoke covers public/private, manual/synced, and both private token policies:

```bash
npm run smoke:raw
```

Optional legacy single-URL smoke:

```bash
LISTIPS_SMOKE_FIXTURES=0 \
LISTIPS_SMOKE_PUBLIC_URL='https://listips.com/u/alice/public-list' \
LISTIPS_SMOKE_PRIVATE_URL='https://listips.com/u/alice/private-list?token=sec_...' \
LISTIPS_SMOKE_PRIVATE_EXPECTS='173.245.48.0/20,131.0.72.0/22' \
LISTIPS_SMOKE_PUBLIC_EXPECTS='1.2.3.4' \
npm run smoke:raw
```

Passing smoke output should show:

- `HEAD warm` returns `200`.
- Repeated `HEAD` returns cache `HIT`.
- `GET` returns cache `HIT`.
- Conditional `GET` returns `304`.
- Fixture smoke includes expected synced-source snippets and private tokenized responses.

For dashboard sync changes, also perform a live UI check:

- Save a list with an enabled external source.
- Confirm the dashboard reports that external source sync was queued.
- Confirm repeated Save clicks while queued do not create repeated visible sync attempts.
- Confirm the raw URL updates after the queue consumer completes.

## Quota Or Large-List Changes

For changes touching quotas, list compilation, R2 publication, raw cache behavior, or external sync limits:

- Run the local large-list benchmark: `npm run benchmark:large-lists`
- Run a production large-artifact canary: `npm run canary:large-artifact`
- For higher boundaries, set `LISTIPS_CANARY_SIZE`, for example `LISTIPS_CANARY_SIZE=50000 npm run canary:large-artifact`
- Audit elevated quota accounts after any quota change: `npm run quota:audit`
- Verify `/settings/` shows the expected account type, group, and limits for the changed account.

Do not raise global defaults from canary success alone. Keep per-user quota changes controlled until abuse controls, UX copy, monitoring, and release canaries are in place.

## After Deploy

- Commit the final code and docs changes.
- Note any production smoke findings in the commit or release notes.
- Note any quota audit or large-artifact canary findings when quotas or raw delivery are affected.
- If smoke fails, keep the deployed Worker version ID and failure output for rollback/debugging.
