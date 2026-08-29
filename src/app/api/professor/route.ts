import { NextResponse } from "next/server";
import { configuredAiProvider, publicAiError } from "@/lib-ai";
import type { StoredChunk } from "@/lib-document-processing";
import {
  actionInstruction,
  chunksForStage,
  isProfessorAction,
  nextLessonState,
  professorCitations,
  professorSource,
  type ProfessorStage,
} from "@/lib-professor";
import { db, ensureStudySchema } from "@/lib-db";
import { currentUserId } from "@/lib-user";

export const runtime = "nodejs";
export const maxDuration = 300;

const outlineSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    objectives: {
      type: "array",
      minItems: 4,
      maxItems: 10,
      items: { type: "string" },
    },
    conceptMap: {
      type: "array",
      minItems: 4,
      maxItems: 12,
      items: { type: "string" },
    },
    stages: {
      type: "array",
      minItems: 4,
      maxItems: 10,
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          purpose: { type: "string" },
          keyTerms: {
            type: "array",
            minItems: 2,
            maxItems: 12,
            items: { type: "string" },
          },
          chunkIndexes: {
            type: "array",
            minItems: 1,
            maxItems: 16,
            items: { type: "number" },
          },
        },
        required: ["id", "title", "purpose", "keyTerms", "chunkIndexes"],
        additionalProperties: false,
      },
    },
    recap: {
      type: "array",
      minItems: 4,
      maxItems: 12,
      items: { type: "string" },
    },
    masteryQuestions: {
      type: "array",
      minItems: 4,
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          expected: { type: "string" },
          concept: { type: "string" },
        },
        required: ["question", "expected", "concept"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "title",
    "objectives",
    "conceptMap",
    "stages",
    "recap",
    "masteryQuestions",
  ],
  additionalProperties: false,
};
const teachingSchema = {
  type: "object",
  properties: {
    content: { type: "string" },
    check: { type: "string" },
    citations: { type: "array", items: { type: "string" } },
  },
  required: ["content", "check", "citations"],
  additionalProperties: false,
};
const expansionSchema = {
  type: "object",
  properties: {
    content: { type: "string" },
    citations: { type: "array", items: { type: "string" } },
  },
  required: ["content", "citations"],
  additionalProperties: false,
};
const feedbackSchema = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["correct", "partially_correct", "needs_review"],
    },
    feedback: { type: "string" },
    strength: { type: "string" },
    correction: { type: "string" },
    nextStep: { type: "string" },
    citations: { type: "array", items: { type: "string" } },
  },
  required: [
    "verdict",
    "feedback",
    "strength",
    "correction",
    "nextStep",
    "citations",
  ],
  additionalProperties: false,
};

async function sectionChunks(
  userId: string,
  documentId: string,
  sectionId: string,
) {
  const rows =
    await db()`with recursive tree as (select id from public.document_sections where id=${sectionId} and user_id=${userId} union all select s.id from public.document_sections s join tree on s.parent_id=tree.id where s.user_id=${userId}) select chunk_index,content,page_start,page_end,section,section_id,char_start,char_end from public.document_chunks where document_id=${documentId} and user_id=${userId} and section_id in(select id from tree) order by chunk_index`;
  return rows as unknown as StoredChunk[];
}

async function ownedTask(userId: string, taskId: string) {
  const sql = db(),
    rows =
      await sql`select t.id,t.document_id,t.section_id,t.title,s.title section_title,s.page_start,s.page_end,d.original_name from public.study_plan_tasks t join public.document_sections s on s.id=t.section_id and s.user_id=t.user_id join public.documents d on d.id=t.document_id and d.user_id=t.user_id where t.id=${taskId} and t.user_id=${userId}`;
  if (!rows[0]) throw new Error("Study-plan section not found");
  return {
    item: rows[0],
    chunks: await sectionChunks(
      userId,
      String(rows[0].document_id),
      String(rows[0].section_id),
    ),
  };
}

async function lessonContext(userId: string, lessonId: string) {
  const sql = db(),
    rows =
      await sql`select l.*,s.title section_title,s.page_start,s.page_end,d.original_name from public.professor_lessons l join public.document_sections s on s.id=l.section_id and s.user_id=l.user_id join public.documents d on d.id=l.document_id and d.user_id=l.user_id where l.id=${lessonId} and l.user_id=${userId}`;
  if (!rows[0]) return null;
  const lesson = rows[0],
    [profiles, course, chunks] = await Promise.all([
      sql`select * from public.user_profiles where user_id=${userId}`,
      sql`select current_level,study_style,preferred_language from public.tutor_profiles where user_id=${userId} and document_id=${lesson.document_id}`,
      sectionChunks(
        userId,
        String(lesson.document_id),
        String(lesson.section_id),
      ),
    ]);
  return { lesson, chunks, pref: { ...profiles[0], ...course[0] } };
}

