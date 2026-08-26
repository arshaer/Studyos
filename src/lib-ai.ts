export type AiMode = "tutor" | "summary" | "flashcards" | "questions";

export type AiSource = {
  bytes?: Uint8Array;
  mimeType: string;
  name: string;
  text?: string;
};

export type AiGenerationRequest = {
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
  "You are StudyOS, a rigorous source-grounded tutor. Use only the supplied document. Never invent facts. Cite page, slide, or section when available. Reply in the learner's requested language, supporting English, Italian, and Persian, and defaulting to Italian. If the source does not answer the request, say so clearly.";

function taskFor(mode: AiMode, prompt: string) {
  if (mode === "summary") return `Create a structured, exam-focused summary. ${prompt || "Cover the entire document."}`;
  if (mode === "flashcards") return `Create 10 high-quality active-recall flashcards. ${prompt}`;
  if (mode === "questions") return `Create 8 multiple-choice questions with exactly four options each. ${prompt}`;
  return `Answer this learner's question and teach the concept step by step: ${prompt}`;
}

function parseJson(text: string) {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("The AI response was not valid structured output");
  }
}

function errorDetail(payload: Record<string, unknown>) {
  const error = payload.error;
  return error && typeof error === "object"
    ? String((error as { message?: unknown }).message || "")
    : "";
}

class GeminiProvider implements AiProvider {
  readonly name = "gemini" as const;
  readonly model = process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";

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
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
          contents: [{ role: "user", parts: [sourcePart, { text: taskFor(request.mode, request.prompt) }] }],
          generationConfig: {
            maxOutputTokens: request.mode === "summary" ? 2200 : 1400,
            responseMimeType: "application/json",
            responseJsonSchema: request.schema,
          },
        }),
        signal: AbortSignal.timeout(55_000),
      },
    );
    const payload = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(errorDetail(payload) || "Gemini generation failed");

    const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
    const content = candidates[0] && typeof candidates[0] === "object"
      ? (candidates[0] as { content?: { parts?: Array<{ text?: string }> } }).content
      : undefined;
    const text = content?.parts?.find((part) => typeof part.text === "string")?.text;
    if (!text) throw new Error("The Gemini response did not contain usable output");
    const usage = (payload.usageMetadata || {}) as { promptTokenCount?: number; candidatesTokenCount?: number };
    return {
      provider: this.name,
      model: this.model,
      result: parseJson(text),
      usage: { input_tokens: usage.promptTokenCount || 0, output_tokens: usage.candidatesTokenCount || 0 },
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
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        store: false,
        max_output_tokens: request.mode === "summary" ? 2200 : 1400,
        instructions: SYSTEM_INSTRUCTION,
        input: [{ role: "user", content: [source, { type: "input_text", text: taskFor(request.mode, request.prompt) }] }],
        text: { format: { type: "json_schema", name: `studyos_${request.mode}`, strict: true, schema: request.schema } },
      }),
      signal: AbortSignal.timeout(55_000),
    });
    const payload = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(errorDetail(payload) || "OpenAI generation failed");
    const usage = (payload.usage || {}) as { input_tokens?: number; output_tokens?: number };
    return {
      provider: this.name,
      model: this.model,
      result: parseJson(openAiOutputText(payload)),
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
