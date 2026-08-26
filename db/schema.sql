-- StudyOS Phase 3.1 reference schema.
-- The app also creates these tables automatically on first use.
create extension if not exists pgcrypto;
create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(), user_id text not null, course_id uuid,
  title text not null, original_name text not null, file_url text not null, pathname text not null,
  mime_type text not null, size_bytes bigint not null default 0, page_count int,
  source_language text not null default 'it', explanation_language text not null default 'it',
  processing_status text not null default 'uploaded', created_at timestamptz not null default now()
);
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