async function generateStage(
  userId: string,
  lesson: any,
  allChunks: StoredChunk[],
  pref: any,
  stageIndex: number,
) {
  const data = lesson.stages_json || {},
    stages = Array.isArray(data.stages)
      ? ([...data.stages] as ProfessorStage[])
      : [],
    stage = stages[stageIndex];
  if (!stage || stage.content) return lesson;
  const chunks = chunksForStage(allChunks, stage),
    name = String(lesson.original_name || "source"),
    recent = stages
      .slice(Math.max(0, stageIndex - 2), stageIndex)
      .map((item) => ({
        title: item.title,
        content: item.content?.slice(-1800),
      }));
  const generated = await configuredAiProvider("professor", {
    userId,
    documentId: String(lesson.document_id),
    protectedContext: true,
  }).generate({
    mode: "tutor",
    schema: teachingSchema,
    allowedCitations: professorCitations(name, chunks),
    prompt: `Teach concept ${stageIndex + 1} of ${stages.length} in a complete private-university lesson. Language: ${pref.teaching_language || pref.preferred_language || "it"}; learner level: ${pref.academic_level || pref.current_level || "beginner"}; style: ${pref.study_style || "mixed"}; depth: ${pref.explanation_depth || "adaptive"}. Concept: ${stage.title}. Purpose: ${stage.purpose}. Key terms: ${stage.keyTerms.join(", ")}. Explain definitions, mechanisms, cause/effect, relationships, terminology, meaningful examples, grounded clinical/exam implications, and common confusions. Preserve scientific names, numbers, equations, qualifiers and exceptions. Produce a substantial structured teaching segment, normally 700-1200 Italian words for a substantive concept; never a summary or paragraph-by-paragraph paraphrase. Use headings and lists. End with one meaningful comprehension question. Recent lesson memory: ${JSON.stringify(recent)}.`,
    source: {
      mimeType: "text/plain",
      name,
      text: professorSource(name, chunks),
    },
  });
  const value = generated.result as any;
  stages[stageIndex] = {
    ...stage,
    content: value.content,
    check: value.check,
    citations: value.citations,
    generatedAt: new Date().toISOString(),
  };
  return (
    await db()`update public.professor_lessons set stages_json=${JSON.stringify({ ...data, stages })}::jsonb,provider=${generated.provider},model=${generated.model},input_tokens=input_tokens+${generated.usage.input_tokens},output_tokens=output_tokens+${generated.usage.output_tokens},updated_at=now() where id=${lesson.id} and user_id=${userId} returning *`
  )[0];
}

function safeError(error: unknown, language = "it") {
  const safe = publicAiError(error, language);
  return NextResponse.json(
    {
      error: safe.message,
      code: safe.code,
      retryAfterSeconds: safe.retryAfterSeconds,
    },
    {
      status: ["rate_limit", "unavailable", "timeout"].includes(safe.code)
        ? 503
        : 500,
    },
  );
}

