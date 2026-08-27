import { NextResponse } from "next/server";
import { db, ensureStudySchema } from "@/lib-db";
import { currentUserId } from "@/lib-user";

export const runtime = "nodejs";
type Setup={documentId:string;target:string;deadline:string;hoursPerDay:number;currentLevel:string;studyStyle:string;preferredLanguage:string;studiedSectionIds?:string[];weakSectionIds?:string[];unavailableDates?:string[];reason?:string};
const iso=(date:Date)=>date.toISOString().slice(0,10);

async function snapshot(userId:string,documentId:string){
  const sql=db();
  const profiles=await sql`select * from public.tutor_profiles where user_id=${userId} and document_id=${documentId} limit 1`;
  const plans=await sql`select * from public.study_plans where user_id=${userId} and document_id=${documentId} and status='active' order by version desc limit 1`;
  const plan=plans[0]||null;
  const tasks=plan?await sql`select t.*,s.title as section_title,s.page_start,s.page_end from public.study_plan_tasks t left join public.document_sections s on s.id=t.section_id and s.user_id=t.user_id where t.plan_id=${plan.id} and t.user_id=${userId} order by t.task_date,t.order_index`:[];
  const mastery=await sql`select m.*,s.title as section_title from public.section_mastery m join public.document_sections s on s.id=m.section_id where m.user_id=${userId} and m.document_id=${documentId} order by coalesce(m.question_accuracy,m.recall_accuracy,m.confidence,0),s.order_index`;
  const completed=tasks.filter(t=>t.status==='completed').length,total=tasks.length,minutes=tasks.reduce((n,t)=>n+Number(t.estimated_minutes||0),0),doneMinutes=tasks.filter(t=>t.status==='completed').reduce((n,t)=>n+Number(t.actual_minutes||t.estimated_minutes||0),0);
  const today=iso(new Date()),due=tasks.filter(t=>String(t.task_date).slice(0,10)<=today).length,dueDone=tasks.filter(t=>t.status==='completed'&&String(t.task_date).slice(0,10)<=today).length;
  return{profile:profiles[0]||null,plan,tasks,mastery,metrics:{completion:total?Math.round(completed/total*100):0,plannedMinutes:minutes,completedMinutes:doneMinutes,status:dueDone<due?'behind':completed===total&&total?'complete':'on-track',readiness:total?Math.round((completed/total*70)+(mastery.length?mastery.reduce((n,m)=>n+Number(m.question_accuracy??m.recall_accuracy??m.confidence??0),0)/mastery.length*.3:0)):0}};
}

export async function GET(request:Request){
  await ensureStudySchema();const userId=await currentUserId();if(!userId)return NextResponse.json({error:"Unauthorized"},{status:401});
  const documentId=new URL(request.url).searchParams.get("documentId")||"";if(!documentId)return NextResponse.json({error:"documentId is required"},{status:400});
  return NextResponse.json(await snapshot(userId,documentId));
}

