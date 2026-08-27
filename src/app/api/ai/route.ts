import { NextResponse } from "next/server";
import { configuredAiProvider, type AiMode, type AiGenerationResult } from "@/lib-ai";
import { citationLabel, type StoredChunk } from "@/lib-document-processing";
import { db, ensureStudySchema } from "@/lib-db";
import { currentUserId } from "@/lib-user";

export const runtime = "nodejs";
export const maxDuration = 300;

const DAILY_LIMIT = 40;
const CONTEXT_CHUNKS = 16;
const MAP_GROUP_CHARACTERS = 90_000;
const modes = new Set(["tutor", "summary", "flashcards", "questions"]);

function schemaFor(mode: AiMode) {
  if (mode === "flashcards") return { type: "object", properties: { title: { type: "string", description: "Short deck title in the learner's language" }, items: { type: "array", minItems: 10, maxItems: 10, items: { type: "object", properties: { front: { type: "string" }, back: { type: "string" }, citation: { type: "string", description: "One exact SOURCE label supplied in the context" } }, required: ["front", "back", "citation"], additionalProperties: false } } }, required: ["title", "items"], additionalProperties: false };
  if (mode === "questions") return { type: "object", properties: { title: { type: "string" }, items: { type: "array", minItems: 8, maxItems: 8, items: { type: "object", properties: { question: { type: "string" }, options: { type: "array", minItems: 4, maxItems: 4, items: { type: "string" } }, answer: { type: "string", description: "Must exactly equal one of the four options" }, explanation: { type: "string" }, citation: { type: "string", description: "One exact SOURCE label supplied in the context" } }, required: ["question", "options", "answer", "explanation", "citation"], additionalProperties: false } } }, required: ["title", "items"], additionalProperties: false };
  return { type: "object", properties: { title: { type: "string" }, content: { type: "string", description: "Grounded answer or summary in the learner's language" }, citations: { type: "array", description: "Exact SOURCE labels supporting the answer; empty only when the source does not answer the request", items: { type: "string" } }, followUps: { type: "array", items: { type: "string" } } }, required: ["title", "content", "citations", "followUps"], additionalProperties: false };
}

function citationLabels(name: string, chunks: StoredChunk[]) {
  return [...new Set(chunks.map((chunk) => citationLabel(name, chunk)))];
}

function chunkContext(name: string, chunks: StoredChunk[]) {
  return chunks.map((chunk) => `[SOURCE: ${citationLabel(name, chunk)}]\n${chunk.content}`).join("\n\n---\n\n");
}

function addUsage(target: AiGenerationResult["usage"], source: AiGenerationResult["usage"]) {
  target.input_tokens += source.input_tokens;
  target.output_tokens += source.output_tokens;
}

function groupChunks(name: string, chunks: StoredChunk[]) {
  const groups: string[] = [];
  let current = "";
  for (const chunk of chunks) {
    const next = `[SOURCE: ${citationLabel(name, chunk)}]\n${chunk.content}`;
    if (current && current.length + next.length > MAP_GROUP_CHARACTERS) { groups.push(current); current = ""; }
    current += `${current ? "\n\n---\n\n" : ""}${next}`;
  }
  if (current) groups.push(current);
  return groups;
}

