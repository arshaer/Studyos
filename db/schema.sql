-- StudyOS Phase 3.1 reference schema.
-- The app also creates these tables automatically on first use.
create extension if not exists pgcrypto;
create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(), user_id text not null, course_id uuid,
  title text not null, original_name text not null, file_url text not null, pathname text not null,
  mime_type text not null, size_bytes bigint not null default 0, page_count int,
  source_language text not null default 'it', explanation_language text not null default 'it',
  processing_status text not null default 'uploaded', processing_error text,
  ai_status text not null default 'idle', ai_error text,
  index_confidence numeric(4,3), index_version int not null default 1,
  updated_at timestamptz not null default now(), created_at timestamptz not null default now()
);
create table if not exists public.document_pages (
  id bigserial primary key, document_id uuid not null references public.documents(id) on delete cascade,
  user_id text not null, page_number int not null, content text not null, char_start int not null, char_end int not null,
  created_at timestamptz not null default now(), unique (document_id, page_number)
);
create index if not exists document_pages_owner_idx on public.document_pages (user_id, document_id, page_number);
create table if not exists public.document_sections (
  id uuid primary key default gen_random_uuid(), document_id uuid not null references public.documents(id) on delete cascade,
  user_id text not null, parent_id uuid references public.document_sections(id) on delete cascade,
  kind text not null, level int not null default 1, title text not null, order_index int not null,
  page_start int not null, page_end int not null, char_start int not null, char_end int not null,
  confidence numeric(4,3), source text not null default 'heuristic', created_at timestamptz not null default now(),
  detection_method text not null default 'heuristic', confidence_reason text,
  updated_at timestamptz not null default now(), unique (document_id, order_index)
);
create index if not exists document_sections_owner_idx on public.document_sections (user_id, document_id, order_index);
create table if not exists public.study_sessions (
  id uuid primary key default gen_random_uuid(), user_id text not null, document_id uuid references public.documents(id) on delete set null,
  title text, mode text not null default 'pomodoro', focus_minutes int not null default 25, break_minutes int not null default 5,
  target_cycles int not null default 4, completed_cycles int not null default 0, focused_seconds int not null default 0,
  break_seconds int not null default 0, status text not null default 'active', started_at timestamptz not null default now(),
  ended_at timestamptz, created_at timestamptz not null default now()
);
create table if not exists public.study_intervals (
  id uuid primary key default gen_random_uuid(), session_id uuid not null references public.study_sessions(id) on delete cascade,
  user_id text not null, interval_type text not null, planned_seconds int not null, actual_seconds int not null,
  completed boolean not null default true, created_at timestamptz not null default now()
);
create table if not exists public.ai_generations (
  id uuid primary key default gen_random_uuid(), user_id text not null,
  document_id uuid references public.documents(id) on delete set null,
  mode text not null, provider text not null default 'gemini', model text not null, prompt text, response_json jsonb not null,
  input_tokens int not null default 0, output_tokens int not null default 0, scope_json jsonb,
  status text not null default 'completed', completed_at timestamptz, updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create table if not exists public.ai_conversations (
  id uuid primary key default gen_random_uuid(), user_id text not null,
  document_id uuid not null references public.documents(id) on delete cascade,
  title text not null, scope_json jsonb not null default '{"type":"entire"}'::jsonb,
  provider text, model text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.ai_messages (
  id uuid primary key default gen_random_uuid(), conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
  user_id text not null, role text not null check(role in ('user','assistant')), content_json jsonb not null,
  citations_json jsonb not null default '[]'::jsonb, provider text, model text,
  input_tokens int not null default 0, output_tokens int not null default 0,
  status text not null default 'completed', created_at timestamptz not null default now()
);
alter table public.ai_generations add column if not exists conversation_id uuid references public.ai_conversations(id) on delete set null;
create table if not exists public.document_chunks (
  id bigserial primary key,
  document_id uuid not null references public.documents(id) on delete cascade,
  user_id text not null,
  chunk_index int not null,
  content text not null,
  page_start int,
  page_end int,
  section text,
  section_id uuid references public.document_sections(id) on delete set null,
  char_start int, char_end int, token_estimate int,
  char_count int not null,
  created_at timestamptz not null default now(),
  unique (document_id, chunk_index)
);
create index if not exists document_chunks_owner_idx on public.document_chunks (user_id, document_id, chunk_index);
create table if not exists public.document_reading_progress (
  user_id text not null,
  document_id uuid not null references public.documents(id) on delete cascade,
  current_page int not null default 1,
  total_pages int not null default 1,
  percent_complete numeric(5,2) not null default 0,
  reading_seconds int not null default 0,
  last_opened_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, document_id)
);
create index if not exists document_reading_progress_recent_idx on public.document_reading_progress (user_id, last_opened_at desc);
