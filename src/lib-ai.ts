export type AiMode = "tutor" | "summary" | "flashcards" | "questions";

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
  provider: "gemini" | "openai";
  model: string;
  result: Record<string, unknown>;
  usage: { input_tokens: number; output_tokens: number };
};

type AiProvider = {
  name: AiGenerationResult["provider"];
  model: string;
  generate(request: AiGenerationRequest): Promise<AiGenerationResult>;
};

const SYSTEM_INSTRUCTION =
  "You are StudyOS, a rigorous source-grounded tutor. Use only the supplied user document and never invent facts. Every factual answer, summary item, flashcard, and question must cite the actual source filename plus the most precise available page, slide, heading, or section. Never fabricate page numbers or use placeholder citations. If an exact location is unavailable, cite the filename and nearest real heading/section. Reply in the learner's requested language, supporting English, Italian, and Persian, and defaulting to Italian. If the source does not answer the request, say so clearly.";

function taskFor(mode: AiMode, prompt: string) {
  if (mode === "summary") return `Create a structured, exam-focused summary. ${prompt || "Cover the entire document."}`;
  if (mode === "flashcards") return `Create 10 high-quality active-recall flashcards. ${prompt}`;
  if (mode === "questions") return `Create 8 multiple-choice questions with exactly four options each. ${prompt}`;
  return `Answer this learner's question and teach the concept step by step: ${prompt}`;
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

function textResult(mode: "tutor" | "summary", text: string, citations: string[]) {
  const content = text.trim().replace(/^```(?:text|markdown)?\s*/i, "").replace(/\s*```$/, "");
  if (!content) throw new StructuredOutputError("Gemini returned an empty plain-text fallback");
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
    if (!apiKey) throw new Error("AI is not configured yet. Add GEMINI_API_KEY in Vercel.");

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
      if (!response.ok) throw new Error(errorDetail(payload) || "Gemini generation failed");

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
          ? textResult(request.mode as "tutor" | "summary", retry.text, request.allowedCitations || [])
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
    if (!apiKey) throw new Error("OpenAI is selected but OPENAI_API_KEY is not configured.");
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
    if (!response.ok) throw new Error(errorDetail(payload) || "OpenAI generation failed");
    const usage = (payload.usage || {}) as { input_tokens?: number; output_tokens?: number };
    return {
      provider: this.name,
      model: this.model,
      result: parseStructuredOutput(openAiOutputText(payload), effectiveSchema),
      usage: { input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0 },
    };
  }
}

export function configuredAiProvider(): AiProvider {
  const provider = process.env.AI_PROVIDER?.trim().toLowerCase() || "gemini";
  if (provider === "gemini") return new GeminiProvider();
  if (provider === "openai") return new OpenAiProvider();
  throw new Error(`Unsupported AI_PROVIDER: ${provider}`);
}
