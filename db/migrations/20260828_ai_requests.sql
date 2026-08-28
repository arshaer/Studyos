-- Additive, idempotent StudyOS AI Gateway telemetry. No existing data is modified.
create table if not exists public.ai_requests (
  id uuid primary key default gen_random_uuid(), user_id text not null,
  document_id uuid references public.documents(id) on delete set null,
  task_type text not null, gateway text not null default 'studyos', provider text not null, model text not null,
  input_tokens int not null default 0, output_tokens int not null default 0,
  estimated_cost numeric(14,8), cost_status text not null default 'unknown', latency_ms int not null default 0,
  fallback_count int not null default 0, compression_enabled boolean not null default false,
  compression_policy text not null default 'off', compression_ratio numeric(6,5), success boolean not null,
  error_type text, created_at timestamptz not null default now()
);
create index if not exists ai_requests_user_created_idx on public.ai_requests(user_id,created_at desc);
create index if not exists ai_requests_observability_idx on public.ai_requests(provider,task_type,success,created_at desc);
alter table public.ai_generations add column if not exists cache_key text;
alter table public.ai_generations add column if not exists source_version int;
alter table public.ai_generations add column if not exists policy_version text;
create index if not exists ai_generation_cache_idx on public.ai_generations(user_id,cache_key,created_at desc) where status='completed';
