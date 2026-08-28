export type AiMode = "tutor" | "summary" | "flashcards" | "questions";
export type AITask = "document_indexing" | "structure_detection" | "summary" | "flashcards" | "quiz" | "study_plan" | "tutor" | "professor" | "error_correction" | "simple_generation";
export type AIQuality = "fast" | "balanced" | "high";
export type CompressionPolicy = "off" | "lite" | "standard";

export type AiSource = {
  bytes?: Uint8Array;
  mimeType: string;
  name: string;
  text?: string;
};

export type AiGenerationRequest = {
  allowedCitations?: string[];
  mode: AiMode;
  prompt: string;
  schema: Record<string, unknown>;
  source: AiSource;
};

export type AiGenerationResult = {
  provider: "omniroute" | "gemini" | "openai";
  model: string;
  result: Record<string, unknown>;
  usage: { input_tokens: number; output_tokens: number };
  gateway?: "studyos";
  fallbackCount?: number;
  compression?: { policy: CompressionPolicy; ratio?: number };
};

export type AiProvider = {
  name: AiGenerationResult["provider"];
  model: string;
  generate(request: AiGenerationRequest): Promise<AiGenerationResult>;
};

export type AiErrorKind = "rate_limit" | "unavailable" | "timeout" | "auth" | "structured_output" | "unknown";

export class AiProviderError extends Error {
  readonly kind: AiErrorKind;
  readonly options: { provider: AiGenerationResult["provider"]; status?: number; retryAfterMs?: number; cause?: unknown };
  constructor(kind: AiErrorKind, message: string, options: { provider: AiGenerationResult["provider"]; status?: number; retryAfterMs?: number; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "AiProviderError";
    this.kind = kind;
    this.options = options;
  }
}

export type AITelemetry = {
  userId?: string; documentId?: string; task: AITask; gateway: "studyos";
  provider: string; model: string; inputTokens: number; outputTokens: number;
  estimatedCost: number | null; costStatus: "known" | "free" | "unknown";
  latencyMs: number; fallbackCount: number; compressionEnabled: boolean;
  compressionPolicy: CompressionPolicy; compressionRatio: number | null;
  success: boolean; errorType: AiErrorKind | null;
};

export type GenerateAIRequest = AiGenerationRequest & {
  task: AITask; userId?: string; documentId?: string; quality?: AIQuality;
  protectedContext?: boolean; requirements?: { streaming?: boolean };
};

type GatewayOptions = { providers?: AiProvider[]; persistTelemetry?: (row: AITelemetry) => Promise<void>; now?: () => number };

async function persistDefaultTelemetry(row: AITelemetry) {
  if (!row.userId) return;
  const { db } = await import("./lib-db");
  const sql = db();
  await sql`insert into public.ai_requests(user_id,document_id,task_type,gateway,provider,model,input_tokens,output_tokens,estimated_cost,cost_status,latency_ms,fallback_count,compression_enabled,compression_policy,compression_ratio,success,error_type)
    values(${row.userId},${row.documentId || null},${row.task},${row.gateway},${row.provider},${row.model},${row.inputTokens},${row.outputTokens},${row.estimatedCost},${row.costStatus},${row.latencyMs},${row.fallbackCount},${row.compressionEnabled},${row.compressionPolicy},${row.compressionRatio},${row.success},${row.errorType})`;
}

const QUALITY_BY_TASK: Record<AITask, AIQuality> = {
  document_indexing: "fast", structure_detection: "balanced", summary: "balanced",
  flashcards: "balanced", quiz: "balanced", study_plan: "high", tutor: "high",
  professor: "high", error_correction: "high", simple_generation: "fast",
};

export function compressionPolicyFor(request: Pick<GenerateAIRequest, "task" | "protectedContext" | "source">): CompressionPolicy {
  if (request.protectedContext !== false || request.source.mimeType === "application/pdf") return "off";
  if (request.task === "tutor" || request.task === "professor") return "lite";
  return "standard";
}

export function retryDelayMs(payload: Record<string, unknown>, retryAfter?: string | null) {
  const headerSeconds = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter.trim()) ? Number(retryAfter) * 1000 : NaN;
  if (Number.isFinite(headerSeconds)) return Math.max(0, headerSeconds);
  if (retryAfter) { const dateMs = Date.parse(retryAfter); if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now()); }
  const error = payload.error && typeof payload.error === "object" ? payload.error as { details?: unknown } : undefined;
  for (const detail of Array.isArray(error?.details) ? error.details : []) {
    if (!detail || typeof detail !== "object") continue;
    const match = String((detail as { retryDelay?: unknown }).retryDelay || "").trim().match(/^(\d+(?:\.\d+)?)s$/);
    if (match) return Math.max(0, Number(match[1]) * 1000);
  }
  return undefined;
}

