import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { publicAiError } from "@/lib-ai";
import { professorProvider } from "@/lib-professor-provider";
import { chooseProfessorTier } from "@/lib-professor-routing";
import type { StoredChunk } from "@/lib-document-processing";
import {
  actionInstruction,
  chunksForStage,
  compactRecentTurns,
  isNearExam,
  isProfessorAction,
  learningStateForScore,
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
  },
  required: ["title", "stages"],
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
      await sql`select t.id,t.document_id,t.section_id,t.title,s.title section_title,s.page_start,s.page_end,d.original_name,d.index_version from public.study_plan_tasks t join public.document_sections s on s.id=t.section_id and s.user_id=t.user_id join public.documents d on d.id=t.document_id and d.user_id=t.user_id where t.id=${taskId} and t.user_id=${userId}`;
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
      await sql`select l.*,s.title section_title,s.page_start,s.page_end,d.original_name,d.index_version source_version from public.professor_lessons l join public.document_sections s on s.id=l.section_id and s.user_id=l.user_id join public.documents d on d.id=l.document_id and d.user_id=l.user_id where l.id=${lessonId} and l.user_id=${userId}`;
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
  const chunks = chunksForStage(allChunks, stage).slice(0, 6),
    name = String(lesson.original_name || "source"),
    recent = stages
      .slice(Math.max(0, stageIndex - 2), stageIndex)
      .map((item) => ({
        title: item.title,
        content: item.content?.slice(-1800),
      }));
  const cacheKey = createHash("sha256").update(JSON.stringify({ documentId: lesson.document_id, version: lesson.source_version || 1, concept: stage.id, language: pref.teaching_language || pref.preferred_language || "it", depth: pref.explanation_depth || "adaptive" })).digest("hex");
  const cached = await db()`select content_json from public.professor_content_cache where cache_key=${cacheKey} and user_id=${userId} limit 1`;
  if (cached[0]) {
    stages[stageIndex] = { ...stage, ...cached[0].content_json, cached: true };
    return (await db()`update public.professor_lessons set stages_json=${JSON.stringify({ ...data, stages })}::jsonb,phase='verify',updated_at=now() where id=${lesson.id} and user_id=${userId} returning *`)[0];
  }
  const tier=chooseProfessorTier({kind:"teaching",concept:`${stage.title} ${stage.purpose}`,repeatedMisunderstandings:(lesson.stage_checks_json||[]).filter((x:any)=>Number(x.stageIndex)===stageIndex&&x.verdict==="needs_review").length});
  const generated = await (await professorProvider({ userId, documentId: String(lesson.document_id), sessionId: String(lesson.session_id), requestId: `professor-stage:${lesson.id}:${stage.id}:${lesson.outline_version}`,tier })).generate({
    mode: "tutor",
    schema: teachingSchema,
    allowedCitations: professorCitations(name, chunks),
    prompt: `Teach this concept naturally as one concise adaptive university teaching turn. Language: ${pref.teaching_language || pref.preferred_language || "it"}; level: ${pref.academic_level || pref.current_level || "beginner"}; style: ${pref.study_style || "mixed"}; depth: ${pref.explanation_depth || "adaptive"}. Concept: ${stage.title}. Purpose: ${stage.purpose}. Key terms: ${stage.keyTerms.join(", ")}. Use the source as curriculum, preserve exact technical details, highlight one exam-relevant trap or connection, and finish with one diagnostic comprehension question. Prefer 200-500 output tokens; do not use rigid Step 1/Step 2 formatting. Recent compact memory: ${JSON.stringify(compactRecentTurns(recent))}.`,
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
  await db()`insert into public.professor_content_cache(user_id,document_id,cache_key,concept_id,language,depth,source_version,content_json,provider,model) values(${userId},${lesson.document_id},${cacheKey},${lesson.current_concept_id || null},${pref.teaching_language || pref.preferred_language || "it"},${pref.explanation_depth || "adaptive"},${Number(lesson.source_version || 1)},${JSON.stringify({content:value.content,check:value.check,citations:value.citations,generatedAt:new Date().toISOString()})}::jsonb,${generated.provider},${generated.model}) on conflict(cache_key) do update set last_used_at=now()`;
  return (
    await db()`update public.professor_lessons set stages_json=${JSON.stringify({ ...data, stages })}::jsonb,phase='verify',provider=${generated.provider},model=${generated.model},input_tokens=input_tokens+${generated.usage.input_tokens},output_tokens=output_tokens+${generated.usage.output_tokens},updated_at=now() where id=${lesson.id} and user_id=${userId} returning *`
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
    const body = await request.json(), { taskId } = body,
      sql = db(),
      { item, chunks } = await ownedTask(userId, String(taskId));
    if (body.examProfile) {
      const exam = body.examProfile;
      await sql`insert into public.course_exam_profiles(user_id,document_id,exam_date,exam_format,confidence,available_study_days,professor_notes) values(${userId},${item.document_id},${exam.examDate || null},${String(exam.examFormat || "mixed")},${String(exam.confidence || "medium")},${Number(exam.availableStudyDays) || null},${String(exam.professorNotes || "").slice(0,4000) || null}) on conflict(user_id,document_id) do update set exam_date=excluded.exam_date,exam_format=excluded.exam_format,confidence=excluded.confidence,available_study_days=excluded.available_study_days,professor_notes=excluded.professor_notes,updated_at=now()`;
    }
    const existing =
      await sql`select l.*,d.original_name from public.professor_lessons l join public.documents d on d.id=l.document_id where l.user_id=${userId} and l.document_id=${item.document_id} and l.section_id=${item.section_id}`;
    if (existing[0] && Number(existing[0].outline_version || 1) >= 3) {
      let resumed=existing[0];
      if(!resumed.session_id){const session=await sql`insert into public.professor_sessions(user_id,document_id,lesson_id) values(${userId},${item.document_id},${resumed.id}) returning id`;resumed=(await sql`update public.professor_lessons set session_id=${session[0].id} where id=${resumed.id} returning *`)[0];}
      return NextResponse.json({ lesson: resumed, section: item });
    }
    // Version-one lessons were generated as one shallow response. Re-plan them once
    // from the full indexed section so existing production users receive the staged lesson.
    if (existing[0])
      await sql`delete from public.professor_lessons where id=${existing[0].id} and user_id=${userId}`;
    if (!chunks.length)
      return NextResponse.json(
        { error: "This indexed section has no readable source chunks" },
        { status: 409 },
      );
    const [profiles, course, exams] = await Promise.all([
      sql`select * from public.user_profiles where user_id=${userId}`,
      sql`select current_level,study_style,preferred_language from public.tutor_profiles where user_id=${userId} and document_id=${item.document_id}`,
      sql`select * from public.course_exam_profiles where user_id=${userId} and document_id=${item.document_id}`,
    ]);
    const pref = { ...profiles[0], ...course[0], ...exams[0] };
    language = String(
      pref.teaching_language || pref.preferred_language || "it",
    );
    const name = String(item.original_name);
    const session = await sql`insert into public.professor_sessions(user_id,document_id) values(${userId},${item.document_id}) returning id`;
    const sessionId=String(session[0].id);
    const generated = await (await professorProvider({ userId, documentId: String(item.document_id), sessionId, requestId: `professor-outline:${sessionId}:${item.index_version}`,tier:"economy" })).generate({
      mode: "tutor",
      schema: outlineSchema,
      allowedCitations: professorCitations(name, chunks),
      prompt: `Treat this indexed course section as curriculum and plan an adaptive exam-preparation lesson in ${language} for level ${pref.academic_level || pref.current_level || "beginner"}. Exam: ${pref.exam_format || pref.exam_style || "mixed"}; date: ${pref.exam_date || "unknown"}; confidence: ${pref.confidence || "medium"}. Build 4-10 high-yield concepts ordered by prerequisites and exam importance, each tied to exact CHUNK numbers. Include definitions, mechanisms, connections, traps, exact facts and likely exam demands. Outline only.`,
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
    const objectives = cleanStages.map((stage: any) => stage.purpose);
    const conceptMap = cleanStages.map((stage: any) => stage.title);
    const recap = cleanStages.map((stage: any) => `${stage.title}: ${stage.purpose}`);
    const masteryQuestions = cleanStages.map((stage: any) => ({
      question: `Spiega ${stage.title} e collegalo agli altri concetti della sezione.`,
      expected: stage.purpose,
      concept: stage.title,
    }));
    for (const stage of cleanStages) {
      const concept = await sql`insert into public.course_concepts(user_id,document_id,section_id,concept_key,title,prerequisites_json,key_facts_json,common_mistakes_json,chunk_indexes_json,page_start,page_end,exam_importance,hierarchy_json,confidence,method,source_version) values(${userId},${item.document_id},${item.section_id},${stage.id},${stage.title},'[]'::jsonb,${JSON.stringify(stage.keyTerms)}::jsonb,'[]'::jsonb,${JSON.stringify(stage.chunkIndexes)}::jsonb,${item.page_start},${item.page_end},${Math.max(1,5-Math.floor(cleanStages.indexOf(stage)/2))},${JSON.stringify({section:item.section_title,position:cleanStages.indexOf(stage)})}::jsonb,.9,'professor_outline',${Number(item.index_version)}) on conflict(user_id,document_id,concept_key,source_version) do update set title=excluded.title,chunk_indexes_json=excluded.chunk_indexes_json,updated_at=now() returning id`;
      stage.conceptId=String(concept[0].id);
    }
    const inserted =
      await sql`insert into public.professor_lessons(user_id,document_id,section_id,task_id,session_id,current_concept_id,phase,exam_mode,stages_json,mastery_questions_json,completed_stages_json,interactions_json,stage_checks_json,outline_version,provider,model,input_tokens,output_tokens) values(${userId},${item.document_id},${item.section_id},${item.id},${sessionId},${cleanStages[0]?.conceptId || null},'teach',${isNearExam(pref.exam_date)},${JSON.stringify({ title: value.title, objectives, conceptMap, stages: cleanStages, recap })}::jsonb,${JSON.stringify(masteryQuestions)}::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,4,${generated.provider},${generated.model},${generated.usage.input_tokens},${generated.usage.output_tokens}) on conflict(user_id,document_id,section_id) do nothing returning *`;
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
    await sql`update public.professor_sessions set lesson_id=${saved.id},last_activity_at=now() where id=${sessionId} and user_id=${userId}`;
    if(saved.current_concept_id) await sql`insert into public.student_concept_state(user_id,document_id,concept_id,state,last_seen_at) values(${userId},${item.document_id},${saved.current_concept_id},'learning',now()) on conflict(user_id,document_id,concept_id) do update set state='learning',last_seen_at=now(),updated_at=now()`;
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
    const advanceStage = async (forceSkip = false) => {
      const completed = [...new Set([...(lesson.completed_stages_json || []), stageIndex])], next = nextLessonState(stageIndex, stages.length), nextConceptId=stages[next.currentStage]?.conceptId || null;
      if(stage?.conceptId) await sql`insert into public.student_concept_state(user_id,document_id,concept_id,state,skipped,weak,force_skipped,last_seen_at) values(${userId},${lesson.document_id},${stage.conceptId},${forceSkip?'learning':'understood'},${forceSkip},${forceSkip},${forceSkip},now()) on conflict(user_id,document_id,concept_id) do update set state=excluded.state,skipped=excluded.skipped,weak=excluded.weak,force_skipped=excluded.force_skipped,last_seen_at=now(),updated_at=now()`;
      lesson=(await sql`update public.professor_lessons set current_stage=${next.currentStage},lesson_position=${next.currentStage},current_concept_id=${nextConceptId},phase=${next.status==='learning'?'teach':'exam_test'},status=${next.status},completed_stages_json=${JSON.stringify(completed)}::jsonb,updated_at=now() where id=${lesson.id} and user_id=${userId} returning *`)[0];
      if(next.status==='learning') lesson=await generateStage(userId,{...lesson,original_name:context.lesson.original_name,source_version:context.lesson.source_version},chunks,pref,next.currentStage);
      await sql`update public.study_plan_tasks set learning_status=${next.status === "doubt_clearing" ? "lesson_completed_mastery_pending" : "learning_in_progress"} where id=${lesson.task_id} and user_id=${userId}`;
      await sql`update public.professor_sessions set last_activity_at=now() where id=${lesson.session_id} and user_id=${userId}`;
      return lesson;
    };
    if (body.action === "skip") {
      if(!stage?.conceptId) return NextResponse.json({error:"Concept unavailable"},{status:409});
      await sql`insert into public.student_concept_state(user_id,document_id,concept_id,state,skipped,last_seen_at) values(${userId},${lesson.document_id},${stage.conceptId},'learning',true,now()) on conflict(user_id,document_id,concept_id) do update set skipped=true,last_seen_at=now(),updated_at=now()`;
      return NextResponse.json({lesson,quickVerification:{question:stage.check,seconds:15}});
    }
    if (body.action === "force_skip") return NextResponse.json({lesson:await advanceStage(true),forceSkipped:true});
    if (body.action === "stage") {
      const stageCheck=(lesson.stage_checks_json || []).find((check:any)=>Number(check.stageIndex)===stageIndex);
      if (stage && !stageCheck)
        return NextResponse.json(
          { error: "Answer the comprehension check before continuing." },
          { status: 409 },
        );
      if(stageCheck?.verdict==='needs_review') return NextResponse.json({error:"Professor detected a gap. Try the new explanation and verify again before continuing.",reteach:true},{status:409});
      return NextResponse.json({ lesson:await advanceStage(false) });
    }
    const adaptiveAction = ({explain_differently:"simpler",test_me:"deeper",exam_appearance:"why"} as Record<string,string>)[body.action] || body.action;
    if (isProfessorAction(adaptiveAction) && stage) {
      const relevant = chunksForStage(chunks, stage),
        name = String(context.lesson.original_name),
        recent = (lesson.interactions_json || [])
          .filter((x: any) => Number(x.stageIndex) === stageIndex)
          .slice(-4);
      const expansionTier=chooseProfessorTier({kind:"teaching",concept:`${stage.title} ${stage.purpose}`,repeatedMisunderstandings:recent.filter((x:any)=>x.action==="explain_differently").length,forceAdvanced:body.action==="deeper"});
      const generated = await (await professorProvider({userId,documentId:String(lesson.document_id),sessionId:String(lesson.session_id),requestId:`professor-expansion:${lesson.id}:${stageIndex}:${String(body.action)}:${lesson.interactions_json?.length||0}`,tier:expansionTier})).generate({
        mode: "tutor",
        schema: expansionSchema,
        allowedCitations: professorCitations(name, relevant),
        prompt: `${body.action==='test_me'?'Ask one exam-style question without revealing its answer.':body.action==='exam_appearance'?'Show how this concept could appear on the configured exam, including one common trap.':actionInstruction(adaptiveAction as any)} Respond in ${pref.teaching_language || pref.preferred_language || "it"}. Keep this turn concise and change strategy when re-teaching. Concept “${stage.title}”. CORE: ${String(stage.content || "").slice(0,1600)}. RECENT: ${JSON.stringify(compactRecentTurns(recent))}.`,
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
        generated = await (await professorProvider({userId,documentId:String(lesson.document_id),sessionId:String(lesson.session_id),requestId:`professor-verify:${lesson.id}:${stageIndex}:${lesson.stage_checks_json?.length||0}`,tier:chooseProfessorTier({kind:"classification",concept:stage.title,repeatedMisunderstandings:(lesson.stage_checks_json||[]).filter((x:any)=>x.verdict==="needs_review").length})})).generate({
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
      if(stage.conceptId){const passed=value.verdict!=="needs_review",outcome={question:stage.check,answer,verdict:value.verdict,at:new Date().toISOString()};await sql`insert into public.student_concept_state(user_id,document_id,concept_id,state,weak,misconceptions_json,recent_mistakes_json,verification_outcomes_json,last_seen_at) values(${userId},${lesson.document_id},${stage.conceptId},${passed?'understood':'learning'},${!passed},${JSON.stringify(passed?[]:[value.correction])}::jsonb,${JSON.stringify(passed?[]:[answer])}::jsonb,${JSON.stringify([outcome])}::jsonb,now()) on conflict(user_id,document_id,concept_id) do update set state=excluded.state,weak=excluded.weak,misconceptions_json=case when excluded.weak then public.student_concept_state.misconceptions_json||excluded.misconceptions_json else public.student_concept_state.misconceptions_json end,recent_mistakes_json=case when excluded.weak then public.student_concept_state.recent_mistakes_json||excluded.recent_mistakes_json else public.student_concept_state.recent_mistakes_json end,verification_outcomes_json=public.student_concept_state.verification_outcomes_json||excluded.verification_outcomes_json,last_seen_at=now(),updated_at=now()`;}
      lesson = (
        await sql`update public.professor_lessons set stage_checks_json=${JSON.stringify(checks)}::jsonb,phase=${value.verdict==='needs_review'?'reteach':'connect'},recent_turns_json=${JSON.stringify(compactRecentTurns([...(lesson.recent_turns_json||[]),{role:'student',phase:'verify',text:answer},{role:'professor',phase:value.verdict==='needs_review'?'reteach':'connect',text:value.feedback}]))}::jsonb,provider=${generated.provider},model=${generated.model},input_tokens=input_tokens+${generated.usage.input_tokens},output_tokens=output_tokens+${generated.usage.output_tokens},updated_at=now() where id=${lesson.id} and user_id=${userId} returning *`
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
      const generated = await (await professorProvider({userId,documentId:String(lesson.document_id),sessionId:String(lesson.session_id),requestId:`professor-doubt:${lesson.id}:${lesson.doubts_json?.length||0}`,tier:chooseProfessorTier({kind:"teaching",concept:question,repeatedMisunderstandings:(lesson.doubts_json||[]).length})})).generate({
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
      const assessment = await (await professorProvider({userId,documentId:String(lesson.document_id),sessionId:String(lesson.session_id),requestId:`professor-mastery:${lesson.id}:${lesson.mastery_score===null?0:1}`,tier:chooseProfessorTier({kind:"exam",concept:questions.map((x:any)=>x.concept).join(" "),repeatedMisunderstandings:(lesson.stage_checks_json||[]).filter((x:any)=>x.verdict==="needs_review").length})})).generate({
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
        conceptState=learningStateForScore(score,true),
        status = score >= 75 ? "mastered" : "needs_review";
      await sql`update public.professor_lessons set mastery_score=${score},status=${status},provider=${assessment.provider},model=${assessment.model},input_tokens=input_tokens+${assessment.usage.input_tokens},output_tokens=output_tokens+${assessment.usage.output_tokens},updated_at=now() where id=${lesson.id} and user_id=${userId}`;
      await sql`update public.study_plan_tasks set learning_status=${status},status=${status === "mastered" ? "completed" : "planned"},score=${score},completed_at=${status === "mastered" ? new Date().toISOString() : null} where id=${lesson.task_id} and user_id=${userId}`;
      await sql`insert into public.section_mastery(user_id,document_id,section_id,questions_answered,question_accuracy,confidence,updated_at) values(${userId},${lesson.document_id},${lesson.section_id},${questions.length},${score},${score},now()) on conflict(user_id,document_id,section_id) do update set questions_answered=excluded.questions_answered,question_accuracy=excluded.question_accuracy,confidence=excluded.confidence,updated_at=now()`;
      for (const weak of result.weakConcepts || [])
        await sql`insert into public.weak_concepts(user_id,document_id,section_id,concept,evidence) values(${userId},${lesson.document_id},${lesson.section_id},${String(weak.concept)},${String(weak.evidence)})`;
      await sql`update public.student_concept_state set state=${conceptState},weak=${score<75},mastery_score=${score},updated_at=now() where user_id=${userId} and document_id=${lesson.document_id} and concept_id in(select id from public.course_concepts where section_id=${lesson.section_id} and user_id=${userId})`;
      await sql`update public.professor_sessions set status=${status==='mastered'?'completed':'needs_review'},last_activity_at=now(),ended_at=${status==='mastered'?new Date().toISOString():null} where id=${lesson.session_id} and user_id=${userId}`;
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
