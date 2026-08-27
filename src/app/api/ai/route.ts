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
type Scope={type:"entire"|"sections"|"pages";sectionIds?:string[];pageStart?:number;pageEnd?:number};

function schemaFor(mode: AiMode) {
  if (mode === "flashcards") return { type: "object", properties: { title: { type: "string", description: "Short deck title in the learner's language" }, items: { type: "array", minItems: 10, maxItems: 10, items: { type: "object", properties: { front: { type: "string" }, back: { type: "string" }, citation: { type: "string", description: "One exact SOURCE label supplied in the context" } }, required: ["front", "back", "citation"], additionalProperties: false } } }, required: ["title", "items"], additionalProperties: false };
  if (mode === "questions") return { type: "object", properties: { title: { type: "string" }, items: { type: "array", minItems: 8, maxItems: 8, items: { type: "object", properties: { question: { type: "string" }, options: { type: "array", minItems: 4, maxItems: 4, items: { type: "string" } }, answer: { type: "string", description: "Must exactly equal one of the four options" }, explanation: { type: "string" }, citation: { type: "string", description: "One exact SOURCE label supplied in the context" } }, required: ["question", "options", "answer", "explanation", "citation"], additionalProperties: false } } }, required: ["title", "items"], additionalProperties: false };
  if(mode === "tutor") return { type:"object", properties:{ title:{type:"string"}, explanation:{type:"string"}, definitions:{type:"array",items:{type:"object",properties:{term:{type:"string"},definition:{type:"string"}},required:["term","definition"],additionalProperties:false}}, steps:{type:"array",items:{type:"string"}}, keyPoints:{type:"array",items:{type:"string"}}, examples:{type:"array",items:{type:"string"}}, examCallouts:{type:"array",items:{type:"string"}}, tables:{type:"array",items:{type:"object",properties:{title:{type:"string"},headers:{type:"array",items:{type:"string"}},rows:{type:"array",items:{type:"array",items:{type:"string"}}}},required:["title","headers","rows"],additionalProperties:false}}, citations:{type:"array",items:{type:"string"}}, followUps:{type:"array",items:{type:"string"}} }, required:["title","explanation","definitions","steps","keyPoints","examples","examCallouts","tables","citations","followUps"], additionalProperties:false };
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
  let generationId = "";
  try {
    userId = await currentUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const body = await request.json();
    const mode = String(body?.mode || "tutor") as AiMode;
    documentId = String(body?.documentId || "").trim();
    const prompt = String(body?.prompt || "").trim().slice(0, 4000);
    let conversationId=String(body?.conversationId||"");
    const scope=(body?.scope||{}) as Scope;
    const detailLevel=String(body?.detailLevel||"").slice(0,30)||null;
    const language=String(body?.language||"").slice(0,20)||null;
    const scopeKey=JSON.stringify(scope.type==="sections"?{type:"sections",sectionIds:[...(scope.sectionIds||[])].map(String).sort()}:scope.type==="pages"?{type:"pages",pageStart:Number(scope.pageStart),pageEnd:Number(scope.pageEnd)}:{type:"entire"});
    if(!["entire","sections","pages"].includes(scope.type))return NextResponse.json({error:"Choose a valid document scope"},{status:400});
    if(scope.type==="sections"&&(!Array.isArray(scope.sectionIds)||!scope.sectionIds.length))return NextResponse.json({error:"Choose at least one indexed section"},{status:400});
    if(scope.type==="pages"&&(!(Number(scope.pageStart)>0)||Number(scope.pageEnd)<Number(scope.pageStart)))return NextResponse.json({error:"Choose a valid page range"},{status:400});
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
    if(mode==="tutor"){
      if(conversationId){const owned=await sql`select id from public.ai_conversations where id=${conversationId} and user_id=${userId} and document_id=${documentId}`;if(!owned[0])return NextResponse.json({error:"Tutor conversation not found"},{status:404});await sql`update public.ai_conversations set scope_json=${JSON.stringify(scope)}::jsonb,updated_at=now() where id=${conversationId} and user_id=${userId}`}
      else{const created=await sql`insert into public.ai_conversations(user_id,document_id,title,scope_json)values(${userId},${documentId},${prompt.slice(0,90)},${JSON.stringify(scope)}::jsonb)returning id`;conversationId=String(created[0].id)}
      await sql`insert into public.ai_messages(conversation_id,user_id,role,content_json,status)values(${conversationId},${userId},'user',${JSON.stringify({text:prompt})}::jsonb,'completed')`;
    }

    let sectionIds:string[]=[];
    if(scope.type==="sections"){
      const selected=scope.sectionIds!.map(String);
      const rows=await sql`with recursive tree as (select id from public.document_sections where document_id=${documentId} and user_id=${userId} and id=any(${selected}::uuid[]) union all select s.id from public.document_sections s join tree t on s.parent_id=t.id where s.document_id=${documentId} and s.user_id=${userId}) select distinct id from tree`;
      sectionIds=rows.map(row=>String(row.id));if(!sectionIds.length)return NextResponse.json({error:"Selected sections were not found"},{status:404});
    }
    const allChunks=scope.type==="entire"
      ? await sql`select chunk_index,content,page_start,page_end,section,section_id,char_start,char_end from public.document_chunks where document_id=${documentId} and user_id=${userId} order by chunk_index`
      : scope.type==="sections"
        ? await sql`select chunk_index,content,page_start,page_end,section,section_id,char_start,char_end from public.document_chunks where document_id=${documentId} and user_id=${userId} and section_id=any(${sectionIds}::uuid[]) order by chunk_index`
        : await sql`select chunk_index,content,page_start,page_end,section,section_id,char_start,char_end from public.document_chunks where document_id=${documentId} and user_id=${userId} and page_start<=${Number(scope.pageEnd)} and page_end>=${Number(scope.pageStart)} order by chunk_index`;
    let chunkRows=allChunks;
    if(mode!=="summary"&&prompt&&allChunks.length>CONTEXT_CHUNKS){
      const allowed=(allChunks as Array<{chunk_index:number}>).map(row=>row.chunk_index);
      chunkRows=await sql`select chunk_index,content,page_start,page_end,section,section_id,char_start,char_end from public.document_chunks where document_id=${documentId} and user_id=${userId} and chunk_index=any(${allowed}::int[]) order by ts_rank_cd(to_tsvector('simple',content),plainto_tsquery('simple',${prompt})) desc,chunk_index limit ${CONTEXT_CHUNKS}`;
    }
    if (!chunkRows.length) {
      const { processDocument } = await import("@/lib-document-processing");
      await sql`update public.documents set processing_status='processing', processing_error=null, updated_at=now() where id=${documentId} and user_id=${userId}`;
      await processDocument(documentId, userId);
      return NextResponse.json({error:"The document index was rebuilt. Choose the scope again."},{status:409});
    }
    const chunks = chunkRows as unknown as StoredChunk[];
    if (!chunks.length) throw new Error("The document contains no readable text.");
    const name = String(document.original_name);
    let effectivePrompt=prompt;
    if(mode==="tutor"&&conversationId){const history=await sql`select role,content_json from public.ai_messages where conversation_id=${conversationId} and user_id=${userId} order by created_at desc limit 12`;effectivePrompt=`Answer the newest question in the same language it was asked. Preserve conversation continuity.\n\nConversation (oldest to newest):\n${history.reverse().map(row=>`${row.role}: ${JSON.stringify(row.content_json)}`).join("\n")}\n\nNewest question: ${prompt}`}
    const provider=configuredAiProvider();
    const versionRows=mode==="summary"?await sql`select coalesce(max(version),0)::int+1 as version from public.ai_generations where user_id=${userId} and document_id=${documentId} and mode='summary' and scope_key=${scopeKey}`:[{version:1}];
    const pending=await sql`insert into public.ai_generations(user_id,document_id,mode,provider,model,prompt,response_json,input_tokens,output_tokens,scope_json,scope_key,version,language,detail_level,status,conversation_id)values(${userId},${documentId},${mode},${provider.name},${provider.model},${prompt},'{}'::jsonb,0,0,${JSON.stringify(scope)}::jsonb,${scopeKey},${versionRows[0].version},${language},${detailLevel},'generating',${conversationId||null})returning id`;
    generationId=String(pending[0].id);
    const generation = mode === "summary"
      ? await hierarchicalSummary(name, chunks, prompt)
      : await provider.generate({ mode, prompt:effectivePrompt, schema: schemaFor(mode), allowedCitations: citationLabels(name, chunks), source: { mimeType: "text/plain", name, text: chunkContext(name, chunks) } });
    await sql`update public.ai_generations set provider=${generation.provider},model=${generation.model},response_json=${JSON.stringify(generation.result)}::jsonb,input_tokens=${generation.usage.input_tokens},output_tokens=${generation.usage.output_tokens},status='completed',completed_at=now(),updated_at=now() where id=${generationId} and user_id=${userId}`;
    if(mode==="tutor"&&conversationId){const citations=Array.isArray(generation.result.citations)?generation.result.citations:[];await sql`insert into public.ai_messages(conversation_id,user_id,role,content_json,citations_json,provider,model,input_tokens,output_tokens,status)values(${conversationId},${userId},'assistant',${JSON.stringify(generation.result)}::jsonb,${JSON.stringify(citations)}::jsonb,${generation.provider},${generation.model},${generation.usage.input_tokens},${generation.usage.output_tokens},'completed')`;await sql`update public.ai_conversations set provider=${generation.provider},model=${generation.model},updated_at=now() where id=${conversationId} and user_id=${userId}`}
    await sql`update public.documents set ai_status='completed', ai_error=null, updated_at=now() where id=${documentId} and user_id=${userId}`;
    return NextResponse.json({ result: generation.result, usage: generation.usage, remainingToday: DAILY_LIMIT - usedToday - 1,conversationId,generationId });
  } catch (error) {
    console.error("AI generation", error);
    const message = error instanceof Error ? error.message : "AI generation failed";
    if(userId&&generationId){try{const sql=db();await sql`update public.ai_generations set status='error',response_json=${JSON.stringify({error:message})}::jsonb,updated_at=now() where id=${generationId} and user_id=${userId}`}catch{}}
    if (userId && documentId) {
      try { const sql = db(); await sql`update public.documents set ai_status='error', ai_error=${message}, updated_at=now() where id=${documentId} and user_id=${userId}`; }
      catch (statusError) { console.error("AI status update", statusError); }
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(request:Request){
  const userId=await currentUserId();if(!userId)return NextResponse.json({error:"Unauthorized"},{status:401});await ensureStudySchema();const sql=db(),url=new URL(request.url),conversationId=url.searchParams.get("conversationId"),mode=url.searchParams.get("mode"),documentId=url.searchParams.get("documentId"),scopeKey=url.searchParams.get("scopeKey");
  if(conversationId){const conversations=await sql`select id,document_id,title,scope_json,provider,model,created_at,updated_at from public.ai_conversations where id=${conversationId} and user_id=${userId}`;if(!conversations[0])return NextResponse.json({error:"Conversation not found"},{status:404});const messages=await sql`select id,role,content_json,citations_json,provider,model,input_tokens,output_tokens,status,created_at from public.ai_messages where conversation_id=${conversationId} and user_id=${userId} order by created_at`;return NextResponse.json({conversation:conversations[0],messages})}
  const conversations=await sql`select c.id,c.document_id,c.title,c.scope_json,c.provider,c.model,c.created_at,c.updated_at,d.title as document_title from public.ai_conversations c join public.documents d on d.id=c.document_id and d.user_id=c.user_id where c.user_id=${userId} order by c.updated_at desc limit 30`;
  const artifacts=mode&&documentId?await sql`select g.id,g.document_id,g.mode,g.provider,g.model,g.response_json,g.scope_json,g.scope_key,g.version,g.language,g.detail_level,g.input_tokens,g.output_tokens,g.status,g.created_at,g.completed_at,d.title as document_title from public.ai_generations g join public.documents d on d.id=g.document_id and d.user_id=g.user_id where g.user_id=${userId} and g.document_id=${documentId} and g.mode=${mode} and (${scopeKey}::text is null or g.scope_key=${scopeKey}) and g.status='completed' order by g.created_at desc limit 50`:await sql`select g.id,g.document_id,g.mode,g.provider,g.model,g.response_json,g.scope_json,g.scope_key,g.version,g.language,g.detail_level,g.input_tokens,g.output_tokens,g.status,g.created_at,g.completed_at,d.title as document_title from public.ai_generations g left join public.documents d on d.id=g.document_id and d.user_id=g.user_id where g.user_id=${userId} and g.mode<>'tutor' order by g.created_at desc limit 50`;
  return NextResponse.json({conversations,artifacts});
}
