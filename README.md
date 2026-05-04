# mikeoss-casedotdev

Open-source Case.dev fork of Mike. This repository keeps the GitHub fork
relationship with `willchen96/mike` while wiring Mike to Case.dev primitives for
LLM routing, model selection, Skills, Vault-backed document storage, document
grounding, and Case DB/Postgres-compatible persistence.

This project is developer-oriented software for legal workflows. It is not a
law firm, lawyer, or substitute for professional legal advice.

## Hosted Demo

Try the hosted demo at [mike.casemark.dev](https://mike.casemark.dev).

The hosted demo is backed by a shared Case.dev API key and includes a lifetime
`$5` Case.dev usage budget per signed-in user. You can add your own Case.dev API
key in **Account > Models** at any time; personal keys override the hosted demo
key and bypass the demo budget. Clearing your key falls back to the shared demo
key.

If the hosted demo is paused, the app shows a lightweight landing page instead
of the workspace. Operators can pause the demo by setting `MIKE_DEMO_MODE=false`
while leaving `MIKE_DEMO_CASE_API_KEY` configured in the Vercel backend project.
Forks and local installs are unaffected unless they opt into demo mode.

## Contents

- `frontend/` - Next.js application
- `backend/` - Express API, Better Auth, Case DB access, document processing, and migrations
- `backend/migrations/000_one_shot_schema.sql` - one-shot Case DB/Postgres schema for fresh databases

## What This Fork Adds

- Case.dev LLM gateway and live model catalog
- Case Vault as canonical document storage, indexing, search, chunks, extracted
  text, downloads, and chat grounding
- Case Matters as the workspace primitive behind Mike's Matters UI
- Case Skills discovery and workflow import
- Read-only Case Legal research tools in chat
- Better Auth with encrypted per-user Case.dev keys
- Optional BYOK Anthropic and Gemini LLM routing for local/private installs
- Hosted demo mode with per-user usage metering

Users configure credentials in Account > Models. Case.dev is the default and
required provider for Vault storage, indexing, Skills, Matters, Legal, and the
Case model gateway. Optional encrypted Anthropic and Gemini keys can be added
for direct BYOK LLM routing without changing document storage.

## Setup

Install dependencies:

```bash
npm install --prefix backend
npm install --prefix frontend
```

Create local env files from the examples:

```bash
cp backend/.env.example backend/.env
cp frontend/.env.local.example frontend/.env.local
```

The local dev helper will also create missing env files automatically on `start`.
Generated files include safe defaults for ports and placeholders for Case.dev
Database/Postgres values that must be replaced before testing auth, uploads,
downloads, or vault sync.

Run `backend/migrations/000_one_shot_schema.sql` against a fresh Case.dev Database
or PostgreSQL-compatible database.

Start both local services:

```bash
scripts/mike-dev.sh start
```

The helper supports `start`, `stop`, `restart`, `status`, and `logs`:

```bash
scripts/mike-dev.sh status
scripts/mike-dev.sh restart backend
scripts/mike-dev.sh logs frontend
scripts/mike-dev.sh stop
```

It writes PID and log files under `.mike-dev/`, which is ignored by git. `status` prints configured ports, URLs, env files, PID files, log files, process state, readiness checks, and any placeholder env values that still need attention.

You can also start services manually. Start the backend:

```bash
npm run dev --prefix backend
```

Start the frontend:

```bash
npm run dev --prefix frontend
```

Open `http://localhost:3000`.

## Required Services

- Case.dev Database or another PostgreSQL-compatible database
- Better Auth tables from `backend/migrations/000_one_shot_schema.sql`
- Case.dev API key for LLM routing, model catalog, Skills, and Vault storage/search
- LibreOffice for DOC/DOCX to PDF conversion
- Strong backend secrets for Better Auth, download-token signing, Case key
  encryption, and Case.dev webhook verification

## Demo Mode

Demo Mode is intended for the hosted CaseMark deployment. It is inert for forks
and local installs unless the backend has both `MIKE_DEMO_MODE=true` and
`MIKE_DEMO_CASE_API_KEY`.

When enabled, users without a personal Case.dev key use the shared demo key and
receive a lifetime budget from `MIKE_DEMO_BUDGET_USD` (default `$5`). Every
metered Case.dev call made with the demo key records usage in
`demo_user_usage` and `demo_usage_events`. Users who save their own Case.dev key
use that key first and are no longer charged against the hosted demo budget.

To pause only the hosted demo UI without changing code, set
`MIKE_DEMO_MODE=false` while keeping `MIKE_DEMO_CASE_API_KEY` configured. The
frontend reads `/demo-status` and shows a public paused-demo landing page when
that hosted-demo kill switch is active.

## Checks

```bash
npm run build --prefix backend
npm run build --prefix frontend
(cd frontend && npx tsc --noEmit)
```

Legacy R2 rows from pre-Case deployments can be copied into Case Vault with the
legacy migration helper. It exists for old CaseMark data only; always run the
dry run first and prefer fresh Case Vault storage for new deployments:

```bash
npm --prefix backend run migrate:r2-to-case -- --dry-run
npm --prefix backend run migrate:r2-to-case
```

New deployments do not need R2. Case Vault is the canonical binary document
store for uploads, generated DOCX files, PDF renditions, downloads, and AI
grounding.

## Security

Do not commit real `.env`, `.env.local`, API keys, database URLs, session
secrets, vault IDs, or downloaded client documents. Use GitHub private security
advisories for vulnerability reports; see `SECURITY.md`.

For production, set `CASE_WEBHOOK_SHARED_SECRET`, `DOWNLOAD_SIGNING_SECRET`,
`BETTER_AUTH_SECRET`, and `CASE_KEY_ENCRYPTION_SECRET` to non-placeholder values.
Unsigned Case.dev webhooks are only available when explicitly enabled for local
development with `CASE_WEBHOOK_ALLOW_UNSIGNED=true`.

## License

AGPL-3.0-only. See `LICENSE`. This fork preserves upstream attribution to
`willchen96/mike`.