function providerError(provider: AiGenerationResult["provider"], response: Response, payload: Record<string, unknown>) {
  const status = response.status, message = errorDetail(payload) || `${provider} generation failed`, lower = message.toLowerCase();
  const kind: AiErrorKind = status === 429 || lower.includes("quota") || lower.includes("rate limit") ? "rate_limit"
    : status === 401 || status === 403 || lower.includes("api key") || lower.includes("permission") ? "auth"
      : status === 404 || status === 503 || lower.includes("model") && lower.includes("unavailable") ? "unavailable" : "unknown";
  return new AiProviderError(kind, message, { provider, status, retryAfterMs: retryDelayMs(payload, response.headers.get("retry-after")) });
}

function normalizeProviderError(provider: AiGenerationResult["provider"], error: unknown) {
  if (error instanceof AiProviderError) return error;
  if (error instanceof StructuredOutputError) return new AiProviderError("structured_output", error.message, { provider, cause: error });
  if (error instanceof DOMException && error.name === "TimeoutError") return new AiProviderError("timeout", `${provider} timed out`, { provider, cause: error });
  // Node's fetch rejects transport failures (DNS, refused connections, TLS, socket
  // resets) with TypeError. These are route-availability failures and must advance
  // the gateway to the next configured provider instead of terminating as unknown.
  if (error instanceof TypeError) return new AiProviderError("unavailable", `${provider} is unavailable`, { provider, cause: error });
  return new AiProviderError("unknown", error instanceof Error ? error.message : `${provider} generation failed`, { provider, cause: error });
}

const transientKinds = new Set<AiErrorKind>(["rate_limit", "unavailable", "timeout", "structured_output"]);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const SYSTEM_INSTRUCTION =
  "You are StudyOS, a rigorous source-grounded tutor. Use only the supplied user document and never invent facts. Every factual answer, summary item, flashcard, and question must cite the actual source filename plus the most precise available page, slide, heading, or section. Never fabricate page numbers or use placeholder citations. If an exact location is unavailable, cite the filename and nearest real heading/section. Reply in the learner's requested language, supporting English, Italian, and Persian, and defaulting to Italian. If the source does not answer the request, say so clearly.";

function taskFor(mode: AiMode, prompt: string) {
  if (mode === "summary") return `Create polished, exam-focused study notes in the learner's language. Organize the material into a clear hierarchy of meaningful headings, short paragraphs, bullet lists, definitions, mechanisms, comparisons, and high-yield exam points. Remove repetition and do not merely transcribe the source. Use normal Markdown headings, lists, and bold emphasis only where they improve scanning; never expose code fences, HTML, JSON, escaped control characters, or decorative symbols. Put each exact SOURCE label after the statement or compact group of statements it supports. ${prompt || "Cover the entire document."}`;
  if (mode === "flashcards") return `Create 10 high-quality active-recall flashcards. ${prompt}`;
  if (mode === "questions") return `Create 8 multiple-choice questions with exactly four options each. ${prompt}`;
  return `Answer this learner's question in the language of the newest question. Produce a polished teaching response with a concise title, clear explanation, useful definitions, ordered steps when relevant, key points, examples, exam callouts, comparison tables when useful, exact citations, and short follow-up actions. Never emit raw markdown markers inside fields: ${prompt}`;
}

