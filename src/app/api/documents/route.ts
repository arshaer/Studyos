import { NextResponse } from "next/server";
import { db, ensureStudySchema } from "@/lib-db";

function userIdFrom(request: Request) {
  return request.headers.get("x-studyos-user-id")?.trim() || "";
}

export async function GET(request: Request) {
  try {
    const userId = userIdFrom(request);
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    await ensureStudySchema();
    const sql = db();
    const rows = await sql`
      select id, title, original_name, file_url, pathname, mime_type, size_bytes,
             processing_status, page_count, source_language, explanation_language, created_at
      from public.documents
      where user_id = ${userId}
      order by created_at desc
    `;
    return NextResponse.json({ documents: rows });
  } catch (error) {
    console.error("documents GET", error);
    return NextResponse.json({ error: "Could not load library" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const userId = userIdFrom(request);
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const body = await request.json();
    const { title, originalName, fileUrl, pathname, mimeType, sizeBytes, sourceLanguage = "it", explanationLanguage = "it" } = body || {};
    if (!title || !originalName || !fileUrl || !pathname || !mimeType || !sizeBytes) {
      return NextResponse.json({ error: "Missing document metadata" }, { status: 400 });
    }
    await ensureStudySchema();
    const sql = db();
    const rows = await sql`
      insert into public.documents
        (user_id, title, original_name, file_url, pathname, mime_type, size_bytes, source_language, explanation_language, processing_status)
      values
        (${userId}, ${title}, ${originalName}, ${fileUrl}, ${pathname}, ${mimeType}, ${sizeBytes}, ${sourceLanguage}, ${explanationLanguage}, 'uploaded')
      returning id, title, original_name, file_url, pathname, mime_type, size_bytes,
                processing_status, page_count, source_language, explanation_language, created_at
    `;
    return NextResponse.json({ document: rows[0] }, { status: 201 });
  } catch (error) {
    console.error("documents POST", error);
    return NextResponse.json({ error: "Could not save document" }, { status: 500 });
  }
}
