import assert from "node:assert/strict";
import test from "node:test";
import { AiProviderError, compressionPolicyFor, configuredAiProvider, createAIGateway, parseStructuredOutput, publicAiError, resetProviderHealthForTests, retryDelayMs, streamAI, StructuredOutputError, type AiProvider } from "../src/lib-ai.ts";

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

test("parses Google RetryInfo and Retry-After delays", () => {
  assert.equal(retryDelayMs({ error: { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "23.8s" }] } }), 23_800);
  assert.equal(retryDelayMs({}, "12"), 12_000);
});

test("retries one Gemini 429 and succeeds without exposing quota details", async () => {
  process.env.AI_PROVIDER = "gemini"; process.env.GEMINI_API_KEY = "test-only"; process.env.AI_MAX_RETRIES = "1";
  const originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = (async () => { calls += 1; return calls === 1
    ? new Response(JSON.stringify({ error: { code: 429, message: "Quota exceeded for generate_content_free_tier_requests", details: [{ retryDelay: "0s" }] } }), { status: 429 })
    : new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ title: "Answer", content: "Safe", citations: [], followUps: [] }) }] } }] }), { status: 200 }); }) as typeof fetch;
  try { const result = await configuredAiProvider().generate({ mode: "tutor", prompt: "help", schema: tutorSchema, source: { mimeType: "text/plain", name: "notes.pdf", text: "source" } }); assert.equal(result.result.content, "Safe"); assert.equal(calls, 2); }
  finally { globalThis.fetch = originalFetch; delete process.env.GEMINI_API_KEY; delete process.env.AI_PROVIDER; delete process.env.AI_MAX_RETRIES; }
});

test("falls back to configured OpenAI after bounded Gemini rate limit", async () => {
  process.env.AI_PROVIDER = "gemini"; process.env.GEMINI_API_KEY = "test-only"; process.env.OPENAI_API_KEY = "test-only"; process.env.AI_MAX_RETRIES = "0";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => String(input).includes("googleapis")
    ? new Response(JSON.stringify({ error: { code: 429, message: "quota exhausted" } }), { status: 429 })
    : new Response(JSON.stringify({ output_text: JSON.stringify({ title: "Fallback", content: "Available", citations: [], followUps: [] }), usage: { input_tokens: 7, output_tokens: 3 } }), { status: 200 })) as typeof fetch;
  try { const result = await configuredAiProvider().generate({ mode: "tutor", prompt: "help", schema: tutorSchema, source: { mimeType: "text/plain", name: "notes.pdf", text: "source" } }); assert.equal(result.provider, "openai"); assert.equal(result.result.title, "Fallback"); assert.deepEqual(result.usage, { input_tokens: 7, output_tokens: 3 }); }
  finally { globalThis.fetch = originalFetch; delete process.env.GEMINI_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.AI_PROVIDER; delete process.env.AI_MAX_RETRIES; }
});

test("sanitizes provider quota errors for the Professor UI", () => {
  const safe = publicAiError(new AiProviderError("rate_limit", "Quota exceeded: generate_content_free_tier_requests https://ai.google.dev", { provider: "gemini", retryAfterMs: 23_800 }), "en");
  assert.equal(safe.retryAfterSeconds, 24); assert.match(safe.message, /temporarily busy/); assert.doesNotMatch(safe.message, /quota|google|generate_content|https/i);
});

const gatewayRequest = { task: "tutor" as const, mode: "tutor" as const, prompt: "Explain", schema: tutorSchema, protectedContext: true, source: { mimeType: "text/plain", name: "notes.pdf", text: "Na+ concentration is 140 mmol/L" } };
const success = (provider: "omniroute" | "gemini" | "openai", title = provider) => ({ provider, model: `${provider}-model`, result: { title, content: "Grounded", citations: [], followUps: [] }, usage: { input_tokens: 10, output_tokens: 4 } });
const mockProvider = (name: AiProvider["name"], generate: AiProvider["generate"]): AiProvider => ({ name, model: `${name}-model`, generate });

test("gateway returns a successful primary route", async () => {
  resetProviderHealthForTests();
  const result = await createAIGateway({ providers: [mockProvider("omniroute", async () => success("omniroute"))] })(gatewayRequest);
  assert.equal(result.provider, "omniroute"); assert.equal(result.fallbackCount, 0); assert.equal(result.gateway, "studyos");
});

