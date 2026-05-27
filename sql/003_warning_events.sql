create table if not exists public.warning_events (
  id uuid primary key default gen_random_uuid(),

  operator_id uuid references public.operators(id) on delete set null,
  operator_username text,

  month_key text not null,
  warning_type text not null,
  phrase text,
  message_preview text,

  page_url text,
  page_title text,

  created_at timestamptz not null default now()
);

create index if not exists idx_warning_events_operator_id
on public.warning_events (operator_id);

create index if not exists idx_warning_events_operator_username
on public.warning_events (operator_username);

create index if not exists idx_warning_events_month_key
on public.warning_events (month_key);

create index if not exists idx_warning_events_warning_type
on public.warning_events (warning_type);

create index if not exists idx_warning_events_created_at
on public.warning_events (created_at desc);
