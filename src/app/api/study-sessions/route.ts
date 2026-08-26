import { NextResponse } from "next/server";
import { db, ensureStudySchema } from "@/lib-db";
import { currentUserId } from "@/lib-user";

export async function GET() {
  try {
    const userId = await currentUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    await ensureStudySchema();
    const sql = db();
    const rows = await sql`
      select id, title, mode, focus_minutes, break_minutes, target_cycles, completed_cycles,
             focused_seconds, break_seconds, status, started_at, ended_at, created_at
      from public.study_sessions where user_id=${userId} order by created_at desc limit 20
    `;
    return NextResponse.json({ sessions: rows });
  } catch (e) {
    console.error(e); return NextResponse.json({ error: "Could not load study sessions" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const userId = await currentUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const body = await request.json();
    await ensureStudySchema();
    const sql = db();
    if (body.action === "interval") {
      const intervals = await sql`
        insert into public.study_intervals (session_id, user_id, interval_type, planned_seconds, actual_seconds, completed)
        select id, ${userId}, ${body.intervalType}, ${body.plannedSeconds}, ${body.actualSeconds}, ${body.completed !== false}
        from public.study_sessions where id=${body.sessionId} and user_id=${userId}
        returning id
      `;
      if (!intervals[0]) return NextResponse.json({ error: "Study session not found" }, { status: 404 });
      if (body.intervalType === "focus") {
        await sql`update public.study_sessions set focused_seconds=focused_seconds+${body.actualSeconds}, completed_cycles=completed_cycles+1 where id=${body.sessionId} and user_id=${userId}`;
      } else {
        await sql`update public.study_sessions set break_seconds=break_seconds+${body.actualSeconds} where id=${body.sessionId} and user_id=${userId}`;
      }
      return NextResponse.json({ ok: true });
    }
    if (body.action === "finish") {
      await sql`update public.study_sessions set status='completed', ended_at=now() where id=${body.sessionId} and user_id=${userId}`;
      return NextResponse.json({ ok: true });
    }
    if (body.documentId) {
      const owned = await sql`select id from public.documents where id=${body.documentId} and user_id=${userId} limit 1`;
      if (!owned[0]) return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }
    const rows = await sql`
      insert into public.study_sessions (user_id, document_id, title, mode, focus_minutes, break_minutes, target_cycles)
      values (${userId}, ${body.documentId || null}, ${body.title || 'Study Session'}, ${body.mode || 'pomodoro'}, ${body.focusMinutes || 25}, ${body.breakMinutes || 5}, ${body.targetCycles || 4})
      returning *
    `;
    return NextResponse.json({ session: rows[0] }, { status: 201 });
  } catch (e) {
    console.error(e); return NextResponse.json({ error: "Could not save study session" }, { status: 500 });
  }
}
