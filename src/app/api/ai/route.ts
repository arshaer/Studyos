import { get } from "@vercel/blob";
import { OfficeParser } from "officeparser";
import { NextResponse } from "next/server";
import { configuredAiProvider, type AiMode, type AiSource } from "@/lib-ai";
import { db, ensureStudySchema } from "@/lib-db";
import { currentUserId } from "@/lib-user";

export const runtime = "nodejs";
export const maxDuration = 60;

const DAILY_LIMIT = 40;
const MAX_AI_SOURCE_BYTES = 50 * 1024 * 1024;
const modes = new Set(["tutor", "summary", "flashcards", "questions"]);

function schemaFor(mode: AiMode) {
  if (mode === "flashcards") return {
    type: "object", properties: {
        title: { type: "string" },
        items: { type: "array", items: { type: "object", properties: {
          front: { type: "string" }, back: { type: "string" }, citation: { type: "string" },
        }, required: ["front", "back", "citation"], additionalProperties: false } },
      }, required: ["title", "items"], additionalProperties: false,
  };
  if (mode === "questions") return {
      type: "object", properties: {
        title: { type: "string" },
        items: { type: "array", items: { type: "object", properties: {
          question: { type: "string" }, options: { type: "array", items: { type: "string" } },
          answer: { type: "string" }, explanation: { type: "string" }, citation: { type: "string" },
        }, required: ["question", "options", "answer", "explanation", "citation"], additionalProperties: false } },
      }, required: ["title", "items"], additionalProperties: false,
  };
  return {
      type: "object", properties: {
        title: { type: "string" }, content: { type: "string" },
        citations: { type: "array", items: { type: "string" } },
        followUps: { type: "array", items: { type: "string" } },
      }, required: ["title", "content", "citations", "followUps"], additionalProperties: false,
  };
}

async function sourceContent(pathname: string, mimeType: string, originalName: string): Promise<AiSource> {
  const result = await get(pathname, { access: "private", useCache: true });
  if (!result?.stream) throw new Error("The source file could not be opened");
  const bytes = new Uint8Array(await new Response(result.stream).arrayBuffer());
  if (bytes.byteLength > MAX_AI_SOURCE_BYTES) throw new Error("This AI action supports source files up to 50 MB. The file remains safely stored in your Library.");
  if (mimeType === "text/plain") {
    return { mimeType, name: originalName, text: new TextDecoder().decode(bytes) };
  }
  if (mimeType === "application/pdf") return { bytes, mimeType, name: originalName };
  const fileType = mimeType.includes("wordprocessingml") ? "docx" : "pptx";
  const document = await OfficeParser.parseOffice(bytes, { fileType, ignoreNotes: false });
  return { mimeType: "text/plain", name: originalName, text: document.toText() };
}

export async function POST(request: Request) {
  let userId = "";
  let documentId = "";
  try {
    userId = await currentUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const body = await request.json();
    const mode = String(body?.mode || "tutor") as AiMode;
    documentId = String(body?.documentId || "").trim();
    const prompt = String(body?.prompt || "").trim().slice(0, 4000);
    if (!modes.has(mode) || !documentId || (mode === "tutor" && !prompt)) {
      return NextResponse.json({ error: "Choose a document and enter a valid request" }, { status: 400 });
    }

    await ensureStudySchema();
    const sql = db();
    const usage = await sql`select count(*)::int as count from public.ai_generations where user_id = ${userId} and created_at >= current_date`;
    if (Number(usage[0]?.count || 0) >= DAILY_LIMIT) return NextResponse.json({ error: "Daily AI limit reached. Try again tomorrow." }, { status: 429 });
    const documents = await sql`
      select id, title, original_name, pathname, mime_type, processing_status from public.documents
      where id = ${documentId} and user_id = ${userId} limit 1
    `;
    const document = documents[0];
    if (!document) return NextResponse.json({ error: "Document not found" }, { status: 404 });
    if (document.processing_status !== "ready") return NextResponse.json({ error: "This document is not ready for AI yet" }, { status: 409 });
    await sql`update public.documents set ai_status='generating', ai_error=null, updated_at=now() where id=${documentId} and user_id=${userId}`;
    const source = await sourceContent(String(document.pathname), String(document.mime_type), String(document.original_name));

    const generation = await configuredAiProvider().generate({ mode, prompt, schema: schemaFor(mode), source });
    await sql`
      insert into public.ai_generations (user_id, document_id, mode, provider, model, prompt, response_json, input_tokens, output_tokens)
      values (${userId}, ${documentId}, ${mode}, ${generation.provider}, ${generation.model}, ${prompt}, ${JSON.stringify(generation.result)}::jsonb, ${generation.usage.input_tokens}, ${generation.usage.output_tokens})
    `;
    await sql`update public.documents set ai_status='completed', ai_error=null, updated_at=now() where id=${documentId} and user_id=${userId}`;
    return NextResponse.json({ result: generation.result, usage: generation.usage, remainingToday: DAILY_LIMIT - Number(usage[0]?.count || 0) - 1 });
  } catch (error) {
    console.error("AI generation", error);
    const message = error instanceof Error ? error.message : "AI generation failed";
    if (userId && documentId) {
      try {
        const sql = db();
        await sql`update public.documents set ai_status='error', ai_error=${message}, updated_at=now() where id=${documentId} and user_id=${userId}`;
      } catch (statusError) { console.error("AI status update", statusError); }
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