function strictJsonInstruction(schema: Record<string, unknown>, citations: string[]) {
  const citationRule = citations.length
    ? `Every citation must exactly match one of these allowed SOURCE labels: ${JSON.stringify(citations)}.`
    : "Use an empty citation list when the supplied source does not contain a verifiable location.";
  return [
    "Return only one complete JSON object, without markdown fences or commentary.",
    `The JSON must conform exactly to this schema: ${JSON.stringify(schema)}.`,
    citationRule,
    "Do not invent, repair, approximate, or translate SOURCE labels.",
  ].join("\n");
}

function plainTextInstruction(citations: string[]) {
  return [
    "Return a complete, readable response as plain text, not JSON and not a markdown code fence.",
    citations.length
      ? `Cite supporting locations by writing these exact SOURCE labels verbatim: ${JSON.stringify(citations)}.`
      : "State clearly when the source does not contain a verifiable answer.",
    "Never invent, approximate, translate, or alter a SOURCE label.",
  ].join("\n");
}

function textResult(mode: "tutor" | "summary", text: string, citations: string[],schema?:Record<string,unknown>) {
  const content = text.trim().replace(/^```(?:text|markdown)?\s*/i, "").replace(/\s*```$/, "");
  if (!content) throw new StructuredOutputError("Gemini returned an empty plain-text fallback");
  if(mode==="tutor"&&"explanation" in ((schema?.properties||{}) as Record<string,unknown>))return{title:"Answer",explanation:content,definitions:[],steps:[],keyPoints:[],examples:[],examCallouts:[],tables:[],citations:citations.filter(citation=>content.includes(citation)),followUps:[]};
  return {
    title: mode === "summary" ? "Summary" : "Answer",
    content,
    citations: citations.filter((citation) => content.includes(citation)),
    followUps: [],
  };
}

export class StructuredOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StructuredOutputError";
  }
}

function jsonCandidate(text: string) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

function validateSchema(value: unknown, schema: Record<string, unknown>, path = "result"): string[] {
  const issues: string[] = [];
  const type = schema.type;
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [`${path} must be an object`];
    const record = value as Record<string, unknown>;
    const properties = (schema.properties || {}) as Record<string, Record<string, unknown>>;
    for (const key of (schema.required || []) as string[]) if (!(key in record)) issues.push(`${path}.${key} is required`);
    if (schema.additionalProperties === false) for (const key of Object.keys(record)) if (!(key in properties)) issues.push(`${path}.${key} is not allowed`);
    for (const [key, childSchema] of Object.entries(properties)) if (key in record) issues.push(...validateSchema(record[key], childSchema, `${path}.${key}`));
  } else if (type === "array") {
    if (!Array.isArray(value)) return [`${path} must be an array`];
    if (typeof schema.minItems === "number" && value.length < schema.minItems) issues.push(`${path} needs at least ${schema.minItems} items`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) issues.push(`${path} allows at most ${schema.maxItems} items`);
    const itemSchema = schema.items as Record<string, unknown> | undefined;
    if (itemSchema) value.forEach((item, index) => issues.push(...validateSchema(item, itemSchema, `${path}[${index}]`)));
  } else if (type === "string") {
    if (typeof value !== "string" || !value.trim()) issues.push(`${path} must be a non-empty string`);
    else if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) issues.push(`${path} is not an allowed value`);
  } else if (type === "number" || type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || (type === "integer" && !Number.isInteger(value))) issues.push(`${path} must be a ${type}`);
    else if (typeof schema.minimum === "number" && value < schema.minimum) issues.push(`${path} must be at least ${schema.minimum}`);
    else if (typeof schema.maximum === "number" && value > schema.maximum) issues.push(`${path} must be at most ${schema.maximum}`);
  } else if (type === "boolean" && typeof value !== "boolean") {
    issues.push(`${path} must be a boolean`);
  }
  return issues;
}

