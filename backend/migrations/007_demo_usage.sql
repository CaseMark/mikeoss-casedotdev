-- Demo-mode Case.dev usage ledger.
-- Enables a backend-enforced lifetime budget when MIKE_DEMO_MODE=true.

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
