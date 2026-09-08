type StoredChunk = { chunk_index: number; content: string; page_start: number | null; page_end: number | null; section: string | null };

function citationLabel(name: string, chunk: StoredChunk) {
  const pages = chunk.page_start ? `pp. ${chunk.page_start}${chunk.page_end && chunk.page_end !== chunk.page_start ? `–${chunk.page_end}` : ""}` : "location unavailable";
  return `${name} · ${chunk.section || `chunk ${chunk.chunk_index + 1}`} · ${pages}`;
}

export const PROFESSOR_ACTIONS = [
  "simpler",
  "deeper",
  "example",
  "comparison",
  "why",
] as const;
export type ProfessorAction = (typeof PROFESSOR_ACTIONS)[number];
export type LearningState = "not_seen" | "learning" | "understood" | "exam_ready" | "mastered";
export type ProfessorPhase = "teach" | "verify" | "connect" | "exam_test" | "reteach" | "advance";
export type ExamFormat = "oral" | "mcq" | "written" | "calculations" | "mixed";

export type ProfessorStage = {
  id: string;
  title: string;
  purpose: string;
  keyTerms: string[];
  chunkIndexes: number[];
  content?: string;
  check?: string;
  citations?: string[];
  generatedAt?: string;
  conceptId?: string;
  cached?: boolean;
};

export function isProfessorAction(value: unknown): value is ProfessorAction {
  return PROFESSOR_ACTIONS.includes(value as ProfessorAction);
}

export function nextLessonState(currentStage: number, totalStages: number) {
  const nextStage = Math.min(Math.max(0, currentStage + 1), totalStages);
  return {
    currentStage: nextStage,
    status: nextStage >= totalStages ? "doubt_clearing" : "learning",
  };
}

export function chunksForStage(chunks: StoredChunk[], stage: ProfessorStage) {
  const selected = new Set(stage.chunkIndexes.map(Number));
  const exact = chunks.filter((chunk) =>
    selected.has(Number(chunk.chunk_index)),
  );
  if (exact.length) return exact;
  const terms = [stage.title, stage.purpose, ...stage.keyTerms]
    .join(" ")
    .toLocaleLowerCase();
  const words = [
    ...new Set(
      terms.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 4),
    ),
  ];
  return chunks
    .map((chunk) => ({
      chunk,
      score: words.reduce(
        (sum, word) =>
          sum + (chunk.content.toLocaleLowerCase().includes(word) ? 1 : 0),
        0,
      ),
    }))
    .sort(
      (a, b) => b.score - a.score || a.chunk.chunk_index - b.chunk.chunk_index,
    )
    .slice(0, Math.min(8, chunks.length))
    .map((item) => item.chunk);
}

export function professorSource(name: string, chunks: StoredChunk[]) {
  return chunks
    .map(
      (chunk) =>
        `[SOURCE: ${citationLabel(name, chunk)} | CHUNK ${chunk.chunk_index}]\n${chunk.content}`,
    )
    .join("\n\n---\n\n");
}

export function professorCitations(name: string, chunks: StoredChunk[]) {
  return [...new Set(chunks.map((chunk) => citationLabel(name, chunk)))];
}

export function actionInstruction(action: ProfessorAction) {
  return {
    simpler:
      "Re-teach the current concept in simpler Italian, using short steps and plain language without sacrificing scientific accuracy or omitting essential qualifiers.",
    deeper:
      "Go substantially deeper into mechanisms, causal chains, relationships, exceptions and exam-relevant implications grounded in the supplied evidence.",
    example:
      "Give one or more useful examples, applications or analogies. Explicitly label every analogy as an explanatory analogy rather than a source fact.",
    comparison:
      "Compare the current concept with the most relevant related or commonly confused concept. Use a compact Markdown table when it improves clarity.",
    why: "Explain the causal or mechanistic reason behind the current concept. Build a clear because-therefore chain instead of restating it.",
  }[action];
}

export function learningStateForScore(score: number, examStyle = false): LearningState {
  if (score >= 90) return "mastered";
  if (score >= 75) return examStyle ? "exam_ready" : "understood";
  if (score >= 55) return "understood";
  return "learning";
}

export function shouldReteach(verdict: string) {
  return verdict === "needs_review" || verdict === "incorrect";
}

export function nextAdaptivePhase(phase: ProfessorPhase, verdict?: string): ProfessorPhase {
  if (phase === "verify") return shouldReteach(String(verdict)) ? "reteach" : "connect";
  if (phase === "reteach") return "verify";
  if (phase === "connect") return "exam_test";
  if (phase === "exam_test") return shouldReteach(String(verdict)) ? "reteach" : "advance";
  if (phase === "advance") return "teach";
  return "verify";
}

export function isNearExam(examDate?: string | null, now = new Date()) {
  if (!examDate) return false;
  const days = (new Date(`${examDate}T23:59:59Z`).getTime() - now.getTime()) / 86_400_000;
  return days >= 0 && days <= 14;
}

export function selectRetrievalChunks(chunks: StoredChunk[], stage: ProfessorStage, excludedIndexes: number[] = [], limit = 6) {
  const excluded = new Set(excludedIndexes.map(Number));
  return chunksForStage(chunks, stage).filter(chunk => !excluded.has(Number(chunk.chunk_index))).slice(0, limit);
}

export function compactRecentTurns(turns: unknown[], limit = 6) {
  return turns.slice(-limit).map((turn: any) => ({
    role: String(turn?.role || "system").slice(0, 20),
    phase: String(turn?.phase || "").slice(0, 20),
    text: String(turn?.text || turn?.content || "").slice(0, 900),
  }));
}
