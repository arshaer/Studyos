import { NextResponse } from "next/server";
import { db, ensureStudySchema } from "@/lib-db";
import { currentUserId } from "@/lib-user";

export const runtime="nodejs";
export async function GET(request:Request){
  const userId=await currentUserId();if(!userId)return NextResponse.json({error:"Unauthorized"},{status:401});await ensureStudySchema();
  const documentId=new URL(request.url).searchParams.get("documentId")||"";const sql=db();
  const documents=await sql`select id,title,page_count,index_confidence,index_version,processing_status from public.documents where id=${documentId} and user_id=${userId} limit 1`;
  if(!documents[0])return NextResponse.json({error:"Document not found"},{status:404});
  const sections=await sql`select id,parent_id,kind,level,title,order_index,page_start,page_end,confidence,source,detection_method,confidence_reason from public.document_sections where document_id=${documentId} and user_id=${userId} order by order_index`;
  return NextResponse.json({document:documents[0],sections});
}
export async function PATCH(request:Request){
  const userId=await currentUserId();if(!userId)return NextResponse.json({error:"Unauthorized"},{status:401});await ensureStudySchema();const body=await request.json(),documentId=String(body?.documentId||""),sql=db();
  const owned=await sql`select id from public.documents where id=${documentId} and user_id=${userId}`;if(!owned[0])return NextResponse.json({error:"Document not found"},{status:404});
  if(body.action==="rename"){const title=String(body.title||"").trim().slice(0,180);if(!title)return NextResponse.json({error:"Title is required"},{status:400});await sql`update public.document_sections set title=${title},updated_at=now() where id=${String(body.sectionId)} and document_id=${documentId} and user_id=${userId}`;await sql`update public.document_chunks set section=${title} where section_id=${String(body.sectionId)} and document_id=${documentId} and user_id=${userId}`;}
  else if(body.action==="reorder"){const ids=Array.isArray(body.sectionIds)?body.sectionIds.map(String):[];for(let index=0;index<ids.length;index++)await sql`update public.document_sections set order_index=${100000+index},updated_at=now() where id=${ids[index]} and document_id=${documentId} and user_id=${userId}`;for(let index=0;index<ids.length;index++)await sql`update public.document_sections set order_index=${index},updated_at=now() where id=${ids[index]} and document_id=${documentId} and user_id=${userId}`;}
  else return NextResponse.json({error:"Unsupported index edit"},{status:400});
  await sql`update public.documents set index_version=index_version+1,updated_at=now() where id=${documentId} and user_id=${userId}`;return NextResponse.json({ok:true});
}
