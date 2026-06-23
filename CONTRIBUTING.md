# Contributing

Thanks for helping improve ListIPs.

## Development

```bash
npm install
cp worker/wrangler.example.toml worker/wrangler.toml
cp worker/.dev.vars.example worker/.dev.vars
npm run dev
```

Run checks before opening a pull request:

```bash
npm test
npm run build
npx tsc -p worker/tsconfig.json
```

## Pull Requests

- Keep changes focused.
- Add or update tests when behavior changes.
- Avoid committing deployment secrets, real `.dev.vars`, generated build output, or local Wrangler state.
- Use clear commit messages that describe the user-facing or operational change.

## Security

Please report vulnerabilities privately using [SECURITY.md](SECURITY.md).
