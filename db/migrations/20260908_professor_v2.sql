-- Professor V2, normalized learning state, request economics, and admin controls.
-- Additive and idempotent: existing lessons and telemetry remain readable.
create table if not exists public.course_exam_profiles (
  user_id text not null,
  document_id uuid not null references public.documents(id) on delete cascade,
  exam_date date,
  exam_format text not null default 'mixed',
  confidence text not null default 'medium',
  available_study_days int,
  professor_notes text,
  updated_at timestamptz not null default now(),
  primary key (user_id, document_id)
);

create table if not exists public.course_concepts (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  document_id uuid not null references public.documents(id) on delete cascade,
  section_id uuid references public.document_sections(id) on delete cascade,
  concept_key text not null,
  title text not null,
  prerequisites_json jsonb not null default '[]'::jsonb,
  key_facts_json jsonb not null default '[]'::jsonb,
  common_mistakes_json jsonb not null default '[]'::jsonb,
  chunk_indexes_json jsonb not null default '[]'::jsonb,
  page_start int,
  page_end int,
  exam_importance int not null default 3 check (exam_importance between 1 and 5),
  hierarchy_json jsonb not null default '{}'::jsonb,
  confidence numeric(4,3),
  method text not null default 'indexed_section',
  source_version int not null default 1,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (user_id, document_id, concept_key, source_version)
);
create index if not exists course_concepts_retrieval_idx on public.course_concepts(user_id,document_id,section_id,exam_importance desc);

create table if not exists public.student_concept_state (
  user_id text not null,
  document_id uuid not null references public.documents(id) on delete cascade,
  concept_id uuid not null references public.course_concepts(id) on delete cascade,
  state text not null default 'not_seen' check (state in ('not_seen','learning','understood','exam_ready','mastered')),
  skipped boolean not null default false,
  weak boolean not null default false,
  force_skipped boolean not null default false,
  mastery_score numeric(5,2),
  misconceptions_json jsonb not null default '[]'::jsonb,
  recent_mistakes_json jsonb not null default '[]'::jsonb,
  verification_outcomes_json jsonb not null default '[]'::jsonb,
  last_seen_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key(user_id,document_id,concept_id)
);
create index if not exists student_concept_weak_idx on public.student_concept_state(user_id,document_id,weak,state);

create table if not exists public.professor_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  document_id uuid not null references public.documents(id) on delete cascade,
  lesson_id uuid references public.professor_lessons(id) on delete set null,
  status text not null default 'active',
  started_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  ended_at timestamptz
);
create index if not exists professor_sessions_economics_idx on public.professor_sessions(user_id,started_at desc);

create table if not exists public.professor_content_cache (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  document_id uuid not null references public.documents(id) on delete cascade,
  cache_key text not null unique,
  concept_id uuid references public.course_concepts(id) on delete cascade,
  language text not null,
  depth text not null,
  source_version int not null,
  content_json jsonb not null,
  provider text,
  model text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);

alter table public.professor_lessons add column if not exists session_id uuid references public.professor_sessions(id) on delete set null;
alter table public.professor_lessons add column if not exists current_concept_id uuid references public.course_concepts(id) on delete set null;
alter table public.professor_lessons add column if not exists phase text not null default 'teach';
alter table public.professor_lessons add column if not exists recent_turns_json jsonb not null default '[]'::jsonb;
alter table public.professor_lessons add column if not exists exam_mode boolean not null default false;
alter table public.professor_lessons add column if not exists lesson_position int not null default 0;

alter table public.ai_requests add column if not exists feature text;
alter table public.ai_requests add column if not exists request_id text;
alter table public.ai_requests add column if not exists session_id uuid;
alter table public.ai_requests add column if not exists cached_input_tokens int not null default 0;
alter table public.ai_requests add column if not exists reasoning_tokens int not null default 0;
alter table public.ai_requests add column if not exists other_billable_tokens int not null default 0;
alter table public.ai_requests add column if not exists cost_currency text not null default 'USD';
alter table public.ai_requests add column if not exists pricing_version text;
alter table public.ai_requests add column if not exists retry_count int not null default 0;
alter table public.ai_requests add column if not exists fallback_used boolean not null default false;
alter table public.ai_requests add column if not exists throttled boolean not null default false;
alter table public.ai_requests add column if not exists attempt_count int not null default 1;
alter table public.ai_requests add column if not exists metadata_json jsonb not null default '{}'::jsonb;
update public.ai_requests set feature=task_type where feature is null;
create unique index if not exists ai_requests_request_id_uidx on public.ai_requests(request_id) where request_id is not null;
create index if not exists ai_requests_admin_period_idx on public.ai_requests(created_at,provider,feature,model);
create index if not exists ai_requests_session_idx on public.ai_requests(session_id,created_at) where session_id is not null;

create table if not exists public.ai_model_pricing (
  provider text not null,
  model text not null,
  version text not null,
  input_per_million_usd numeric(12,6) not null default 0,
  cached_input_per_million_usd numeric(12,6) not null default 0,
  output_per_million_usd numeric(12,6) not null default 0,
  reasoning_per_million_usd numeric(12,6) not null default 0,
  is_paid boolean not null default false,
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key(provider,model,version)
);

create table if not exists public.ai_admin_config (
  singleton boolean primary key default true check(singleton),
  monthly_budget_eur numeric(12,2) not null default 50,
  per_user_monthly_limit_eur numeric(12,2) not null default 10,
  usd_to_eur numeric(10,6) not null default 0.92,
  warning_thresholds_json jsonb not null default '[70,90,100]'::jsonb,
  professor_primary_provider text not null default 'free',
  professor_primary_model text,
  professor_fallback_provider text not null default 'free',
  professor_fallback_model text,
  budget_limit_policy text not null default 'fallback' check (budget_limit_policy in ('disable','fallback','free')),
  updated_by text,
  updated_at timestamptz not null default now()
);
insert into public.ai_admin_config(singleton) values(true) on conflict(singleton) do nothing;
