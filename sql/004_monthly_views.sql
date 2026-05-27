create or replace view public.monthly_warning_summary as
select
  month_key,
  operator_username,
  warning_type,
  phrase,
  count(*) as total
from public.warning_events
group by month_key, operator_username, warning_type, phrase
order by month_key desc, total desc;

create or replace view public.monthly_token_summary as
select
  to_char(created_at, 'YYYY-MM') as month_key,
  operator_id,
  action,
  model,
  count(*) as requests,
  sum(prompt_tokens) as prompt_tokens,
  sum(completion_tokens) as completion_tokens,
  sum(total_tokens) as total_tokens
from public.token_usage
group by to_char(created_at, 'YYYY-MM'), operator_id, action, model
order by month_key desc, total_tokens desc;