export async function POST(request: Request) {
  let language = "it";
  try {
    const userId = await currentUserId();
    if (!userId)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    await ensureStudySchema();
    const { taskId } = await request.json(),
      sql = db(),
      { item, chunks } = await ownedTask(userId, String(taskId));
    const existing =
      await sql`select l.*,d.original_name from public.professor_lessons l join public.documents d on d.id=l.document_id where l.user_id=${userId} and l.document_id=${item.document_id} and l.section_id=${item.section_id}`;
    if (existing[0] && Number(existing[0].outline_version || 1) >= 2)
      return NextResponse.json({ lesson: existing[0], section: item });
    // Version-one lessons were generated as one shallow response. Re-plan them once
    // from the full indexed section so existing production users receive the staged lesson.
    if (existing[0])
      await sql`delete from public.professor_lessons where id=${existing[0].id} and user_id=${userId}`;
    if (!chunks.length)
      return NextResponse.json(
        { error: "This indexed section has no readable source chunks" },
        { status: 409 },
      );
    const [profiles, course] = await Promise.all([
      sql`select * from public.user_profiles where user_id=${userId}`,
      sql`select current_level,study_style,preferred_language from public.tutor_profiles where user_id=${userId} and document_id=${item.document_id}`,
    ]);
    const pref = { ...profiles[0], ...course[0] };
    language = String(
      pref.teaching_language || pref.preferred_language || "it",
    );
    const name = String(item.original_name);
    const generated = await configuredAiProvider("professor", {
      userId,
      documentId: String(item.document_id),
      protectedContext: true,
    }).generate({
      mode: "tutor",
      schema: outlineSchema,
      allowedCitations: professorCitations(name, chunks),
      prompt: `Inspect the complete indexed section before planning. Design a comprehensive, pedagogically coherent private-university lesson in ${language} for level ${pref.academic_level || pref.current_level || "beginner"}. Section: ${item.section_title}, pages ${item.page_start}-${item.page_end}; ${chunks.length} original chunks. Cover the entire section, not just its opening. Create 4-10 stages proportional to scope, each tied to exact CHUNK numbers. Objectives and concept map must cover definitions, mechanisms, relationships, terminology, exceptions, numbers/equations and grounded clinical/exam implications. Outline only; do not write lesson prose yet.`,
      source: {
        mimeType: "text/plain",
        name,
        text: professorSource(name, chunks),
      },
    });
    const value = generated.result as any,
      valid = new Set(chunks.map((chunk) => chunk.chunk_index));
    const cleanStages = value.stages.map((stage: any, index: number) => {
      const selected = [
        ...new Set<number>(stage.chunkIndexes.map(Number)),
      ].filter((n) => valid.has(n));
      const fallback = chunks
        .slice(
          Math.floor((index / value.stages.length) * chunks.length),
          Math.ceil(((index + 1) / value.stages.length) * chunks.length),
        )
        .map((chunk) => chunk.chunk_index);
      return {
        ...stage,
        id: `concept-${index + 1}`,
        chunkIndexes: selected.length ? selected : fallback,
      };
    });
    const inserted =
      await sql`insert into public.professor_lessons(user_id,document_id,section_id,task_id,stages_json,mastery_questions_json,completed_stages_json,interactions_json,stage_checks_json,outline_version,provider,model,input_tokens,output_tokens) values(${userId},${item.document_id},${item.section_id},${item.id},${JSON.stringify({ title: value.title, objectives: value.objectives, conceptMap: value.conceptMap, stages: cleanStages, recap: value.recap })}::jsonb,${JSON.stringify(value.masteryQuestions)}::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,2,${generated.provider},${generated.model},${generated.usage.input_tokens},${generated.usage.output_tokens}) on conflict(user_id,document_id,section_id) do nothing returning *`;
    let saved =
      inserted[0] ||
      (
        await sql`select * from public.professor_lessons where user_id=${userId} and document_id=${item.document_id} and section_id=${item.section_id}`
      )[0];
    saved = await generateStage(
      userId,
      { ...saved, original_name: name },
      chunks,
      pref,
      0,
    );
    await sql`update public.study_plan_tasks set learning_status='learning_in_progress' where id=${item.id} and user_id=${userId}`;
    return NextResponse.json({ lesson: saved, section: item });
  } catch (error) {
    console.error("Professor generation failed", error);
    return safeError(error, language);
  }
}

