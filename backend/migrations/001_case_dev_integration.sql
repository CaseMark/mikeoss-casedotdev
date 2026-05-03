-- Case.dev integration for existing Mike databases.

create extension if not exists "pgcrypto";

create table if not exists public.case_api_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id text not null unique,
  encrypted_key text not null,
  key_iv text not null,
  key_tag text not null,
  key_last4 text,
  status text not null default 'unverified'
    check (status = any (array[
      'verified'::text,
      'unverified'::text,
      'invalid'::text
    ])),
  verified_at timestamptz,
  capabilities jsonb not null default '{}'::jsonb,
  last_checked_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists case_api_credentials_user_idx
  on public.case_api_credentials(user_id);

alter table public.case_api_credentials
  add column if not exists capabilities jsonb not null default '{}'::jsonb,
  add column if not exists last_checked_at timestamptz;

alter table public.user_profiles
  alter column tabular_model set default 'casemark/core-large';

create table if not exists public.case_vault_links (
  id uuid primary key default gen_random_uuid(),
  owner_user_id text not null,
  project_id uuid references public.projects(id) on delete cascade,
  scope text not null
    check (scope = any (array['personal'::text, 'project'::text])),
  case_vault_id text not null,
  name text not null,
  status text not null default 'active'
    check (status = any (array['active'::text, 'error'::text])),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists case_vault_links_personal_unique
  on public.case_vault_links(owner_user_id)
  where scope = 'personal';

create unique index if not exists case_vault_links_project_unique
  on public.case_vault_links(project_id)
  where scope = 'project' and project_id is not null;

create index if not exists case_vault_links_owner_idx
  on public.case_vault_links(owner_user_id);

create table if not exists public.case_document_links (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  version_id uuid not null references public.document_versions(id) on delete cascade,
  role text not null default 'source'
    check (role = any (array[
      'source'::text,
      'pdf_rendition'::text,
      'generated'::text
    ])),
  vault_link_id uuid references public.case_vault_links(id) on delete set null,
  case_vault_id text,
  case_object_id text,
  content_hash text,
  filename text,
  content_type text,
  size_bytes integer,
  sync_status text not null default 'pending'
    check (sync_status = any (array[
      'pending'::text,
      'uploading'::text,
      'ingesting'::text,
      'completed'::text,
      'failed'::text,
      'skipped'::text
    ])),
  ingestion_status text,
  page_count integer,
  text_length integer,
  chunk_count integer,
  error text,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists case_document_links_version_unique
  on public.case_document_links(document_id, version_id, role);

create unique index if not exists case_document_links_case_object_unique
  on public.case_document_links(case_vault_id, case_object_id)
  where case_vault_id is not null and case_object_id is not null;

create index if not exists case_document_links_document_idx
  on public.case_document_links(document_id, sync_status);
