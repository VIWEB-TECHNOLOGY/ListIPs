# Deploy To Cloudflare

This guide covers self-hosting ListIPs with the **Deploy to Cloudflare** button.

The button deploys the Worker API and raw list delivery stack. It can provision the
Cloudflare resources declared in the root `wrangler.toml`:

- D1 for users, sessions, lists, and sync metadata
- R2 for compiled raw list artifacts
- KV as a rate-limit fallback store
- Durable Objects for atomic rate limiting
- Queues for background external source sync
- Cron triggers for scheduled sync

The Astro frontend is a static site and is deployed separately to Cloudflare Pages
or another static host.

## Before You Start

You need:

- A Cloudflare account
- A GitHub account
- A GitHub OAuth app for your deployment
- A public frontend URL, such as a Cloudflare Pages URL or custom domain

## Deploy The Worker Stack

Click the button in the project README:

```text
https://deploy.workers.cloudflare.com/?url=https://github.com/VIWEB-TECHNOLOGY/ListIPs
```

During the Cloudflare flow:

- If Cloudflare pre-fills `npm run build`, accepting it is safe. This checks and
  builds the static frontend assets, but it does not publish the frontend site.
- Use the deploy command from `package.json`: `npm run deploy`.
- Review the generated Worker name and resource names.
- Set `APP_ORIGIN` to your frontend URL.
- Set `GITHUB_OAUTH_REDIRECT_URI` to `<APP_ORIGIN>/api/auth/github/callback`.
- Provide required Worker secrets from `.dev.vars.example`.

Required secrets:

```text
SESSION_SECRET
GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET
```

Generate `SESSION_SECRET` with a long random value, for example:

```bash
openssl rand -hex 32
```

## Configure GitHub OAuth

Create a GitHub OAuth app with:

- Homepage URL: your `APP_ORIGIN`
- Authorization callback URL: `<APP_ORIGIN>/api/auth/github/callback`

Copy the OAuth app client ID and client secret into the Cloudflare deployment
flow when it asks for `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.

If you change the frontend domain later, update both:

- GitHub OAuth app callback URL
- Worker variables `APP_ORIGIN` and `GITHUB_OAUTH_REDIRECT_URI`

## Deploy The Frontend

The deploy button does not deploy the static Astro frontend. Deploy it separately:

```bash
npm install
npm run build
npx wrangler pages deploy dist --project-name <pages-project-name>
```

After the Pages deployment has a stable URL, make sure the Worker variables match:

```text
APP_ORIGIN=https://your-pages-or-custom-domain.example
GITHUB_OAUTH_REDIRECT_URI=https://your-pages-or-custom-domain.example/api/auth/github/callback
```

## Verify The Deployment

Run these checks from a local clone after the Cloudflare deployment completes:

```bash
npm install
npx wrangler deploy --dry-run
npm run db:migrations:apply
```

Then verify the app:

- Open the frontend URL.
- Click **Login with GitHub**.
- Create a test list.
- Open the generated raw URL.
- Update the list and confirm the raw URL changes.
- Add an allowed external source such as `https://www.cloudflare.com/ips-v4`.
- Save the list and confirm sync completes.

For production-style raw delivery checks, configure smoke fixture tokens privately
and run:

```bash
npm run smoke:provision
npm run smoke:raw
```

## Maintainer Validation

Before advertising the button, maintainers should run:

```bash
npm test
npm run build
npx wrangler deploy --dry-run
```

For the strongest validation, deploy from the button into a fresh Cloudflare
account or fresh test project, then complete the GitHub OAuth and raw URL checks
above. Wrangler dry-runs prove that the Worker bundles and bindings are valid;
a fresh button deployment proves Cloudflare's provisioning flow still works.
