import { get } from "@vercel/blob";
import { NextResponse } from "next/server";
import { db, ensureStudySchema } from "@/lib-db";
import { currentUserId } from "@/lib-user";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await ensureStudySchema();
  const documentId = new URL(request.url).searchParams.get("documentId") || "";
  const sql = db();
  const rows = await sql`select pathname, original_name, mime_type from public.documents where id=${documentId} and user_id=${userId} limit 1`;
  const document = rows[0];
  if (!document || String(document.mime_type) !== "application/pdf") return NextResponse.json({ error: "PDF not found" }, { status: 404 });
  const headers: HeadersInit = {};
  const range = request.headers.get("range");
  if (range) headers.Range = range;
  const result = await get(String(document.pathname), { access: "private", headers });
  if (!result?.stream) return NextResponse.json({ error: "PDF unavailable" }, { status: 404 });
  const responseHeaders = new Headers();
  result.headers.forEach((value, key) => responseHeaders.set(key, value));
  responseHeaders.set("content-type", "application/pdf");
  responseHeaders.set("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(String(document.original_name))}`);
  responseHeaders.set("cache-control", "private, max-age=300");
  return new Response(result.stream, { status: range && responseHeaders.has("content-range") ? 206 : 200, headers: responseHeaders });
}

export async function PATCH(request: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await ensureStudySchema();
  const body = await request.json();
  const documentId = String(body.documentId || "");
  const currentPage = Math.max(1, Math.floor(Number(body.currentPage) || 1));
  const totalPages = Math.max(currentPage, Math.floor(Number(body.totalPages) || currentPage));
  const readingSeconds = Math.max(0, Math.min(300, Math.floor(Number(body.readingSeconds) || 0)));
  const percent = Math.min(100, Math.max(0, Number(((currentPage / totalPages) * 100).toFixed(2))));
  const sql = db();
  const owned = await sql`select id from public.documents where id=${documentId} and user_id=${userId} and mime_type='application/pdf' limit 1`;
  if (!owned[0]) return NextResponse.json({ error: "PDF not found" }, { status: 404 });
  const rows = await sql`
    insert into public.document_reading_progress (user_id, document_id, current_page, total_pages, percent_complete, reading_seconds, last_opened_at, updated_at)
    values (${userId}, ${documentId}, ${currentPage}, ${totalPages}, ${percent}, ${readingSeconds}, now(), now())
    on conflict (user_id, document_id) do update set
      current_page=excluded.current_page, total_pages=excluded.total_pages,
      percent_complete=excluded.percent_complete,
      reading_seconds=public.document_reading_progress.reading_seconds + ${readingSeconds},
      last_opened_at=now(), updated_at=now()
    returning current_page, total_pages, percent_complete, reading_seconds, last_opened_at
  `;
  return NextResponse.json({ progress: rows[0] });
}
