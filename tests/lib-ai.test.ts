import assert from "node:assert/strict";
import test from "node:test";
import { configuredAiProvider, parseStructuredOutput, StructuredOutputError } from "../src/lib-ai.ts";

const tutorSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    content: { type: "string" },
    citations: { type: "array", items: { type: "string", enum: ["notes.pdf · page 2"] } },
    followUps: { type: "array", items: { type: "string" } },
  },
  required: ["title", "content", "citations", "followUps"],
  additionalProperties: false,
};

test("accepts multilingual Tutor JSON and exact citations", () => {
  for (const content of ["Gli indici sono…", "شاخص‌ها عبارت‌اند از…", "The indexes are…"]) {
    const result = parseStructuredOutput(JSON.stringify({ title: "Answer", content, citations: ["notes.pdf · page 2"], followUps: [] }), tutorSchema);
    assert.equal(result.content, content);
  }
});

test("recovers JSON wrapped in a markdown fence", () => {
  const result = parseStructuredOutput(`\`\`\`json\n${JSON.stringify({ title: "Answer", content: "Grounded", citations: [], followUps: [] })}\n\`\`\``, tutorSchema);
  assert.equal(result.title, "Answer");
});

test("rejects fabricated citations and missing fields", () => {
  assert.throws(() => parseStructuredOutput(JSON.stringify({ title: "Answer", content: "Grounded", citations: ["notes.pdf · page 99"], followUps: [] }), tutorSchema), StructuredOutputError);
  assert.throws(() => parseStructuredOutput('{"title":"incomplete"}', tutorSchema), StructuredOutputError);
});

test("rejects a multiple-choice answer not present in options", () => {
  const schema = { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { options: { type: "array", items: { type: "string" } }, answer: { type: "string" } }, required: ["options", "answer"], additionalProperties: false } } }, required: ["items"], additionalProperties: false };
  assert.throws(() => parseStructuredOutput(JSON.stringify({ items: [{ options: ["A", "B"], answer: "C" }] }), schema), StructuredOutputError);
});

test("Gemini Tutor falls back once to grounded plain text", async () => {
  process.env.AI_PROVIDER = "gemini";
  process.env.GEMINI_API_KEY = "test-only";
  const originalFetch = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  let call = 0;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    call += 1;
    const text = call === 1 ? '{"title":"truncated"' : "Gli indici sono descritti qui. notes.pdf · page 2";
    return new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await configuredAiProvider().generate({
      mode: "tutor",
      prompt: "quali sono gli index",
      schema: tutorSchema,
      allowedCitations: ["notes.pdf · page 2"],
      source: { mimeType: "text/plain", name: "notes.pdf", text: "[SOURCE: notes.pdf · page 2]\nIndice analitico" },
    });
    assert.equal(result.result.content, "Gli indici sono descritti qui. notes.pdf · page 2");
    assert.deepEqual(result.result.citations, ["notes.pdf · page 2"]);
    assert.deepEqual(result.usage, { input_tokens: 20, output_tokens: 10 });
    assert.equal(bodies.length, 2);
    const config = bodies[0].generationConfig as Record<string, unknown>;
    assert.deepEqual(config, { maxOutputTokens: 4096 });
    assert.equal(config.responseFormat, undefined);
    const prompt = ((bodies[0].contents as Array<{ parts: Array<{ text?: string }> }>)[0].parts[1].text || "");
    assert.match(prompt, /Return only one complete JSON object/);
    assert.match(prompt, /notes\.pdf · page 2/);
    const retryPrompt = ((bodies[1].contents as Array<{ parts: Array<{ text?: string }> }>)[0].parts[1].text || "");
    assert.match(retryPrompt, /plain text, not JSON/);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.GEMINI_API_KEY;
    delete process.env.AI_PROVIDER;
  }
});

test("Gemini Summary plain-text fallback never accepts fabricated citations", async () => {
  process.env.AI_PROVIDER = "gemini";
  process.env.GEMINI_API_KEY = "test-only";
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = (async () => {
    call += 1;
    const text = call === 1 ? "not-json" : "Sintesi leggibile. notes.pdf · page 99";
    return new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await configuredAiProvider().generate({
      mode: "summary",
      prompt: "Detailed depth",
      schema: tutorSchema,
      allowedCitations: ["notes.pdf · page 2"],
      source: { mimeType: "text/plain", name: "notes.pdf", text: "[SOURCE: notes.pdf · page 2]\nIndice analitico" },
    });
    assert.equal(result.result.content, "Sintesi leggibile. notes.pdf · page 99");
    assert.deepEqual(result.result.citations, []);
    assert.equal(call, 2);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.GEMINI_API_KEY;
    delete process.env.AI_PROVIDER;
  }
});

test("Gemini Summary uses the same prompt-only JSON compatibility mode", async () => {
  process.env.AI_PROVIDER = "gemini";
  process.env.GEMINI_API_KEY = "test-only";
  const originalFetch = globalThis.fetch;
  let body: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ title: "Sintesi", content: "Contenuto", citations: ["notes.pdf · page 2"], followUps: [] }) }] } }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 6 },
    }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await configuredAiProvider().generate({
      mode: "summary",
      prompt: "Detailed depth",
      schema: tutorSchema,
      allowedCitations: ["notes.pdf · page 2"],
      source: { mimeType: "text/plain", name: "notes.pdf", text: "[SOURCE: notes.pdf · page 2]\nIndice analitico" },
    });
    assert.equal(result.result.title, "Sintesi");
    assert.deepEqual(body?.generationConfig, { maxOutputTokens: 8192 });
    assert.equal(JSON.stringify(body).includes("responseMimeType"), false);
    assert.equal(JSON.stringify(body).includes("responseJsonSchema"), false);
    assert.equal(JSON.stringify(body).includes("responseFormat"), false);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.GEMINI_API_KEY;
    delete process.env.AI_PROVIDER;
  }
});
