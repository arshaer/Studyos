import { NextResponse } from "next/server";
import { db, ensureStudySchema } from "@/lib-db";
import { currentUserId } from "@/lib-user";

export async function GET() {
  try {
    const userId = await currentUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    await ensureStudySchema();
    const sql = db();
    const [documents, sessions, generations] = await Promise.all([
      sql`select count(*)::int as total, count(*) filter (where processing_status='ready')::int as ready from public.documents where user_id=${userId}`,
      sql`select count(*)::int as total, coalesce(sum(focused_seconds),0)::bigint as focused_seconds, coalesce(sum(completed_cycles),0)::int as cycles from public.study_sessions where user_id=${userId}`,
      sql`select count(*)::int as total,
                 count(*) filter (where mode='tutor')::int as tutor,
                 count(*) filter (where mode='summary')::int as summaries,
                 count(*) filter (where mode='flashcards')::int as flashcards,
                 count(*) filter (where mode='questions')::int as questions
          from public.ai_generations where user_id=${userId}`,
    ]);
    return NextResponse.json({ documents: documents[0], sessions: sessions[0], generations: generations[0] });
  } catch (error) {
    console.error("progress GET", error);
    return NextResponse.json({ error: "Could not load progress" }, { status: 500 });
  }
}