export async function POST(request:Request){
  await ensureStudySchema();const userId=await currentUserId();if(!userId)return NextResponse.json({error:"Unauthorized"},{status:401});const body=await request.json() as Setup;
  if(!body.documentId||!body.target||!body.deadline||!body.hoursPerDay||!body.currentLevel)return NextResponse.json({error:"Complete the study setup first"},{status:400});
  const deadline=new Date(`${body.deadline}T12:00:00`);if(!Number.isFinite(deadline.getTime())||deadline<new Date())return NextResponse.json({error:"Choose a future deadline"},{status:400});
  const sql=db();const docs=await sql`select id from public.documents where id=${body.documentId} and user_id=${userId} and processing_status='ready'`;if(!docs.length)return NextResponse.json({error:"Document not found or not ready"},{status:404});
  const profiles=await sql`insert into public.tutor_profiles(user_id,document_id,target,deadline,hours_per_day,current_level,studied_section_ids,weak_section_ids,study_style,preferred_language,unavailable_dates,updated_at)values(${userId},${body.documentId},${body.target},${body.deadline},${body.hoursPerDay},${body.currentLevel},${JSON.stringify(body.studiedSectionIds||[])}::jsonb,${JSON.stringify(body.weakSectionIds||[])}::jsonb,${body.studyStyle||'mixed'},${body.preferredLanguage||'it'},${JSON.stringify(body.unavailableDates||[])}::jsonb,now()) on conflict(user_id,document_id) do update set target=excluded.target,deadline=excluded.deadline,hours_per_day=excluded.hours_per_day,current_level=excluded.current_level,studied_section_ids=excluded.studied_section_ids,weak_section_ids=excluded.weak_section_ids,study_style=excluded.study_style,preferred_language=excluded.preferred_language,unavailable_dates=excluded.unavailable_dates,updated_at=now() returning *`;
  const profile=profiles[0];const versions=await sql`select coalesce(max(version),0)::int+1 as version from public.study_plans where user_id=${userId} and document_id=${body.documentId}`;await sql`update public.study_plans set status='superseded',updated_at=now() where user_id=${userId} and document_id=${body.documentId} and status='active'`;
  const plans=await sql`insert into public.study_plans(user_id,document_id,profile_id,version,reason)values(${userId},${body.documentId},${profile.id},${versions[0].version},${body.reason||'Initial plan'})returning *`;const plan=plans[0];
  const sections=await sql`select id,title,page_start,page_end,order_index from public.document_sections where user_id=${userId} and document_id=${body.documentId} and level in (1,2) order by order_index`;
  const studied=new Set(body.studiedSectionIds||[]),unavailable=new Set(body.unavailableDates||[]),daily=Math.max(30,Math.round(Number(body.hoursPerDay)*60));let cursor=new Date();cursor.setHours(12,0,0,0);let used=0,order=0;
  const nextDay=()=>{do{cursor.setDate(cursor.getDate()+1)}while(unavailable.has(iso(cursor)));used=0};
  for(const section of sections){if(studied.has(String(section.id)))continue;const pages=Math.max(1,Number(section.page_end)-Number(section.page_start)+1);const estimate=Math.min(daily,Math.max(25,pages*6));if(used+estimate>daily)nextDay();if(cursor>deadline)cursor=new Date(deadline);await sql`insert into public.study_plan_tasks(plan_id,user_id,document_id,section_id,task_date,task_type,title,estimated_minutes,order_index)values(${plan.id},${userId},${body.documentId},${section.id},${iso(cursor)},'study',${`Study · ${section.title}`},${estimate},${order++})`;used+=estimate;
    if(order%3===0){if(used+20>daily)nextDay();await sql`insert into public.study_plan_tasks(plan_id,user_id,document_id,section_id,task_date,task_type,title,estimated_minutes,order_index)values(${plan.id},${userId},${body.documentId},${section.id},${iso(cursor)},'active_recall',${`Active recall · ${section.title}`},20,${order++})`;used+=20;}
  }
  const finalDate=new Date(deadline);for(const [offset,type,title] of [[-3,'review','Spaced review'],[-2,'simulation','Exam simulation'],[-1,'buffer','Buffer and weak-topic review']] as const){const d=new Date(finalDate);d.setDate(d.getDate()+offset);await sql`insert into public.study_plan_tasks(plan_id,user_id,document_id,task_date,task_type,title,estimated_minutes,order_index)values(${plan.id},${userId},${body.documentId},${iso(d)},${type},${title},${Math.min(daily,60)},${order++})`;}
  return NextResponse.json(await snapshot(userId,body.documentId));
}

export async function PATCH(request:Request){
  await ensureStudySchema();const userId=await currentUserId();if(!userId)return NextResponse.json({error:"Unauthorized"},{status:401});const body=await request.json();
  if(!body.taskId)return NextResponse.json({error:"taskId is required"},{status:400});const sql=db();const rows=await sql`update public.study_plan_tasks set status=${body.completed?'completed':'planned'},actual_minutes=${Math.max(0,Number(body.actualMinutes||0))},score=${body.score??null},completed_at=${body.completed?new Date().toISOString():null} where id=${String(body.taskId)} and user_id=${userId} returning document_id,section_id,actual_minutes,score`;
  if(!rows.length)return NextResponse.json({error:"Task not found"},{status:404});const row=rows[0];if(body.completed&&row.section_id)await sql`insert into public.section_mastery(user_id,document_id,section_id,study_seconds,confidence,updated_at)values(${userId},${row.document_id},${row.section_id},${Number(row.actual_minutes)*60},${row.score??null},now()) on conflict(user_id,document_id,section_id) do update set study_seconds=public.section_mastery.study_seconds+excluded.study_seconds,confidence=coalesce(excluded.confidence,public.section_mastery.confidence),updated_at=now()`;
  return NextResponse.json(await snapshot(userId,String(row.document_id)));
}
