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

## What Is Case.dev?

[Case.dev](https://docs.case.dev/) is API-first infrastructure for legal
engineering: matters, vaults, models, agents, and other legal primitives exposed
as composable APIs. The platform is broader than an LLM gateway. Its documented
services include [Matters](https://docs.case.dev/matters), Agents, Vault,
[LLMs](https://docs.case.dev/llms), OCR, Compute, Voice, Search, Legal
Research, Privilege Detection, [Databases](https://docs.case.dev/databases/index),
Memory, Translation, SuperDoc, [Format](https://docs.case.dev/format/index),
Payments, Skills, and AI Governance.

This fork uses Case.dev where it gives Mike a clearer primitive: document vaults
instead of object-storage glue, matters instead of generic projects, a model
gateway instead of one-provider assumptions, skills instead of hardcoded
workflow templates, and legal research tools instead of ungrounded web search.
The backend remains the authorization boundary; the browser never calls
Case.dev directly.

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

## Choose Your Integration Depth

You can use this fork in several modes:

- Full Case.dev: use one Case.dev API key for LLM routing, Vault storage and
  RAG, Matters, Skills, Legal Research, and a Case.dev Database/Postgres
  connection.
- Hybrid BYOK models: use Case.dev for legal and document infrastructure, but
  add your own Anthropic or Gemini key in Account > Models for direct LLM
  routing.
- Bring your own Postgres: run the schema against any compatible PostgreSQL
  database instead of Case.dev Databases.
- Replace individual services: swap adapters behind the backend routes if you
  want your own model gateway, storage system, search index, or matter service.
  The main seams are `backend/src/lib/caseClient.ts`,
  `backend/src/lib/storage.ts`, `backend/src/lib/llm/index.ts`,
  `backend/src/lib/chatTools.ts`, `backend/src/lib/caseMatters.ts`, and the
  `backend/src/routes/*` modules.
- Case-free fork: possible, but not plug-and-play. You must provide replacement
  implementations for storage, text extraction, document search, model routing,
  legal research, skills, and matter metadata before the app is useful.

## Case.dev Primitive Map

| Primitive | Status in this repo | What it does here |
| --- | --- | --- |
| LLMs | Wired | Runtime model catalog and chat completions through Case.dev, with optional direct Anthropic/Gemini BYOK routing. |
| Vault | Wired | Canonical document blob storage, ingestion, OCR/indexing pipeline, extracted text, chunks, search, downloads, and chat grounding. |
| Matters | Wired | User-facing Matters UI, matter metadata, primary vault linkage, work items, and activity/log surfaces. Mike still keeps local auth, ACL, and UI cache rows. |
| Skills | Wired | Search/preview/import Case skills into Mike workflows and make skills discoverable from chat. |
| Legal Research | Wired read-only | Chat tools for external legal sources, citation parsing/verification, court and docket lookup, SEC filings, patents, and trademarks. Live PACER fetches and legal drafting are intentionally disabled. |
| Databases | Supported | The schema runs on Case.dev Databases or any PostgreSQL-compatible database. |
| OCR | Used through Vault | Uploaded documents are processed through Vault ingestion. Standalone OCR APIs are not exposed in the UI yet. |
| Format / SuperDoc | Future candidate | Mike still has its own generated DOCX/PDF paths. Case.dev Format/SuperDoc are natural follow-ups for polished legal document generation and conversion. |
| Agents | Future candidate | Mike currently runs chat/workflows itself. Case.dev Agents could power long-running async legal tasks later. |
| Memory | Future candidate | Suitable for durable user or matter preferences; this repo does not store document contents in Memory. |
| Search | Future candidate | Legal Research is wired; broader Case.dev web/deep search is not a first-class UI feature yet. |
| Privilege Detection | Future candidate | Not exposed yet; a likely fit for review workflows. |
| AI Governance / Events / Usage | Adjacent | Demo metering is local today. Case.dev governance, event, and usage APIs could tighten provider policy and operations later. |
| Voice / Translation / Compute / Payments | Not used today | Documented Case.dev services, but outside this fork's current product surface. |

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
By default, only LLM calls spend demo budget: the backend reserves `$0.10` for
each LLM request, then charges `usage.cost` from Case.dev or token pricing from
the live Case model catalog. Vault, Legal, Skills, Matters, and metadata calls
default to `$0.00` in demo mode. Uploads are capped at 100 MB.

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
development with `CASE_WEBHOOK_ALLOW_UNSIGNED=true`. Download links are
HMAC-signed, authenticated, and expire after `DOWNLOAD_TOKEN_TTL_SECONDS`
(default seven days); keep `DOWNLOAD_TOKEN_ALLOW_LEGACY=false` unless you are
briefly migrating old no-expiry links. Auth and expensive AI routes are
rate-limited with `MIKE_AUTH_*` and `MIKE_AI_*` settings.

## License

AGPL-3.0-only. See `LICENSE`. This fork preserves upstream attribution to
`willchen96/mike`.
