create table if not exists public.operators (
  id uuid primary key default gen_random_uuid(),

  username text not null unique,
  display_name text not null,

  password_hash text,
  shared_key text,

  status text not null default 'active',
  role text not null default 'operator',

  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_login_at timestamptz
);

create index if not exists idx_operators_username
on public.operators (username);

create index if not exists idx_operators_status
on public.operators (status);

create index if not exists idx_operators_role
on public.operators (role);
