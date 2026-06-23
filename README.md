# ListIPs

Open-source IP/CIDR allowlist and blocklist publishing for firewall automation.

ListIPs lets operators create validated plain-text IP lists, optionally sync approved upstream sources, and serve raw public or tokenized private URLs for tools such as firewalls, HestiaCP, iptables, UFW, Nginx, scripts, and monitoring systems.

- Website: [listips.com](https://listips.com)
- Source: [VIWEB-TECHNOLOGY/ListIPs](https://github.com/VIWEB-TECHNOLOGY/ListIPs)
- License: [MIT](LICENSE)

## Stack

- Frontend: Astro
- API and raw delivery: Cloudflare Workers
- Database: Cloudflare D1
- Compiled artifacts: Cloudflare R2
- Background sync: Cloudflare Queues
- Rate limiting: Durable Objects, with KV fallback
- Auth: GitHub OAuth

## Local Development

Install dependencies:

```bash
npm install
```

Run the Astro frontend:

```bash
npm run dev
```

Run the Worker locally:

```bash
cp worker/wrangler.example.toml worker/wrangler.toml
cp worker/.dev.vars.example worker/.dev.vars
npm run worker:dev
```

The local Worker needs Cloudflare-compatible bindings. For real deployments, create your own D1 database, R2 bucket, Queue, KV namespace, Durable Object binding, and GitHub OAuth app, then update your local `worker/wrangler.toml`.

## Checks

```bash
npm test
npm run build
npx tsc -p worker/tsconfig.json
npm audit --omit=dev
```

Production-style raw delivery smoke checks are available once you have configured Cloudflare resources:

```bash
npm run smoke:provision
npm run smoke:raw
```

By default, smoke fixtures use the reserved `viweb-technology` username. Override `LISTIPS_SMOKE_USERNAME` for your own deployment.

## Cloudflare Setup

Start from the example config:

```bash
cp worker/wrangler.example.toml worker/wrangler.toml
```

Create the required resources in your Cloudflare account:

- D1 database for user/list metadata
- R2 bucket for compiled raw list artifacts
- Queue for external source sync jobs
- KV namespace for rate-limit fallback
- Durable Object binding for atomic rate limits
- GitHub OAuth application

Apply migrations:

```bash
npx wrangler d1 migrations apply <database-name> --remote --config worker/wrangler.toml
```

Set Worker secrets:

```bash
npx wrangler secret put SESSION_SECRET --config worker/wrangler.toml
npx wrangler secret put GITHUB_CLIENT_ID --config worker/wrangler.toml
npx wrangler secret put GITHUB_CLIENT_SECRET --config worker/wrangler.toml
```

Create the sync queue if needed:

```bash
npx wrangler queues create listips-external-sync
```

Deploy:

```bash
npm run worker:deploy
npm run build
npx wrangler pages deploy dist --project-name <pages-project-name>
```

## Security

Please do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).

## Contributing

Pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).
