-- Link Mike workflows to Case.dev Legal Agent Skills.

alter table public.workflows
  add column if not exists case_skill_slug text,
  add column if not exists case_skill_name text,
  add column if not exists case_skill_summary text,
  add column if not exists case_skill_tags jsonb not null default '[]'::jsonb,
  add column if not exists case_skill_source text,
  add column if not exists case_skill_version text,
  add column if not exists case_skill_content_snapshot text,
  add column if not exists case_skill_synced_at timestamptz;

create index if not exists workflows_case_skill_slug_idx
  on public.workflows(case_skill_slug);
