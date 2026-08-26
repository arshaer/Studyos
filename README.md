# StudyOS 0.4.0 — AI Study Engine

Next.js study workspace with Neon Auth, private Vercel Blob storage, Neon/Postgres persistence, Pomodoro sessions, and source-grounded AI study tools.

## Phase 4

- AI Tutor answers from a selected private document and returns source references.
- Structured summaries with adjustable depth.
- Ten-card active-recall deck generation.
- Eight-question multiple-choice practice and exam generation.
- English, Italian, and Persian requests supported.
- Generation history, provider/model, and token usage stored in Neon.
- Per-account safeguard of 40 AI generations per day.
- Source ownership is checked before every generation.

## Existing features preserved

- Email/password authentication through Neon Auth.
- Private PDF, DOCX, PPTX, and TXT uploads up to 60 MB.
- Persistent Library metadata and Pomodoro study sessions.
- Responsive dashboard, Progress, Questions, Exams, and account controls.

## Required Vercel environment variables

- `NEXT_PUBLIC_NEON_AUTH_URL`
- `NEON_AUTH_BASE_URL`
- `NEON_AUTH_COOKIE_SECRET`
- `DATABASE_URL`
- `BLOB_READ_WRITE_TOKEN`
- `GEMINI_API_KEY` (required for the default AI provider; server-side only)
- `GEMINI_MODEL` (optional; defaults to `gemini-2.5-flash`)

Gemini is the default and does not require `OPENAI_API_KEY`. Optional OpenAI support remains available by setting `AI_PROVIDER=openai`, `OPENAI_API_KEY`, and optionally `OPENAI_MODEL`.

Existing databases are migrated automatically on the first request by adding the `ai_generations.provider` column. Existing rows are labeled `openai`; new rows record the provider and model actually used.

AI processing currently accepts selected source files up to 20 MB. The general Library upload limit remains 60 MB.
