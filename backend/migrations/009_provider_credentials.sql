create table if not exists public.provider_api_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public."user"(id) on delete cascade,
  provider text not null check (provider = any (array[
    'anthropic'::text,
    'gemini'::text
  ])),
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
  updated_at timestamptz not null default now(),
  unique(user_id, provider)
);

create index if not exists provider_api_credentials_user_idx
  on public.provider_api_credentials(user_id);
