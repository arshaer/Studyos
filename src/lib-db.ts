import { neon } from "@neondatabase/serverless";

let schemaReady: Promise<void> | null = null;

export function db() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not configured");
  return neon(url);
}

export function ensureStudySchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const sql = db();
      await sql`create extension if not exists pgcrypto`;
      await sql`
        create table if not exists public.documents (
          id uuid primary key default gen_random_uuid(),
          user_id text not null,
          course_id uuid,
          title text not null,
          original_name text not null,
          file_url text not null,
          pathname text not null,
          mime_type text not null,
          size_bytes bigint not null default 0,
          page_count int,
          source_language text not null default 'it',
          explanation_language text not null default 'it',
          processing_status text not null default 'uploaded',
          processing_error text,
          ai_status text not null default 'idle',
          ai_error text,
          updated_at timestamptz not null default now(),
          created_at timestamptz not null default now()
        )
      `;
      await sql`alter table public.documents add column if not exists processing_error text`;
      await sql`alter table public.documents add column if not exists ai_status text not null default 'idle'`;
      await sql`alter table public.documents add column if not exists ai_error text`;
      await sql`alter table public.documents add column if not exists updated_at timestamptz not null default now()`;
      await sql`alter table public.documents add column if not exists index_confidence numeric(4,3)`;
      await sql`alter table public.documents add column if not exists index_version int not null default 1`;
      await sql`create index if not exists documents_user_created_idx on public.documents (user_id, created_at desc)`;
      await sql`
        create table if not exists public.document_pages (
          id bigserial primary key,
          document_id uuid not null references public.documents(id) on delete cascade,
          user_id text not null,
          page_number int not null,
          content text not null,
          char_start int not null,
          char_end int not null,
          created_at timestamptz not null default now(),
          unique (document_id, page_number)
        )
      `;
      await sql`create index if not exists document_pages_owner_idx on public.document_pages (user_id, document_id, page_number)`;
      await sql`
        create table if not exists public.document_sections (
          id uuid primary key default gen_random_uuid(),
          document_id uuid not null references public.documents(id) on delete cascade,
          user_id text not null,
          parent_id uuid references public.document_sections(id) on delete cascade,
          kind text not null,
          level int not null default 1,
          title text not null,
          order_index int not null,
          page_start int not null,
          page_end int not null,
          char_start int not null,
          char_end int not null,
          confidence numeric(4,3),
          source text not null default 'heuristic',
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          unique (document_id, order_index)
        )
      `;
      await sql`create index if not exists document_sections_owner_idx on public.document_sections (user_id, document_id, order_index)`;
      await sql`create index if not exists document_sections_parent_idx on public.document_sections (document_id, parent_id, order_index)`;
      await sql`
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
          char_start int,
          char_end int,
          token_estimate int,
          char_count int not null,
          created_at timestamptz not null default now(),
          unique (document_id, chunk_index)
        )
      `;
      await sql`alter table public.document_chunks add column if not exists section_id uuid references public.document_sections(id) on delete set null`;
      await sql`alter table public.document_chunks add column if not exists char_start int`;
      await sql`alter table public.document_chunks add column if not exists char_end int`;
      await sql`alter table public.document_chunks add column if not exists token_estimate int`;
      await sql`alter table public.document_sections add column if not exists detection_method text not null default 'heuristic'`;
      await sql`alter table public.document_sections add column if not exists confidence_reason text`;
      await sql`create index if not exists document_chunks_owner_idx on public.document_chunks (user_id, document_id, chunk_index)`;
      await sql`
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
        )
      `;
      await sql`create index if not exists document_reading_progress_recent_idx on public.document_reading_progress (user_id, last_opened_at desc)`;
      await sql`
        create table if not exists public.study_sessions (
          id uuid primary key default gen_random_uuid(),
          user_id text not null,
          document_id uuid references public.documents(id) on delete set null,
          title text,
          mode text not null default 'pomodoro',
          focus_minutes int not null default 25,
          break_minutes int not null default 5,
          target_cycles int not null default 4,
          completed_cycles int not null default 0,
          focused_seconds int not null default 0,
          break_seconds int not null default 0,
          status text not null default 'active',
          started_at timestamptz not null default now(),
          ended_at timestamptz,
          created_at timestamptz not null default now()
        )
      `;
      await sql`create index if not exists study_sessions_user_created_idx on public.study_sessions (user_id, created_at desc)`;
      await sql`
        create table if not exists public.study_intervals (
          id uuid primary key default gen_random_uuid(),
          session_id uuid not null references public.study_sessions(id) on delete cascade,
          user_id text not null,
          interval_type text not null,
          planned_seconds int not null,
          actual_seconds int not null,
          completed boolean not null default true,
          created_at timestamptz not null default now()
        )
      `;
      await sql`
        create table if not exists public.ai_generations (
          id uuid primary key default gen_random_uuid(), user_id text not null,
          document_id uuid references public.documents(id) on delete set null,
          mode text not null, provider text not null default 'gemini', model text not null, prompt text, response_json jsonb not null,
          input_tokens int not null default 0, output_tokens int not null default 0,
          created_at timestamptz not null default now()
        )
      `;
      await sql`alter table public.ai_generations add column if not exists provider text not null default 'openai'`;
      await sql`alter table public.ai_generations add column if not exists scope_json jsonb`;
      await sql`alter table public.ai_generations add column if not exists status text not null default 'completed'`;
      await sql`alter table public.ai_generations add column if not exists updated_at timestamptz not null default now()`;
      await sql`alter table public.ai_generations add column if not exists completed_at timestamptz`;
      await sql`
        create table if not exists public.ai_conversations (
          id uuid primary key default gen_random_uuid(), user_id text not null,
          document_id uuid not null references public.documents(id) on delete cascade,
          title text not null, scope_json jsonb not null default '{"type":"entire"}'::jsonb,
          provider text, model text, created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        )
      `;
      await sql`create index if not exists ai_conversations_owner_idx on public.ai_conversations(user_id, updated_at desc)`;
      await sql`
        create table if not exists public.ai_messages (
          id uuid primary key default gen_random_uuid(), conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
          user_id text not null, role text not null check(role in ('user','assistant')),
          content_json jsonb not null, citations_json jsonb not null default '[]'::jsonb,
          provider text, model text, input_tokens int not null default 0, output_tokens int not null default 0,
          status text not null default 'completed', created_at timestamptz not null default now()
        )
      `;
      await sql`create index if not exists ai_messages_owner_idx on public.ai_messages(user_id, conversation_id, created_at)`;
      await sql`alter table public.ai_generations add column if not exists conversation_id uuid references public.ai_conversations(id) on delete set null`;
      await sql`create index if not exists ai_generations_user_created_idx on public.ai_generations (user_id, created_at desc)`;
      await sql`alter table public.ai_generations add column if not exists scope_key text`;
      await sql`alter table public.ai_generations add column if not exists version int not null default 1`;
      await sql`alter table public.ai_generations add column if not exists language text`;
      await sql`alter table public.ai_generations add column if not exists detail_level text`;
      await sql`alter table public.ai_generations add column if not exists cache_key text`;
      await sql`alter table public.ai_generations add column if not exists source_version int`;
      await sql`alter table public.ai_generations add column if not exists policy_version text`;
      await sql`create index if not exists ai_summary_scope_idx on public.ai_generations(user_id,document_id,mode,scope_key,created_at desc)`;
      await sql`create index if not exists ai_generation_cache_idx on public.ai_generations(user_id,cache_key,created_at desc) where status='completed'`;
      await sql`create table if not exists public.tutor_profiles(id uuid primary key default gen_random_uuid(),user_id text not null,document_id uuid not null references public.documents(id) on delete cascade,target text not null,deadline date not null,hours_per_day numeric(4,2) not null,current_level text not null,studied_section_ids jsonb not null default '[]'::jsonb,weak_section_ids jsonb not null default '[]'::jsonb,study_style text not null default 'mixed',preferred_language text not null default 'it',unavailable_dates jsonb not null default '[]'::jsonb,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(user_id,document_id))`;
      await sql`create table if not exists public.study_plans(id uuid primary key default gen_random_uuid(),user_id text not null,document_id uuid not null references public.documents(id) on delete cascade,profile_id uuid not null references public.tutor_profiles(id) on delete cascade,version int not null default 1,status text not null default 'active',reason text,created_at timestamptz not null default now(),updated_at timestamptz not null default now())`;
      await sql`create table if not exists public.study_plan_tasks(id uuid primary key default gen_random_uuid(),plan_id uuid not null references public.study_plans(id) on delete cascade,user_id text not null,document_id uuid not null references public.documents(id) on delete cascade,section_id uuid references public.document_sections(id) on delete set null,task_date date not null,task_type text not null,title text not null,estimated_minutes int not null,order_index int not null,status text not null default 'planned',actual_minutes int not null default 0,score numeric(5,2),completed_at timestamptz,created_at timestamptz not null default now())`;
      await sql`create index if not exists study_plan_tasks_owner_date_idx on public.study_plan_tasks(user_id,document_id,task_date)`;
      await sql`create table if not exists public.section_mastery(user_id text not null,document_id uuid not null references public.documents(id) on delete cascade,section_id uuid not null references public.document_sections(id) on delete cascade,reading_percent numeric(5,2) not null default 0,study_seconds int not null default 0,flashcards_reviewed int not null default 0,recall_accuracy numeric(5,2),questions_answered int not null default 0,question_accuracy numeric(5,2),confidence numeric(5,2),updated_at timestamptz not null default now(),primary key(user_id,document_id,section_id))`;
      await sql`alter table public.study_plan_tasks add column if not exists learning_status text not null default 'not_started'`;
      await sql`create table if not exists public.user_profiles(user_id text primary key,display_name text,app_language text not null default 'en',teaching_language text not null default 'it',study_style text not null default 'mixed',default_session_minutes int not null default 25,break_minutes int not null default 5,daily_study_hours numeric(4,2),explanation_depth text not null default 'adaptive',academic_level text not null default 'beginner',exam_style text not null default 'mixed',study_days jsonb not null default '[]'::jsonb,theme text not null default 'system',updated_at timestamptz not null default now())`;
      await sql`create table if not exists public.professor_lessons(id uuid primary key default gen_random_uuid(),user_id text not null,document_id uuid not null references public.documents(id) on delete cascade,section_id uuid not null references public.document_sections(id) on delete cascade,task_id uuid references public.study_plan_tasks(id) on delete set null,status text not null default 'learning',current_stage int not null default 0,stages_json jsonb not null default '[]'::jsonb,doubts_json jsonb not null default '[]'::jsonb,mastery_questions_json jsonb not null default '[]'::jsonb,mastery_score numeric(5,2),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(user_id,document_id,section_id))`;
      await sql`alter table public.professor_lessons add column if not exists provider text`;
      await sql`alter table public.professor_lessons add column if not exists model text`;
      await sql`alter table public.professor_lessons add column if not exists input_tokens int not null default 0`;
      await sql`alter table public.professor_lessons add column if not exists output_tokens int not null default 0`;
      await sql`create table if not exists public.weak_concepts(id uuid primary key default gen_random_uuid(),user_id text not null,document_id uuid not null references public.documents(id) on delete cascade,section_id uuid not null references public.document_sections(id) on delete cascade,concept text not null,evidence text,resolved boolean not null default false,created_at timestamptz not null default now(),updated_at timestamptz not null default now())`;
      await sql`create table if not exists public.ai_requests(id uuid primary key default gen_random_uuid(),user_id text not null,document_id uuid references public.documents(id) on delete set null,task_type text not null,gateway text not null default 'studyos',provider text not null,model text not null,input_tokens int not null default 0,output_tokens int not null default 0,estimated_cost numeric(14,8),cost_status text not null default 'unknown',latency_ms int not null default 0,fallback_count int not null default 0,compression_enabled boolean not null default false,compression_policy text not null default 'off',compression_ratio numeric(6,5),success boolean not null,error_type text,created_at timestamptz not null default now())`;
      await sql`create index if not exists ai_requests_user_created_idx on public.ai_requests(user_id,created_at desc)`;
      await sql`create index if not exists ai_requests_observability_idx on public.ai_requests(provider,task_type,success,created_at desc)`;
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}
