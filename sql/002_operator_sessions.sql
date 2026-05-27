create table if not exists public.operator_sessions (
  id uuid primary key default gen_random_uuid(),

  operator_id uuid references public.operators(id) on delete cascade,
  token_hash text not null,

  user_agent text,
  extension_id text,

  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create index if not exists idx_operator_sessions_operator_id
on public.operator_sessions (operator_id);

create index if not exists idx_operator_sessions_token_hash
on public.operator_sessions (token_hash);

create index if not exists idx_operator_sessions_expires_at
on public.operator_sessions (expires_at);
