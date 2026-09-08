-- Provider-neutral Professor tier policy and normalized usage dimensions.
alter table public.ai_requests add column if not exists requested_tier text;
alter table public.ai_requests add column if not exists underlying_provider text;
alter table public.ai_requests add column if not exists route_origin text not null default 'studyos';
alter table public.ai_requests add column if not exists cache_hit boolean not null default false;

alter table public.ai_admin_config add column if not exists tier_pools_json jsonb not null default '{"economy":{"models":["free"],"fallbackModels":["free"],"maxOutputTokens":350,"maxCostPerRequestUsd":0},"standard":{"models":["free"],"fallbackModels":["free"],"maxOutputTokens":650,"maxCostPerRequestUsd":0},"advanced":{"models":["free"],"fallbackModels":["free"],"maxOutputTokens":1100,"maxCostPerRequestUsd":0}}'::jsonb;
alter table public.ai_admin_config add column if not exists fallback_enabled boolean not null default true;
alter table public.ai_admin_config add column if not exists provider_allowlist_json jsonb not null default '["free"]'::jsonb;
alter table public.ai_admin_config add column if not exists provider_denylist_json jsonb not null default '[]'::jsonb;
alter table public.ai_admin_config add column if not exists require_zdr boolean not null default true;
alter table public.ai_admin_config add column if not exists disallow_training boolean not null default true;
alter table public.ai_admin_config add column if not exists routing_preference text not null default 'price';
alter table public.ai_admin_config add column if not exists threshold_policy text not null default 'cheaper_tier';

create or replace view public.ai_usage as
select id,user_id,feature,session_id,request_id,requested_tier,model,
       underlying_provider,provider,input_tokens,cached_input_tokens,output_tokens,
       reasoning_tokens,other_billable_tokens,estimated_cost,cost_currency,
       pricing_version,latency_ms,success,retry_count,fallback_count,fallback_used,
       error_type,cache_hit,route_origin,created_at
from public.ai_requests;

create index if not exists ai_requests_tier_period_idx on public.ai_requests(requested_tier,created_at desc);
create index if not exists ai_requests_underlying_provider_idx on public.ai_requests(underlying_provider,created_at desc);