export function parseStructuredOutput(text: string, schema: Record<string, unknown>) {
  let parsed: unknown;
  try { parsed = JSON.parse(jsonCandidate(text)); }
  catch { throw new StructuredOutputError("Gemini returned malformed JSON"); }
  const issues = validateSchema(parsed, schema);
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown }).items)) {
    for (const [index, item] of ((parsed as { items: unknown[] }).items).entries()) {
      if (item && typeof item === "object") {
        const question = item as { answer?: unknown; options?: unknown };
        if (typeof question.answer === "string" && Array.isArray(question.options) && !question.options.includes(question.answer)) {
          issues.push(`result.items[${index}].answer must exactly match an option`);
        }
      }
    }
  }
  if (issues.length) throw new StructuredOutputError(`Gemini JSON failed validation: ${issues.slice(0, 4).join("; ")}`);
  return parsed as Record<string, unknown>;
}

function citationConstrainedSchema(schema: Record<string, unknown>, citations: string[]) {
  if (!citations.length) return schema;
  const copy = structuredClone(schema);
  const visit = (node: Record<string, unknown>, key?: string) => {
    if (key === "citation" && node.type === "string") node.enum = citations;
    if (key === "citations" && node.type === "array" && node.items && typeof node.items === "object") {
      (node.items as Record<string, unknown>).enum = citations;
    }
    const properties = node.properties as Record<string, Record<string, unknown>> | undefined;
    if (properties) for (const [childKey, child] of Object.entries(properties)) visit(child, childKey);
    if (node.items && typeof node.items === "object") visit(node.items as Record<string, unknown>);
  };
  visit(copy);
  return copy;
}

function errorDetail(payload: Record<string, unknown>) {
  const error = payload.error;
  return error && typeof error === "object"
    ? String((error as { message?: unknown }).message || "")
    : "";
}

class GeminiProvider implements AiProvider {
  readonly name = "gemini" as const;
  readonly model = process.env.GEMINI_MODEL?.trim() || "gemini-3.6-flash";

  async generate(request: AiGenerationRequest): Promise<AiGenerationResult> {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) throw new AiProviderError("auth", "Gemini API key is not configured", { provider: this.name });

    const sourcePart = request.source.text !== undefined
      ? { text: `SOURCE FILE: ${request.source.name}\n\n${request.source.text}` }
      : {
          inlineData: {
            mimeType: request.source.mimeType,
            data: Buffer.from(request.source.bytes || []).toString("base64"),
          },
        };
    const effectiveSchema = citationConstrainedSchema(request.schema, request.allowedCitations || []);
    const call = async (repair?: string, plainText = false) => {
      const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
          contents: [{ role: "user", parts: [sourcePart, { text: `${taskFor(request.mode, request.prompt)}\n\n${plainText ? plainTextInstruction(request.allowedCitations || []) : strictJsonInstruction(effectiveSchema, request.allowedCitations || [])}${repair ? `\n\nRETRY: ${repair}` : ""}` }] }],
          generationConfig: {
            maxOutputTokens: request.mode === "summary" ? 8192 : 4096,
          },
        }),
        signal: AbortSignal.timeout(55_000),
      },
    );
      const payload = await response.json() as Record<string, unknown>;
      if (!response.ok) throw providerError(this.name, response, payload);

      const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
      const candidate = candidates[0] && typeof candidates[0] === "object"
        ? candidates[0] as { content?: { parts?: Array<{ text?: string }> }; finishReason?: string }
        : undefined;
      const text = candidate?.content?.parts?.filter((part) => typeof part.text === "string").map((part) => part.text).join("") || "";
      const usage = (payload.usageMetadata || {}) as { promptTokenCount?: number; candidatesTokenCount?: number };
      if (!text) throw new StructuredOutputError(`Gemini returned no JSON (finish reason: ${candidate?.finishReason || "unknown"})`);
      return { text, finishReason: candidate?.finishReason || "unknown", usage: { input_tokens: usage.promptTokenCount || 0, output_tokens: usage.candidatesTokenCount || 0 } };
    };

    const first = await call();
    let parsed: Record<string, unknown>;
    let totalUsage = first.usage;
    try { parsed = parseStructuredOutput(first.text, effectiveSchema); }
    catch (error) {
      if (!(error instanceof StructuredOutputError)) throw error;
      const textMode = request.mode === "tutor" || request.mode === "summary";
      const retry = await call(
        textMode
          ? `${error.message}. Answer the original request completely in plain text and include only exact SOURCE labels that support it.`
          : `${error.message}. Return a fresh, complete JSON value matching the supplied response schema. Use only SOURCE labels present in the document; do not invent citations.`,
        textMode,
      );
      totalUsage = { input_tokens: first.usage.input_tokens + retry.usage.input_tokens, output_tokens: first.usage.output_tokens + retry.usage.output_tokens };
      try {
        parsed = textMode
          ? textResult(request.mode as "tutor" | "summary", retry.text, request.allowedCitations || [],effectiveSchema)
          : parseStructuredOutput(retry.text, effectiveSchema);
        const issues = validateSchema(parsed, effectiveSchema);
        if (issues.length) throw new StructuredOutputError(`Gemini fallback failed validation: ${issues.slice(0, 4).join("; ")}`);
      }
      catch (retryError) {
        const detail = retryError instanceof Error ? retryError.message : "unknown validation error";
        throw new StructuredOutputError(`Gemini structured output could not be recovered after one retry (${detail}; finish reason: ${retry.finishReason})`);
      }
    }
    return {
      provider: this.name,
      model: this.model,
      result: parsed,
      usage: totalUsage,
    };
  }
}