export async function PATCH(request: Request) {
  try {
    const userId = await currentUserId();
    if (!userId)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    await ensureStudySchema();
    const body = await request.json(),
      context = await lessonContext(userId, String(body.lessonId));
    if (!context)
      return NextResponse.json({ error: "Lesson not found" }, { status: 404 });
    let { lesson } = context;
    const { chunks, pref } = context,
      sql = db(),
      stages = (lesson.stages_json?.stages || []) as ProfessorStage[],
      stageIndex = Math.max(
        0,
        Math.min(
          stages.length - 1,
          Number(body.stageIndex ?? lesson.current_stage),
        ),
      ),
      stage = stages[stageIndex];
    if (body.action === "stage") {
      if (
        stage &&
        !(lesson.stage_checks_json || []).some(
          (check: any) => Number(check.stageIndex) === stageIndex,
        )
      )
        return NextResponse.json(
          { error: "Answer the comprehension check before continuing." },
          { status: 409 },
        );
      const completed = [
          ...new Set([...(lesson.completed_stages_json || []), stageIndex]),
        ],
        next = nextLessonState(stageIndex, stages.length);
      lesson = (
        await sql`update public.professor_lessons set current_stage=${next.currentStage},status=${next.status},completed_stages_json=${JSON.stringify(completed)}::jsonb,updated_at=now() where id=${lesson.id} and user_id=${userId} returning *`
      )[0];
      if (next.status === "learning")
        lesson = await generateStage(
          userId,
          { ...lesson, original_name: context.lesson.original_name },
          chunks,
          pref,
          next.currentStage,
        );
      await sql`update public.study_plan_tasks set learning_status=${next.status === "doubt_clearing" ? "lesson_completed_mastery_pending" : "learning_in_progress"} where id=${lesson.task_id} and user_id=${userId}`;
      return NextResponse.json({ lesson });
    }
    if (isProfessorAction(body.action) && stage) {
      const relevant = chunksForStage(chunks, stage),
        name = String(context.lesson.original_name),
        recent = (lesson.interactions_json || [])
          .filter((x: any) => Number(x.stageIndex) === stageIndex)
          .slice(-4);
      const generated = await configuredAiProvider("professor", {
        userId,
        documentId: String(lesson.document_id),
        protectedContext: true,
      }).generate({
        mode: "tutor",
        schema: expansionSchema,
        allowedCitations: professorCitations(name, relevant),
        prompt: `${actionInstruction(body.action)} Respond in ${pref.teaching_language || pref.preferred_language || "it"} for level ${pref.academic_level || pref.current_level || "beginner"}. Stay scoped to section “${context.lesson.section_title}”, current concept “${stage.title}”, original evidence, and core teaching. Do not replace or repeat the core lesson. CORE: ${stage.content || ""}. RECENT EXPANSIONS: ${JSON.stringify(recent.map((x: any) => ({ action: x.action, content: x.content })))}.`,
        source: {
          mimeType: "text/plain",
          name,
          text: professorSource(name, relevant),
        },
      });
      const value = generated.result as any,
        interaction = {
          id: crypto.randomUUID(),
          stageIndex,
          action: body.action,
          content: value.content,
          citations: value.citations,
          createdAt: new Date().toISOString(),
          provider: generated.provider,
          model: generated.model,
        },
        interactions = [...(lesson.interactions_json || []), interaction];
      lesson = (
        await sql`update public.professor_lessons set interactions_json=${JSON.stringify(interactions)}::jsonb,provider=${generated.provider},model=${generated.model},input_tokens=input_tokens+${generated.usage.input_tokens},output_tokens=output_tokens+${generated.usage.output_tokens},updated_at=now() where id=${lesson.id} and user_id=${userId} returning *`
      )[0];
      return NextResponse.json({ lesson, interaction });
    }
    if (body.action === "comprehension" && stage) {
      const answer = String(body.answer || "").trim();
      if (answer.length < 2)
        return NextResponse.json(
          { error: "Write an answer before submitting." },
          { status: 400 },
        );
      const relevant = chunksForStage(chunks, stage),
        name = String(context.lesson.original_name),
        generated = await configuredAiProvider("error_correction", {
          userId,
          documentId: String(lesson.document_id),
          protectedContext: true,
        }).generate({
          mode: "tutor",
          schema: feedbackSchema,
          allowedCitations: professorCitations(name, relevant),
          prompt: `Evaluate in ${pref.teaching_language || pref.preferred_language || "it"}. Question: ${stage.check}. Student answer: ${answer}. Give specific, encouraging, scientifically precise source-grounded feedback. This checkpoint is only a learning signal and never section mastery.`,
          source: {
            mimeType: "text/plain",
            name,
            text: professorSource(name, relevant),
          },
        });
      const value = generated.result as any,
        check = {
          id: crypto.randomUUID(),
          stageIndex,
          question: stage.check,
          answer,
          ...value,
          createdAt: new Date().toISOString(),
          provider: generated.provider,
          model: generated.model,
        },
        checks = [
          ...(lesson.stage_checks_json || []).filter(
            (x: any) => Number(x.stageIndex) !== stageIndex,
          ),
          check,
        ];
      lesson = (
        await sql`update public.professor_lessons set stage_checks_json=${JSON.stringify(checks)}::jsonb,provider=${generated.provider},model=${generated.model},input_tokens=input_tokens+${generated.usage.input_tokens},output_tokens=output_tokens+${generated.usage.output_tokens},updated_at=now() where id=${lesson.id} and user_id=${userId} returning *`
      )[0];
      return NextResponse.json({ lesson, check });
    }
    if (body.action === "doubt") {
      const question = String(body.question || "").trim();
      if (question.length < 2)
        return NextResponse.json(
          { error: "Write your doubt first." },
          { status: 400 },
        );
      const name = String(context.lesson.original_name);
      const generated = await configuredAiProvider("professor", {
        userId,
        documentId: String(lesson.document_id),
        protectedContext: true,
      }).generate({
        mode: "tutor",
        schema: expansionSchema,
        allowedCitations: professorCitations(name, chunks),
        prompt: `Resolve this end-of-section doubt in ${pref.teaching_language || pref.preferred_language || "it"}, grounded in the indexed section. Student doubt: ${question}. Lesson memory: ${JSON.stringify(stages.map((item) => ({ title: item.title, content: item.content?.slice(-900) })))}.`,
        source: {
          mimeType: "text/plain",
          name,
          text: professorSource(name, chunks),
        },
      });
      const value = generated.result as any,
        doubt = {
          id: crypto.randomUUID(),
          question,
          answer: value.content,
          citations: value.citations,
          createdAt: new Date().toISOString(),
          provider: generated.provider,
          model: generated.model,
        },
        doubts = [...(lesson.doubts_json || []), doubt];
      lesson = (
        await sql`update public.professor_lessons set doubts_json=${JSON.stringify(doubts)}::jsonb,provider=${generated.provider},model=${generated.model},input_tokens=input_tokens+${generated.usage.input_tokens},output_tokens=output_tokens+${generated.usage.output_tokens},updated_at=now() where id=${lesson.id} and user_id=${userId} returning *`
      )[0];
      return NextResponse.json({ lesson, doubt });
    }
    if (body.action === "mastery") {
      const answers = Array.isArray(body.answers) ? body.answers : [],
        questions = Array.isArray(lesson.mastery_questions_json)
          ? lesson.mastery_questions_json
          : [];
      const assessment = await configuredAiProvider("error_correction", {
        userId,
        documentId: String(lesson.document_id),
        protectedContext: true,
      }).generate({
        mode: "tutor",
        prompt: `Grade these active-recall answers against expected answers. Return score 0-100 and weakConcepts. Questions: ${JSON.stringify(questions)} Answers: ${JSON.stringify(answers)}`,
        schema: {
          type: "object",
          properties: {
            score: { type: "number" },
            weakConcepts: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  concept: { type: "string" },
                  evidence: { type: "string" },
                },
                required: ["concept", "evidence"],
                additionalProperties: false,
              },
            },
          },
          required: ["score", "weakConcepts"],
          additionalProperties: false,
        },
        allowedCitations: [],
        source: {
          mimeType: "text/plain",
          name: "assessment",
          text: JSON.stringify(questions),
        },
      });
      const result = assessment.result as any,
        score = Math.max(0, Math.min(100, Number(result.score) || 0)),
        status = score >= 70 ? "mastered" : "needs_review";
      await sql`update public.professor_lessons set mastery_score=${score},status=${status},provider=${assessment.provider},model=${assessment.model},input_tokens=input_tokens+${assessment.usage.input_tokens},output_tokens=output_tokens+${assessment.usage.output_tokens},updated_at=now() where id=${lesson.id} and user_id=${userId}`;
      await sql`update public.study_plan_tasks set learning_status=${status},status=${status === "mastered" ? "completed" : "planned"},score=${score},completed_at=${status === "mastered" ? new Date().toISOString() : null} where id=${lesson.task_id} and user_id=${userId}`;
      await sql`insert into public.section_mastery(user_id,document_id,section_id,questions_answered,question_accuracy,confidence,updated_at) values(${userId},${lesson.document_id},${lesson.section_id},${questions.length},${score},${score},now()) on conflict(user_id,document_id,section_id) do update set questions_answered=excluded.questions_answered,question_accuracy=excluded.question_accuracy,confidence=excluded.confidence,updated_at=now()`;
      for (const weak of result.weakConcepts || [])
        await sql`insert into public.weak_concepts(user_id,document_id,section_id,concept,evidence) values(${userId},${lesson.document_id},${lesson.section_id},${String(weak.concept)},${String(weak.evidence)})`;
      return NextResponse.json({
        score,
        status,
        weakConcepts: result.weakConcepts || [],
      });
    }
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (error) {
    console.error("Professor update failed", error);
    return safeError(error);
  }
}
