# StudyOS 0.3.1 — Live Library + Study Sessions

Next.js study workspace with Neon Auth, Neon/Postgres metadata, private Vercel Blob file storage, and persistent Pomodoro study sessions.

## Included
- Email/password authentication through Neon Auth.
- Private Library uploads: PDF, DOCX, PPTX, TXT up to 60 MB.
- Persistent document metadata in `DATABASE_URL`.
- Default study-content language: Italian (`it`).
- Study Session / Pomodoro mode with configurable focus, break and cycle count.
- Focus/break intervals and completed session time persisted for future analytics.
- Automatic creation of the Phase 3 tables on first Library/Study Session use.
- Existing Tutor, Summary, Flashcards, Questions, Exams and Progress UI retained.

## Required Vercel environment variables
- `NEXT_PUBLIC_NEON_AUTH_URL`
- `DATABASE_URL`
- `BLOB_READ_WRITE_TOKEN`

## Important
AI text extraction, document indexing, generated summaries/flashcards/questions and source-grounded Tutor responses are the next processing phase. The Library and Study Session data layer are live in this version.