function openAiOutputText(payload: Record<string, unknown>) {
  if (typeof payload.output_text === "string") return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = Array.isArray((item as { content?: unknown }).content)
      ? (item as { content: Array<{ text?: unknown }> }).content
      : [];
    const part = content.find((candidate) => typeof candidate?.text === "string");
    if (part && typeof part.text === "string") return part.text;
  }
  throw new Error("The OpenAI response did not contain usable output");
}

class OpenAiProvider implements AiProvider {
  readonly name = "openai" as const;
  readonly model = process.env.OPENAI_MODEL?.trim() || "gpt-5.6-luna";

  async generate(request: AiGenerationRequest): Promise<AiGenerationResult> {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) throw new AiProviderError("auth", "OpenAI API key is not configured", { provider: this.name });
    const source = request.source.text !== undefined
      ? { type: "input_text", text: `SOURCE FILE: ${request.source.name}\n\n${request.source.text}` }
      : {
          type: "input_file",
          filename: request.source.name,
          file_data: `data:${request.source.mimeType};base64,${Buffer.from(request.source.bytes || []).toString("base64")}`,
          detail: "auto",
        };
    const effectiveSchema = citationConstrainedSchema(request.schema, request.allowedCitations || []);
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        store: false,
        max_output_tokens: request.mode === "summary" ? 2200 : 1400,
        instructions: SYSTEM_INSTRUCTION,
        input: [{ role: "user", content: [source, { type: "input_text", text: taskFor(request.mode, request.prompt) }] }],
        text: { format: { type: "json_schema", name: `studyos_${request.mode}`, strict: true, schema: effectiveSchema } },
      }),
      signal: AbortSignal.timeout(55_000),
    });
    const payload = await response.json() as Record<string, unknown>;
    if (!response.ok) throw providerError(this.name, response, payload);
    const usage = (payload.usage || {}) as { input_tokens?: number; output_tokens?: number };
    return {
      provider: this.name,
      model: this.model,
      result: parseStructuredOutput(openAiOutputText(payload), effectiveSchema),
      usage: { input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0 },
    };
  }
}

