import { NextResponse } from "next/server";
import { db, ensureStudySchema } from "@/lib-db";
import { processDocument } from "@/lib-document-processing";
import { currentUserId } from "@/lib-user";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;
const allowedMimeTypes = new Set([
  "application/pdf", "text/plain",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

export async function GET(request: Request) {
  try {
    const userId = await currentUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    await ensureStudySchema();
    const sql = db();
    const rows = await sql`
      select id, title, original_name, file_url, pathname, mime_type, size_bytes,
             processing_status, processing_error, ai_status, ai_error, page_count,
             source_language, explanation_language, created_at, updated_at
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
    const userId = await currentUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const body = await request.json();
    const { title, originalName, fileUrl, pathname, mimeType, sizeBytes, sourceLanguage = "it", explanationLanguage = "it" } = body || {};
    if (!title || !originalName || !fileUrl || !pathname || !mimeType || !sizeBytes) {
      return NextResponse.json({ error: "Missing document metadata" }, { status: 400 });
    }
    if (!allowedMimeTypes.has(String(mimeType)) || Number(sizeBytes) > MAX_UPLOAD_BYTES) {
      return NextResponse.json({ error: "Unsupported file type or file is larger than 250 MB" }, { status: 400 });
    }
    if (!String(pathname).startsWith(`users/${userId}/documents/`)) {
      return NextResponse.json({ error: "Upload ownership mismatch" }, { status: 403 });
    }
    await ensureStudySchema();
    const sql = db();
    const rows = await sql`
      insert into public.documents
        (user_id, title, original_name, file_url, pathname, mime_type, size_bytes, source_language, explanation_language, processing_status)
      values
        (${userId}, ${title}, ${originalName}, ${fileUrl}, ${pathname}, ${mimeType}, ${sizeBytes}, ${sourceLanguage}, ${explanationLanguage}, 'uploaded')
      returning id, title, original_name, file_url, pathname, mime_type, size_bytes,
                processing_status, processing_error, ai_status, ai_error, page_count,
                source_language, explanation_language, created_at, updated_at
    `;
    return NextResponse.json({ document: rows[0] }, { status: 201 });
  } catch (error) {
    console.error("documents POST", error);
    return NextResponse.json({ error: "Could not save document" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json();
  const documentId = String(body?.documentId || "");
  if (!documentId || body?.action !== "process") return NextResponse.json({ error: "Invalid processing request" }, { status: 400 });
  await ensureStudySchema();
  const sql = db();
  const rows = await sql`
    update public.documents set processing_status='processing', processing_error=null, updated_at=now()
    where id=${documentId} and user_id=${userId}
    returning id, pathname, mime_type, size_bytes
  `;
  const document = rows[0];
  if (!document) return NextResponse.json({ error: "Document not found" }, { status: 404 });
  try {
    if (!allowedMimeTypes.has(String(document.mime_type)) || Number(document.size_bytes) > MAX_UPLOAD_BYTES) {
      throw new Error("Unsupported file type or file is larger than 250 MB");
    }
    await processDocument(documentId, userId);
    const ready = await sql`
      select id, title, original_name, file_url, pathname, mime_type, size_bytes,
                processing_status, processing_error, ai_status, ai_error, page_count,
                source_language, explanation_language, created_at, updated_at
      from public.documents where id=${documentId} and user_id=${userId}
    `;
    return NextResponse.json({ document: ready[0] });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Document processing failed";
    await sql`update public.documents set processing_status='error', processing_error=${message}, updated_at=now() where id=${documentId} and user_id=${userId}`;
    return NextResponse.json({ error: message }, { status: 422 });
  }
}
