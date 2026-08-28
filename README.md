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
- Files are extracted once, split into source-labeled chunks, and indexed in Neon. Tutor, flashcards, and questions retrieve chunks instead of sending the original file to the model.
- Entire-document summaries use hierarchical map-reduce summarization over all persisted chunks.

## Existing features preserved

- Email/password authentication through Neon Auth.
- Direct-to-private-Blob PDF, DOCX, PPTX, and TXT uploads up to 250 MB.
- Explicit document states: Uploaded, Processing, and Ready for AI; AI actions record Generating, Completed, or Error.
- Persistent Library metadata and Pomodoro study sessions.
- Responsive dashboard, Progress, Questions, Exams, and account controls.

## Required Vercel environment variables

- `NEXT_PUBLIC_NEON_AUTH_URL`
- `NEON_AUTH_BASE_URL`
- `NEON_AUTH_COOKIE_SECRET`
- `DATABASE_URL`
- `BLOB_READ_WRITE_TOKEN`
- `GEMINI_API_KEY` (required for the default AI provider; server-side only)
- `GEMINI_MODEL` (optional; defaults to `gemini-3.6-flash`)

Gemini is the default and does not require `OPENAI_API_KEY`. Optional OpenAI support remains available by setting `AI_PROVIDER=openai`, `OPENAI_API_KEY`, and optionally `OPENAI_MODEL`.

## StudyOS AI Gateway

All application generation flows pass through the provider-independent StudyOS gateway:

`StudyOS -> StudyOS AI Gateway -> {OmniRoute, Gemini Direct, OpenAI Direct}`

OmniRoute is optional. Configure `OMNIROUTE_BASE_URL` (including `/v1`) and `OMNIROUTE_API_KEY` to use its documented OpenAI-compatible Chat Completions endpoint. StudyOS uses documented `auto/fast`, `auto`, and `auto/smart` aliases by task quality and explicitly disables OmniRoute compression whenever original indexed evidence is included. Direct Gemini/OpenAI routes remain available if OmniRoute is absent or unhealthy.

Stable summaries, flashcards, and questions are reused only when the document index version, scope, prompt/options, and gateway policy version match. Tutor and Professor answers are never cached. Request telemetry stores routing and usage metadata in `ai_requests`; prompts and source chunks are not copied into that table.

Existing databases are migrated automatically on the first request. Document processing/AI state columns and `ai_generations.provider` are added when missing; new generations record the provider and model actually used.

The Library accepts files up to 250 MB through direct browser-to-Blob upload. Processing extracts PDF/TXT/DOCX/PPTX content into `document_chunks`; AI actions read those chunks, so there is no separate 20 MB or 50 MB AI-source limit.