async function hierarchicalSummary(name: string, chunks: StoredChunk[], prompt: string) {
  const provider = configuredAiProvider();
  const usage = { input_tokens: 0, output_tokens: 0 };
  let level = groupChunks(name, chunks);
  let round = 0;
  while (level.length > 1) {
    const next: string[] = [];
    for (let offset = 0; offset < level.length; offset += 3) {
      const result = await provider.generate({ mode: "summary", prompt: `Map step ${round + 1}: summarize every supplied part without dropping major concepts. Preserve all source labels exactly. ${prompt}`, schema: schemaFor("summary"), allowedCitations: citationLabels(name, chunks), source: { mimeType: "text/plain", name, text: level.slice(offset, offset + 3).join("\n\n=== PART ===\n\n") } });
      addUsage(usage, result.usage);
      const value = result.result as { title?: string; content?: string; citations?: string[] };
      next.push(`${value.title || "Partial summary"}\n${value.content || ""}\nSources: ${(value.citations || []).join("; ")}`);
    }
    level = next;
    round += 1;
  }
  const final = await provider.generate({ mode: "summary", prompt: `Reduce step: synthesize one complete, structured entire-document summary. Preserve real citations from the supplied mapped summary. ${prompt}`, schema: schemaFor("summary"), allowedCitations: citationLabels(name, chunks), source: { mimeType: "text/plain", name, text: level[0] } });
  addUsage(usage, final.usage);
  return { ...final, usage };
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
    if (!modes.has(mode) || !documentId || (mode === "tutor" && !prompt)) return NextResponse.json({ error: "Choose a document and enter a valid request" }, { status: 400 });

    await ensureStudySchema();
    const sql = db();
    const usageRows = await sql`select count(*)::int as count from public.ai_generations where user_id=${userId} and created_at >= current_date`;
    const usedToday = Number(usageRows[0]?.count || 0);
    if (usedToday >= DAILY_LIMIT) return NextResponse.json({ error: "Daily AI limit reached. Try again tomorrow." }, { status: 429 });
    const documents = await sql`select id, title, original_name, processing_status from public.documents where id=${documentId} and user_id=${userId} limit 1`;
    const document = documents[0];
    if (!document) return NextResponse.json({ error: "Document not found" }, { status: 404 });
    if (document.processing_status !== "ready") return NextResponse.json({ error: "This document is still processing and is not ready for AI yet" }, { status: 409 });
    await sql`update public.documents set ai_status='generating', ai_error=null, updated_at=now() where id=${documentId} and user_id=${userId}`;

    let chunkRows = mode === "summary"
      ? await sql`select chunk_index, content, page_start, page_end, section from public.document_chunks where document_id=${documentId} and user_id=${userId} order by chunk_index`
      : prompt
        ? await sql`select chunk_index, content, page_start, page_end, section from public.document_chunks where document_id=${documentId} and user_id=${userId} order by ts_rank_cd(to_tsvector('simple', content), plainto_tsquery('simple', ${prompt})) desc, chunk_index limit ${CONTEXT_CHUNKS}`
        : await sql`select chunk_index, content, page_start, page_end, section from public.document_chunks where document_id=${documentId} and user_id=${userId} order by chunk_index limit ${CONTEXT_CHUNKS}`;
    if (!chunkRows.length) {
      const { processDocument } = await import("@/lib-document-processing");
      await sql`update public.documents set processing_status='processing', processing_error=null, updated_at=now() where id=${documentId} and user_id=${userId}`;
      await processDocument(documentId, userId);
      chunkRows = mode === "summary"
        ? await sql`select chunk_index, content, page_start, page_end, section from public.document_chunks where document_id=${documentId} and user_id=${userId} order by chunk_index`
        : await sql`select chunk_index, content, page_start, page_end, section from public.document_chunks where document_id=${documentId} and user_id=${userId} order by chunk_index limit ${CONTEXT_CHUNKS}`;
    }
    const chunks = chunkRows as unknown as StoredChunk[];
    if (!chunks.length) throw new Error("The document contains no readable text.");
    const name = String(document.original_name);
    const generation = mode === "summary"
      ? await hierarchicalSummary(name, chunks, prompt)
      : await configuredAiProvider().generate({ mode, prompt, schema: schemaFor(mode), allowedCitations: citationLabels(name, chunks), source: { mimeType: "text/plain", name, text: chunkContext(name, chunks) } });
    await sql`insert into public.ai_generations (user_id, document_id, mode, provider, model, prompt, response_json, input_tokens, output_tokens) values (${userId}, ${documentId}, ${mode}, ${generation.provider}, ${generation.model}, ${prompt}, ${JSON.stringify(generation.result)}::jsonb, ${generation.usage.input_tokens}, ${generation.usage.output_tokens})`;
    await sql`update public.documents set ai_status='completed', ai_error=null, updated_at=now() where id=${documentId} and user_id=${userId}`;
    return NextResponse.json({ result: generation.result, usage: generation.usage, remainingToday: DAILY_LIMIT - usedToday - 1 });
  } catch (error) {
    console.error("AI generation", error);
    const message = error instanceof Error ? error.message : "AI generation failed";
    if (userId && documentId) {
      try { const sql = db(); await sql`update public.documents set ai_status='error', ai_error=${message}, updated_at=now() where id=${documentId} and user_id=${userId}`; }
      catch (statusError) { console.error("AI status update", statusError); }
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
