# Contributing

Thanks for improving `mikeoss-casedotdev`.

## Development

Install dependencies:

```bash
npm install --prefix backend
npm install --prefix frontend
```

Create local env files from the examples and fill in your own Case.dev
Database/Postgres URL, Better Auth secret, Case key encryption secret, and
Case.dev API key:

```bash
cp backend/.env.example backend/.env
cp frontend/.env.local.example frontend/.env.local
```

Run the app locally:

```bash
scripts/mike-dev.sh start
```

## Pull Requests

- Keep changes focused and explain user impact.
- Do not commit secrets, client documents, local `.env` files, logs, or build
  output.
- Preserve AGPL-3.0-only licensing and upstream attribution.
- Run the relevant checks before opening a pull request:

```bash
npm run build --prefix backend
npm run build --prefix frontend
(cd frontend && npx tsc --noEmit)
```

## Legal And AI Disclaimer

This project is software for legal workflows. Contributions must not represent
the system as a lawyer, law firm, or source of legal advice. User-facing AI
features should be clear about document grounding and should not fabricate
document content or citations.