class OmniRouteProvider implements AiProvider {
  readonly name = "omniroute" as const;
  readonly model: string;
  private readonly compression: CompressionPolicy;
  constructor(quality: AIQuality = "balanced", compression: CompressionPolicy = "off") {
    this.model = quality === "fast" ? "auto/fast" : quality === "high" ? "auto/smart" : "auto";
    this.compression = compression;
  }
  async generate(request: AiGenerationRequest): Promise<AiGenerationResult> {
    const baseUrl = process.env.OMNIROUTE_BASE_URL?.trim().replace(/\/$/, "");
    const apiKey = process.env.OMNIROUTE_API_KEY?.trim();
    if (!baseUrl || !apiKey) throw new AiProviderError("auth", "OmniRoute is not configured", { provider: this.name });
    const effectiveSchema = citationConstrainedSchema(request.schema, request.allowedCitations || []);
    const sourceText = request.source.text ?? Buffer.from(request.source.bytes || []).toString("base64");
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "x-omniroute-compression": this.compression },
      body: JSON.stringify({
        model: this.model,
        // StudyOS validates the complete structured result before returning it.
        // Explicitly disable SSE while OmniRoute cascades across routes.
        stream: false,
        messages: [
          { role: "system", content: SYSTEM_INSTRUCTION },
          { role: "user", content: `SOURCE FILE: ${request.source.name}\n\n${sourceText}\n\n${taskFor(request.mode, request.prompt)}\n\n${strictJsonInstruction(effectiveSchema, request.allowedCitations || [])}` },
        ],
      }),
      signal: AbortSignal.timeout(55_000),
    });
    const payload = await response.json() as Record<string, unknown>;
    if (!response.ok) throw providerError(this.name, response, payload);
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const content = (choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content;
    if (typeof content !== "string") throw new StructuredOutputError("OmniRoute returned no usable chat completion");
    const usage = (payload.usage || {}) as { prompt_tokens?: number; completion_tokens?: number };
    return { provider: this.name, model: String(payload.model || this.model), result: parseStructuredOutput(content, effectiveSchema), usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 } };
  }
}

function selectedProvider(): AiProvider {
  const provider = process.env.AI_PROVIDER?.trim().toLowerCase() || "gemini";
  if (provider === "omniroute") return new OmniRouteProvider();
  if (provider === "gemini") return new GeminiProvider();
  if (provider === "openai") return new OpenAiProvider();
  throw new Error(`Unsupported AI_PROVIDER: ${provider}`);
}

function fallbackProvider(primary: AiProvider) {
  if (primary.name === "gemini" && process.env.OPENAI_API_KEY?.trim()) return new OpenAiProvider();
  if (primary.name === "openai" && process.env.GEMINI_API_KEY?.trim()) return new GeminiProvider();
  return null;
}

class ResilientAiProvider implements AiProvider {
  readonly name: AiProvider["name"];
  readonly model: string;
  private readonly primary: AiProvider;
  constructor(primary: AiProvider) { this.primary = primary; this.name = primary.name; this.model = primary.model; }
  async generate(request: AiGenerationRequest) {
    const maxRetries = Math.max(0, Math.min(2, Number(process.env.AI_MAX_RETRIES ?? 1)));
    let lastError: AiProviderError | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try { return await this.primary.generate(request); }
      catch (error) {
        lastError = normalizeProviderError(this.primary.name, error);
        console.warn("AI provider attempt failed", { provider: this.primary.name, model: this.primary.model, kind: lastError.kind, status: lastError.options.status, attempt: attempt + 1, retryAfterMs: lastError.options.retryAfterMs });
        if (!transientKinds.has(lastError.kind) || attempt === maxRetries) break;
        const base = lastError.options.retryAfterMs ?? Math.min(8_000, 1_000 * 2 ** attempt);
        await sleep(base + (base > 0 ? Math.floor(Math.random() * Math.min(750, base * .1)) : 0));
      }
    }
    const fallback = fallbackProvider(this.primary);
    if (lastError && transientKinds.has(lastError.kind) && fallback) {
      console.warn("AI provider fallback", { fromProvider: this.primary.name, fromModel: this.primary.model, toProvider: fallback.name, toModel: fallback.model, kind: lastError.kind });
      try { return await fallback.generate(request); }
      catch (error) { const fallbackError = normalizeProviderError(fallback.name, error); console.error("AI fallback failed", { provider: fallback.name, model: fallback.model, kind: fallbackError.kind, status: fallbackError.options.status }); throw fallbackError; }
    }
    throw lastError;
  }
}