test("gateway falls back after rate limit", async () => {
  resetProviderHealthForTests();
  const primary = mockProvider("omniroute", async () => { throw new AiProviderError("rate_limit", "busy", { provider: "omniroute", retryAfterMs: 0 }); });
  const result = await createAIGateway({ providers: [primary, mockProvider("gemini", async () => success("gemini"))] })({ ...gatewayRequest });
  assert.equal(result.provider, "gemini"); assert.equal(result.fallbackCount, 1);
});

test("gateway falls back after timeout and when OmniRoute is unavailable", async () => {
  for (const kind of ["timeout", "unavailable"] as const) {
    resetProviderHealthForTests();
    const primary = mockProvider("omniroute", async () => { throw new AiProviderError(kind, kind, { provider: "omniroute" }); });
    const result = await createAIGateway({ providers: [primary, mockProvider("openai", async () => success("openai"))] })({ ...gatewayRequest });
    assert.equal(result.provider, "openai");
  }
});

test("gateway treats a fetch transport failure as unavailable and falls back", async () => {
  resetProviderHealthForTests();
  let attempts = 0;
  const primary = mockProvider("omniroute", async () => { attempts += 1; throw new TypeError("fetch failed"); });
  const result = await createAIGateway({ providers: [primary, mockProvider("gemini", async () => success("gemini"))] })({ ...gatewayRequest });
  assert.equal(result.provider, "gemini");
  assert.equal(result.fallbackCount, 1);
  assert.equal(attempts, 2);
});

test("gateway reports all providers unavailable", async () => {
  resetProviderHealthForTests();
  const down = (name: AiProvider["name"]) => mockProvider(name, async () => { throw new AiProviderError("unavailable", "down", { provider: name }); });
  await assert.rejects(createAIGateway({ providers: [down("omniroute"), down("gemini")] })({ ...gatewayRequest }), (error: unknown) => error instanceof AiProviderError && error.kind === "unavailable");
});

test("invalid structured output is bounded then falls back", async () => {
  resetProviderHealthForTests(); let attempts = 0;
  const invalid = mockProvider("omniroute", async () => { attempts += 1; throw new StructuredOutputError("invalid JSON"); });
  const result = await createAIGateway({ providers: [invalid, mockProvider("gemini", async () => success("gemini"))] })({ ...gatewayRequest });
  assert.equal(result.provider, "gemini"); assert.equal(attempts, 2);
});

test("compression policy protects scientific source context", () => {
  assert.equal(compressionPolicyFor(gatewayRequest), "off");
  assert.equal(compressionPolicyFor({ ...gatewayRequest, protectedContext: false }), "lite");
  assert.equal(compressionPolicyFor({ ...gatewayRequest, task: "simple_generation", protectedContext: false }), "standard");
  assert.equal(gatewayRequest.source.text, "Na+ concentration is 140 mmol/L");
});

test("telemetry persists without prompt content and failures do not break generation", async () => {
  resetProviderHealthForTests(); const rows: unknown[] = [];
  const result = await createAIGateway({ providers: [mockProvider("gemini", async () => success("gemini"))], persistTelemetry: async row => { rows.push(row); } })({ ...gatewayRequest, userId: "user-1", documentId: "doc-1" });
  assert.equal(result.provider, "gemini"); assert.equal(rows.length, 1); assert.equal("prompt" in (rows[0] as object), false);
  const stillWorks = await createAIGateway({ providers: [mockProvider("openai", async () => success("openai"))], persistTelemetry: async () => { throw new Error("db down"); } })({ ...gatewayRequest });
  assert.equal(stillWorks.provider, "openai");
});

test("streaming emits one validated provider response and never mixes fallbacks", async () => {
  resetProviderHealthForTests();
  const streamed = await streamAI(gatewayRequest, { providers: [mockProvider("gemini", async () => success("gemini", "Validated"))] });
  const text = await new Response(streamed.stream).text();
  assert.equal(JSON.parse(text).title, "Validated");
});

test("missing optional OmniRoute configuration does not block a direct provider", async () => {
  resetProviderHealthForTests();
  const result = await createAIGateway({ providers: [mockProvider("gemini", async () => success("gemini"))] })(gatewayRequest);
  assert.equal(result.provider, "gemini");
  await assert.rejects(createAIGateway({ providers: [] })(gatewayRequest), /No AI provider is configured/);
});
