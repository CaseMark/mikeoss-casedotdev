-- Mike one-shot Case DB/Postgres schema.
-- Use this for a fresh Case.dev Database or any PostgreSQL-compatible target.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Better Auth core tables
-- ---------------------------------------------------------------------------

create table if not exists public."user" (
  id text primary key,
  name text not null,
  email text not null unique,
  "emailVerified" boolean not null default false,
  image text,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create table if not exists public.session (
  id text primary key,
  "userId" text not null references public."user"(id) on delete cascade,
  token text not null unique,
  "expiresAt" timestamptz not null,
  "ipAddress" text,
  "userAgent" text,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create index if not exists session_user_id_idx
  on public.session("userId");

create table if not exists public.account (
  id text primary key,
  "userId" text not null references public."user"(id) on delete cascade,
  "accountId" text not null,
  "providerId" text not null,
  "accessToken" text,
  "refreshToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  scope text,
  "idToken" text,
  password text,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create index if not exists account_user_id_idx
  on public.account("userId");

create table if not exists public.verification (
  id text primary key,
  identifier text not null,
  value text not null,
  "expiresAt" timestamptz not null,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- User profiles
-- ---------------------------------------------------------------------------

create table if not exists public.user_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id text not null unique references public."user"(id) on delete cascade,
  display_name text,
  organisation text,
  tier text not null default 'Free',
  message_credits_used integer not null default 0,
  credits_reset_date timestamptz not null default (now() + interval '30 days'),
  tabular_model text not null default 'casemark/core-large',
  claude_api_key text,
  gemini_api_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_user_profiles_user
  on public.user_profiles(user_id);

-- ---------------------------------------------------------------------------
-- Projects and documents
-- ---------------------------------------------------------------------------

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  name text not null,
  cm_number text,
  visibility text not null default 'private',
  shared_with jsonb not null default '[]'::jsonb,
  case_matter_id text,
  case_primary_vault_id text,
  matter_status text,
  practice_area text,
  matter_type text,
  client_name text,
  responsible_attorney text,
  case_matter_metadata jsonb not null default '{}'::jsonb,
  matter_sync_status text not null default 'pending'
    check (matter_sync_status = any (array[
      'pending'::text,
      'active'::text,
      'failed'::text
    ])),
  matter_sync_error text,
  matter_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_projects_user
  on public.projects(user_id);

create index if not exists projects_shared_with_idx
  on public.projects using gin (shared_with);

create table if not exists public.project_subfolders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id text not null,
  name text not null,
  parent_folder_id uuid references public.project_subfolders(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_project_subfolders_project
  on public.project_subfolders(project_id);

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  user_id text not null,
  filename text not null,
  file_type text,
  size_bytes integer not null default 0,
  page_count integer,
  structure_tree jsonb,
  status text not null default 'pending',
  folder_id uuid references public.project_subfolders(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_documents_user_project
  on public.documents(user_id, project_id);

create index if not exists idx_documents_project_folder
  on public.documents(project_id, folder_id);

create table if not exists public.document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  storage_path text not null,
  pdf_storage_path text,
  source text not null default 'upload',
  version_number integer,
  display_name text,
  created_at timestamptz not null default now(),
  constraint document_versions_source_check
    check (source = any (array[
      'upload'::text,
      'user_upload'::text,
      'assistant_edit'::text,
      'user_accept'::text,
      'user_reject'::text,
      'generated'::text
    ]))
);

create index if not exists document_versions_document_id_idx
  on public.document_versions(document_id, created_at desc);

create index if not exists document_versions_doc_vnum_idx
  on public.document_versions(document_id, version_number);

alter table public.documents
  add column if not exists current_version_id uuid
  references public.document_versions(id) on delete set null;

create table if not exists public.document_edits (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  chat_message_id uuid,
  version_id uuid not null references public.document_versions(id) on delete cascade,
  change_id text not null,
  del_w_id text,
  ins_w_id text,
  deleted_text text not null default '',
  inserted_text text not null default '',
  context_before text,
  context_after text,
  status text not null default 'pending'
    check (status = any (array[
      'pending'::text,
      'accepted'::text,
      'rejected'::text
    ])),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists document_edits_document_id_idx
  on public.document_edits(document_id, created_at desc);

create index if not exists document_edits_message_id_idx
  on public.document_edits(chat_message_id);

create index if not exists document_edits_version_id_idx
  on public.document_edits(version_id);

-- ---------------------------------------------------------------------------
-- Case.dev integration
-- ---------------------------------------------------------------------------

create table if not exists public.case_api_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id text not null unique references public."user"(id) on delete cascade,
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

-- Users manage credentials only through the backend so encrypted blobs are
-- never exposed to the browser.

create table if not exists public.demo_user_usage (
  user_id text primary key references public."user"(id) on delete cascade,
  limit_usd_micros bigint not null default 5000000
    check (limit_usd_micros >= 0),
  spent_usd_micros bigint not null default 0
    check (spent_usd_micros >= 0),
  reserved_usd_micros bigint not null default 0
    check (reserved_usd_micros >= 0),
  blocked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.demo_usage_events (
  id uuid primary key default gen_random_uuid(),
  request_id text not null,
  user_id text not null references public."user"(id) on delete cascade,
  case_source text not null default 'demo',
  status text not null default 'reserved'
    check (status = any (array[
      'reserved'::text,
      'charged'::text,
      'released'::text
    ])),
  operation text not null,
  service text not null,
  model text,
  estimated_usd_micros bigint not null default 0,
  actual_usd_micros bigint,
  charged_usd_micros bigint not null default 0,
  prompt_tokens integer,
  completion_tokens integer,
  total_tokens integer,
  units jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists demo_usage_events_user_created_idx
  on public.demo_usage_events(user_id, created_at desc);

create index if not exists demo_usage_events_request_idx
  on public.demo_usage_events(request_id);

create index if not exists demo_usage_events_service_idx
  on public.demo_usage_events(service, operation, created_at desc);

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
  vector_count integer,
  graph_status text,
  transcript_object_id text,
  object_metadata jsonb not null default '{}'::jsonb,
  last_seen_at timestamptz,
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

-- ---------------------------------------------------------------------------
-- Workflows
-- ---------------------------------------------------------------------------

create table if not exists public.workflows (
  id uuid primary key default gen_random_uuid(),
  user_id text,
  title text not null,
  type text not null,
  prompt_md text,
  columns_config jsonb,
  practice text,
  case_skill_slug text,
  case_skill_name text,
  case_skill_summary text,
  case_skill_tags jsonb not null default '[]'::jsonb,
  case_skill_source text,
  case_skill_version text,
  case_skill_content_snapshot text,
  case_skill_synced_at timestamptz,
  is_system boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_workflows_user
  on public.workflows(user_id);

create index if not exists workflows_case_skill_slug_idx
  on public.workflows(case_skill_slug);

create table if not exists public.hidden_workflows (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  workflow_id text not null,
  created_at timestamptz not null default now(),
  unique(user_id, workflow_id)
);

create index if not exists idx_hidden_workflows_user
  on public.hidden_workflows(user_id);

create table if not exists public.case_skill_favorites (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public."user"(id) on delete cascade,
  skill_slug text not null,
  skill_name text not null,
  skill_summary text,
  skill_tags jsonb not null default '[]'::jsonb,
  skill_source text,
  skill_version text,
  skill_author_name text,
  skill_license text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, skill_slug)
);

create index if not exists case_skill_favorites_user_created_idx
  on public.case_skill_favorites(user_id, created_at desc);

create table if not exists public.workflow_shares (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  shared_by_user_id text not null,
  shared_with_email text not null,
  allow_edit boolean not null default false,
  created_at timestamptz not null default now(),
  constraint workflow_shares_workflow_email_unique
    unique(workflow_id, shared_with_email)
);

create index if not exists workflow_shares_workflow_id_idx
  on public.workflow_shares(workflow_id);

create index if not exists workflow_shares_email_idx
  on public.workflow_shares(shared_with_email);

-- ---------------------------------------------------------------------------
-- Assistant chats
-- ---------------------------------------------------------------------------

create table if not exists public.chats (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  user_id text not null,
  title text,
  created_at timestamptz not null default now()
);

create index if not exists idx_chats_user
  on public.chats(user_id);

create index if not exists idx_chats_project
  on public.chats(project_id);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats(id) on delete cascade,
  role text not null,
  content jsonb,
  files jsonb,
  annotations jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_chat_messages_chat
  on public.chat_messages(chat_id);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'document_edits_chat_message_id_fkey'
      and conrelid = 'public.document_edits'::regclass
  ) then
    alter table public.document_edits
      add constraint document_edits_chat_message_id_fkey
      foreign key (chat_message_id)
      references public.chat_messages(id)
      on delete set null;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tabular reviews
-- ---------------------------------------------------------------------------

create table if not exists public.tabular_reviews (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  user_id text not null,
  title text,
  columns_config jsonb,
  workflow_id uuid references public.workflows(id) on delete set null,
  practice text,
  shared_with jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_tabular_reviews_user
  on public.tabular_reviews(user_id);

create index if not exists idx_tabular_reviews_project
  on public.tabular_reviews(project_id);

create index if not exists tabular_reviews_shared_with_idx
  on public.tabular_reviews using gin (shared_with);

create table if not exists public.tabular_cells (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.tabular_reviews(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  column_index integer not null,
  content text,
  citations jsonb,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create index if not exists idx_tabular_cells_review
  on public.tabular_cells(review_id, document_id, column_index);

create table if not exists public.tabular_review_chats (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.tabular_reviews(id) on delete cascade,
  user_id text not null,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tabular_review_chats_review_idx
  on public.tabular_review_chats(review_id, updated_at desc);

create index if not exists tabular_review_chats_user_idx
  on public.tabular_review_chats(user_id);

create table if not exists public.tabular_review_chat_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.tabular_review_chats(id) on delete cascade,
  role text not null,
  content jsonb,
  annotations jsonb,
  created_at timestamptz not null default now()
);

create index if not exists tabular_review_chat_messages_chat_idx
  on public.tabular_review_chat_messages(chat_id, created_at);