export function publicAiError(error: unknown, language = "en") {
  const aiError = error instanceof AiProviderError ? error : normalizeProviderError("gemini", error), lang = language.toLowerCase().slice(0, 2);
  const messages = {
    rate_limit: lang === "fa" ? "هوش مصنوعی موقتاً مشغول است. پیشرفت درس شما محفوظ است." : lang === "it" ? "L’AI è temporaneamente occupata. I progressi della lezione sono al sicuro." : "AI is temporarily busy. Your lesson progress is safe.",
    unavailable: lang === "fa" ? "سرویس هوش مصنوعی موقتاً در دسترس نیست. پیشرفت شما محفوظ است." : lang === "it" ? "Il servizio AI è temporaneamente non disponibile. I tuoi progressi sono al sicuro." : "The AI service is temporarily unavailable. Your progress is safe.",
    auth: lang === "fa" ? "تنظیمات سرویس هوش مصنوعی نیاز به بررسی دارد." : lang === "it" ? "La configurazione del servizio AI richiede attenzione." : "The AI service configuration needs attention.",
    timeout: lang === "fa" ? "پاسخ هوش مصنوعی بیش از حد طول کشید. پیشرفت شما محفوظ است." : lang === "it" ? "La risposta AI ha impiegato troppo tempo. I tuoi progressi sono al sicuro." : "The AI response took too long. Your progress is safe.",
    structured_output: lang === "fa" ? "پاسخ درس کامل نبود. لطفاً دوباره تلاش کنید؛ پیشرفت شما محفوظ است." : lang === "it" ? "La risposta della lezione era incompleta. Riprova: i tuoi progressi sono al sicuro." : "The lesson response was incomplete. Please retry; your progress is safe.",
    unknown: lang === "fa" ? "ساخت درس انجام نشد. پیشرفت شما محفوظ است؛ لطفاً دوباره تلاش کنید." : lang === "it" ? "Non è stato possibile creare la lezione. I tuoi progressi sono al sicuro; riprova." : "The lesson could not be created. Your progress is safe; please retry.",
  } satisfies Record<AiErrorKind, string>;
  return { message: messages[aiError.kind], code: aiError.kind, retryAfterSeconds: aiError.options.retryAfterMs === undefined ? undefined : Math.max(1, Math.ceil(aiError.options.retryAfterMs / 1000)) };
}

export function configuredAiProvider(task?: AITask, metadata: { userId?: string; documentId?: string; protectedContext?: boolean } = {}): AiProvider {
  const effectiveTask = task || "simple_generation";
  const preview = configuredProviders(QUALITY_BY_TASK[effectiveTask], metadata.protectedContext === false ? "lite" : "off")[0] || selectedProvider();
  return { name: preview.name, model: preview.model, generate: (request) => generateAI({ ...request, task: task || (request.mode === "questions" ? "quiz" : request.mode), ...metadata }) };
}

const health = new Map<string, { failures: number; unhealthyUntil: number }>();
const PRICE_PER_MILLION: Record<string, { input: number; output: number; status: "known" | "free" }> = {};

function estimateCost(model: string, usage: AiGenerationResult["usage"]) {
  const pricing = PRICE_PER_MILLION[model];
  if (!pricing) return { estimatedCost: null, costStatus: "unknown" as const };
  const estimatedCost = (usage.input_tokens * pricing.input + usage.output_tokens * pricing.output) / 1_000_000;
  return { estimatedCost, costStatus: pricing.status };
}

function configuredProviders(quality: AIQuality, compression: CompressionPolicy): AiProvider[] {
  const direct: AiProvider[] = [];
  const preferred = process.env.AI_PROVIDER?.trim().toLowerCase();
  if (process.env.GEMINI_API_KEY?.trim()) direct.push(new GeminiProvider());
  if (process.env.OPENAI_API_KEY?.trim()) direct.push(new OpenAiProvider());
  if (preferred === "openai") direct.sort((a) => a.name === "openai" ? -1 : 1);
  const omni = process.env.OMNIROUTE_BASE_URL?.trim() && process.env.OMNIROUTE_API_KEY?.trim()
    ? [new OmniRouteProvider(quality, compression)] : [];
  return preferred === "gemini" || preferred === "openai" ? [...direct, ...omni] : [...omni, ...direct];
}

