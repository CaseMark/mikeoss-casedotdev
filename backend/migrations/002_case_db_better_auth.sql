-- Move Mike's persistence/auth substrate from Supabase Auth to Better Auth
-- on a PostgreSQL-compatible Case.dev Database.

create extension if not exists "pgcrypto";

-- Better Auth core tables. Column names match Better Auth's PostgreSQL
-- adapter output, including camelCase quoted identifiers.
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

-- Remove Supabase Auth coupling from Mike-owned rows.
do $$
begin
  if to_regclass('auth.users') is not null then
    execute 'drop trigger if exists on_auth_user_created on auth.users';
  end if;
end $$;

drop function if exists public.handle_new_user();

drop policy if exists "Users can view their own profile" on public.user_profiles;
drop policy if exists "Users can update their own profile" on public.user_profiles;
alter table if exists public.user_profiles disable row level security;

alter table if exists public.user_profiles
  drop constraint if exists user_profiles_user_id_fkey;

alter table if exists public.user_profiles
  alter column user_id type text using user_id::text;

alter table if exists public.case_api_credentials
  drop constraint if exists case_api_credentials_user_id_fkey;

alter table if exists public.case_api_credentials
  alter column user_id type text using user_id::text;

alter table if exists public.case_api_credentials disable row level security;

alter table if exists public.user_profiles
  alter column tabular_model set default 'casemark/core-large';

create index if not exists idx_user_profiles_user
  on public.user_profiles(user_id);

create index if not exists case_api_credentials_user_idx
  on public.case_api_credentials(user_id);
