-- Make Case.dev Matters the canonical workspace primitive while keeping
-- Mike's projects table as the local auth/UI cache.

alter table public.projects
  add column if not exists case_matter_id text,
  add column if not exists case_primary_vault_id text,
  add column if not exists matter_status text,
  add column if not exists practice_area text,
  add column if not exists matter_type text,
  add column if not exists client_name text,
  add column if not exists responsible_attorney text,
  add column if not exists case_matter_metadata jsonb not null default '{}'::jsonb,
  add column if not exists matter_sync_status text not null default 'pending',
  add column if not exists matter_sync_error text,
  add column if not exists matter_synced_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'projects_matter_sync_status_check'
      and conrelid = 'public.projects'::regclass
  ) then
    alter table public.projects
      add constraint projects_matter_sync_status_check
      check (matter_sync_status = any (array[
        'pending'::text,
        'active'::text,
        'failed'::text
      ]));
  end if;
end $$;

create unique index if not exists projects_case_matter_id_unique
  on public.projects(case_matter_id)
  where case_matter_id is not null;

create index if not exists projects_case_primary_vault_idx
  on public.projects(case_primary_vault_id)
  where case_primary_vault_id is not null;

alter table public.case_document_links
  add column if not exists vector_count integer,
  add column if not exists graph_status text,
  add column if not exists transcript_object_id text,
  add column if not exists object_metadata jsonb not null default '{}'::jsonb,
  add column if not exists last_seen_at timestamptz;
