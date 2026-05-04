-- Persist user-pinned Case.dev skills for the Workflows Skills catalog.

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
