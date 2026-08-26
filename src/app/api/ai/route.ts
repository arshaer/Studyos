import { get } from "@vercel/blob";
import { NextResponse } from "next/server";
import { db, ensureStudySchema } from "@/lib-db";

export const runtime = "nodejs";
export const maxDuration = 60;

const MODEL = process.env.OPENAI_MODEL?.trim() || "gpt-5.6-luna";
const DAILY_LIMIT = 40;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const modes = new Set(["tutor", "summary", "flashcards", "questions"]);

type Mode = "tutor" | "summary" | "flashcards" | "questions";

function userIdFrom(request: Request) {
  return request.headers.get("x-studyos-user-id")?.trim() || "";
}

function schemaFor(mode: Mode) {
  if (mode === "flashcards") return {
    name: "studyos_flashcards", strict: true,
    schema: {
      type: "object", properties: {
        title: { type: "string" },
        items: { type: "array", items: { type: "object", properties: {
          front: { type: "string" }, back: { type: "string" }, citation: { type: "string" },
        }, required: ["front", "back", "citation"], additionalProperties: false } },
      }, required: ["title", "items"], additionalProperties: false,
    },
  };
  if (mode === "questions") return {
    name: "studyos_questions", strict: true,
    schema: {
      type: "object", properties: {
        title: { type: "string" },
        items: { type: "array", items: { type: "object", properties: {
          question: { type: "string" }, options: { type: "array", items: { type: "string" } },
          answer: { type: "string" }, explanation: { type: "string" }, citation: { type: "string" },
        }, required: ["question", "options", "answer", "explanation", "citation"], additionalProperties: false } },
      }, required: ["title", "items"], additionalProperties: false,
    },
  };
  return {
    name: `studyos_${mode}`, strict: true,
    schema: {
      type: "object", properties: {
        title: { type: "string" }, content: { type: "string" },
        citations: { type: "array", items: { type: "string" } },
        followUps: { type: "array", items: { type: "string" } },
      }, required: ["title", "content", "citations", "followUps"], additionalProperties: false,
    },
  };
}

function taskFor(mode: Mode, prompt: string) {
  if (mode === "summary") return `Create a structured, exam-focused summary. ${prompt || "Cover the entire document."}`;
  if (mode === "flashcards") return `Create 10 high-quality active-recall flashcards. ${prompt}`;
  if (mode === "questions") return `Create 8 multiple-choice questions with exactly four options each. ${prompt}`;
  return `Answer this learner's question and teach the concept step by step: ${prompt}`;
}

async function sourceContent(pathname: string, mimeType: string, originalName: string) {
  const result = await get(pathname, { access: "private", useCache: true });
  if (!result?.stream) throw new Error("The source file could not be opened");
  const bytes = new Uint8Array(await new Response(result.stream).arrayBuffer());
  if (bytes.byteLength > MAX_SOURCE_BYTES) throw new Error("AI processing currently supports files up to 20 MB");
  if (mimeType === "text/plain") return {
    type: "input_text", text: `SOURCE FILE: ${originalName}\n\n${new TextDecoder().decode(bytes)}`,
  };
  return {
    type: "input_file", filename: originalName,
    file_data: `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`, detail: "auto",
  };
}

function outputText(payload: Record<string, unknown>) {
  if (typeof payload.output_text === "string") return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const candidate = (item as { content?: unknown }).content;
    const content = Array.isArray(candidate) ? candidate : [];
    for (const part of content) {
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
    }
  }
  throw new Error("The AI response did not contain usable output");
}

export async function POST(request: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) return NextResponse.json({ error: "AI is not configured yet. Add OPENAI_API_KEY in Vercel." }, { status: 503 });
    const userId = userIdFrom(request);
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const body = await request.json();
    const mode = String(body?.mode || "tutor") as Mode;
    const documentId = String(body?.documentId || "").trim();
    const prompt = String(body?.prompt || "").trim().slice(0, 4000);
    if (!modes.has(mode) || !documentId || (mode === "tutor" && !prompt)) {
      return NextResponse.json({ error: "Choose a document and enter a valid request" }, { status: 400 });
    }

    await ensureStudySchema();
    const sql = db();
    const usage = await sql`select count(*)::int as count from public.ai_generations where user_id = ${userId} and created_at >= current_date`;
    if (Number(usage[0]?.count || 0) >= DAILY_LIMIT) return NextResponse.json({ error: "Daily AI limit reached. Try again tomorrow." }, { status: 429 });
    const documents = await sql`
      select id, title, original_name, pathname, mime_type from public.documents
      where id = ${documentId} and user_id = ${userId} limit 1
    `;
    const document = documents[0];
    if (!document) return NextResponse.json({ error: "Document not found" }, { status: 404 });
    const source = await sourceContent(String(document.pathname), String(document.mime_type), String(document.original_name));

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL, store: false, max_output_tokens: mode === "summary" ? 2200 : 1400,
        instructions: "You are StudyOS, a rigorous source-grounded tutor. Use only the supplied document. Never invent facts. Cite page, slide, or section when available. Reply in the learner's requested language, defaulting to Italian. If the source does not answer the request, say so clearly.",
        input: [{ role: "user", content: [source, { type: "input_text", text: taskFor(mode, prompt) }] }],
        text: { format: { type: "json_schema", ...schemaFor(mode) } },
      }),
      signal: AbortSignal.timeout(55_000),
    });
    const payload = await response.json() as Record<string, unknown>;
    if (!response.ok) {
      const detail = payload.error && typeof payload.error === "object" ? String((payload.error as { message?: unknown }).message || "") : "";
      throw new Error(detail || "AI generation failed");
    }
    const result = JSON.parse(outputText(payload)) as Record<string, unknown>;
    const tokenUsage = (payload.usage || {}) as { input_tokens?: number; output_tokens?: number };
    await sql`
      insert into public.ai_generations (user_id, document_id, mode, model, prompt, response_json, input_tokens, output_tokens)
      values (${userId}, ${documentId}, ${mode}, ${MODEL}, ${prompt}, ${JSON.stringify(result)}::jsonb, ${tokenUsage.input_tokens || 0}, ${tokenUsage.output_tokens || 0})
    `;
    return NextResponse.json({ result, usage: tokenUsage, remainingToday: DAILY_LIMIT - Number(usage[0]?.count || 0) - 1 });
  } catch (error) {
    console.error("AI generation", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "AI generation failed" }, { status: 500 });
  }
}