export function createAIGateway(options: GatewayOptions = {}) {
  return async function generateAI(request: GenerateAIRequest): Promise<AiGenerationResult> {
    const started = (options.now || Date.now)();
    const quality = request.quality || QUALITY_BY_TASK[request.task];
    const compression = compressionPolicyFor(request);
    const providers = options.providers || configuredProviders(quality, compression);
    if (!providers.length) throw new AiProviderError("auth", "No AI provider is configured", { provider: "gemini" });
    const maxRetries = Math.max(0, Math.min(2, Number(process.env.AI_MAX_RETRIES ?? 1)));
    let fallbackCount = 0;
    let lastError: AiProviderError | undefined;
    let lastProvider = providers[0];
    for (let providerIndex = 0; providerIndex < providers.length; providerIndex += 1) {
      const provider = providers[providerIndex]; lastProvider = provider;
      const state = health.get(provider.name);
      if (state && state.unhealthyUntil > Date.now() && providerIndex < providers.length - 1) { fallbackCount += 1; continue; }
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
          const result = await provider.generate(request);
          health.delete(provider.name);
          const cost = estimateCost(result.model, result.usage);
          const row: AITelemetry = { userId: request.userId, documentId: request.documentId, task: request.task, gateway: "studyos", provider: result.provider, model: result.model, inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens, ...cost, latencyMs: (options.now || Date.now)() - started, fallbackCount, compressionEnabled: compression !== "off", compressionPolicy: compression, compressionRatio: null, success: true, errorType: null };
          try { await (options.persistTelemetry || persistDefaultTelemetry)(row); } catch (error) { console.warn("AI telemetry persistence failed", error); }
          return { ...result, gateway: "studyos", fallbackCount, compression: { policy: compression } };
        } catch (error) {
          lastError = normalizeProviderError(provider.name, error);
          if (!transientKinds.has(lastError.kind) || attempt === maxRetries) break;
          const base = Math.min(lastError.options.retryAfterMs ?? 1_000 * 2 ** attempt, 8_000);
          await sleep(base);
        }
      }
      if (!lastError || !transientKinds.has(lastError.kind)) break;
      const previous = health.get(provider.name)?.failures || 0;
      health.set(provider.name, { failures: previous + 1, unhealthyUntil: Date.now() + Math.min(60_000, 5_000 * 2 ** previous) });
      fallbackCount += 1;
    }
    const failure = lastError || new AiProviderError("unavailable", "All configured AI routes are unavailable", { provider: lastProvider.name });
    const row: AITelemetry = { userId: request.userId, documentId: request.documentId, task: request.task, gateway: "studyos", provider: lastProvider.name, model: lastProvider.model, inputTokens: 0, outputTokens: 0, estimatedCost: null, costStatus: "unknown", latencyMs: (options.now || Date.now)() - started, fallbackCount, compressionEnabled: compression !== "off", compressionPolicy: compression, compressionRatio: null, success: false, errorType: failure.kind };
    try { await (options.persistTelemetry || persistDefaultTelemetry)(row); } catch (error) { console.warn("AI telemetry persistence failed", error); }
    throw failure;
  };
}

export const generateAI = createAIGateway();

/** Structured StudyOS features stream only after a complete response validates, so partial
 * output from a failed route can never be joined to a fallback model's answer. */
export async function streamAI(request: GenerateAIRequest, options: GatewayOptions = {}) {
  const result = await createAIGateway(options)(request);
  const payload = new TextEncoder().encode(JSON.stringify(result.result));
  return { ...result, stream: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(payload); controller.close(); } }) };
}

export function resetProviderHealthForTests() { health.clear(); }
