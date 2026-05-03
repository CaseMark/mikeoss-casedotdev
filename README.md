# mikeoss-casedotdev

Open-source Case.dev fork of Mike. This repository keeps the GitHub fork
relationship with `willchen96/mike` while wiring Mike to Case.dev primitives for
LLM routing, model selection, Skills, Vault-backed document storage, document
grounding, and Case DB/Postgres-compatible persistence.

This project is developer-oriented software for legal workflows. It is not a
law firm, lawyer, or substitute for professional legal advice.

## Contents

- `frontend/` - Next.js application
- `backend/` - Express API, Better Auth, Case DB access, document processing, and migrations
- `backend/migrations/000_one_shot_schema.sql` - one-shot Case DB/Postgres schema for fresh databases

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

## Checks

```bash
npm run build --prefix backend
npm run build --prefix frontend
(cd frontend && npx tsc --noEmit)
```

Legacy R2 rows from pre-Case deployments can be copied into Case Vault with:

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

## License

AGPL-3.0-only. See `LICENSE`. This fork preserves upstream attribution to
`willchen96/mike`.
