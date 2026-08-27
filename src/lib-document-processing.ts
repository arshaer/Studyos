import { randomUUID } from "node:crypto";
import { get } from "@vercel/blob";
import { OfficeParser } from "officeparser";
import { db } from "@/lib-db";

const CHUNK_CHARACTERS = 6_000;
const CHUNK_OVERLAP = 300;
export type StoredChunk = { chunk_index: number; content: string; page_start: number|null; page_end: number|null; section: string|null; section_id?: string|null; char_start?: number|null; char_end?: number|null };
type Heading={title:string;page:number;level:number;confidence:number;source:"outline"|"toc"|"layout"|"neutral";confidenceReason?:string};
type Page={pageNumber:number;text:string;charStart:number;charEnd:number;headings:Heading[]};
type Section=Heading&{id:string;parentId:string|null;orderIndex:number;pageEnd:number;charStart:number;charEnd:number};

function clean(value:string){return value.replace(/\u0000/g,"").replace(/[ \t]+\n/g,"\n").replace(/\n{3,}/g,"\n\n").trim()}
function median(values:number[]){const sorted=[...values].sort((a,b)=>a-b);return sorted.length?sorted[Math.floor(sorted.length/2)]:0}
export function inferHeading(line:string,height:number,bodyHeight:number,page:number):Heading|null{
  const title=clean(line).slice(0,180);
  if(title.length<3||title.length>180||/[.!?;:]$/.test(title)||title.split(/\s+/).length>18)return null;
  const numbered=title.match(/^(\d+(?:\.\d+){0,3})[.)]?\s+\S/);
  const chapter=/^(chapter|capitolo|unità|unit|part|parte|sezione|section)\s+[\divxlc]+\b/i.test(title);
  const uppercase=title.length<90&&title===title.toUpperCase()&&/[A-ZÀ-ÖØ-Þ]{3}/.test(title);
  const large=bodyHeight>0&&height>=bodyHeight*1.22;
  const hierarchicalNumber=Boolean(numbered&&numbered[1].includes("."));
  if(!chapter&&!uppercase&&!large&&!hierarchicalNumber)return null;
  const level=numbered?numbered[1].split(".").length:(chapter||height>=bodyHeight*1.7?1:height>=bodyHeight*1.4?2:3);
  return{title,page,level:Math.min(4,level),confidence:numbered||chapter ? .92 : large&&uppercase ? .84 : large ? .72 : .64,source:"layout",confidenceReason:numbered?"hierarchical numbering":chapter?"chapter keyword":large&&uppercase?"large uppercase layout":"font-size layout"};
}
async function outlineHeadings(pdf:any):Promise<Heading[]>{
  const outline=await pdf.getOutline?.();if(!Array.isArray(outline))return[];const result:Heading[]=[];
  const visit=async(items:any[],level:number)=>{for(const item of items){let destination=item.dest;if(typeof destination==="string")destination=await pdf.getDestination(destination);let page=1;if(Array.isArray(destination)&&destination[0])try{page=(await pdf.getPageIndex(destination[0]))+1}catch{}const title=clean(String(item.title||""));if(title)result.push({title:title.slice(0,180),page,level:Math.min(4,level),confidence:.99,source:"outline",confidenceReason:"embedded PDF bookmark"});if(Array.isArray(item.items))await visit(item.items,level+1)}};
  await visit(outline,1);return result;
}
function tocHeadings(pages:Page[]):Heading[]{
  const candidates:Heading[]=[];
  for(const page of pages.slice(0,Math.min(24,pages.length))){
    const lines=page.text.split("\n");
    const tocLike=lines.filter(line=>/^(.*?)\s*(?:\.{2,}|\s{2,})(\d{1,4})\s*$/.test(line));
    if(tocLike.length<4)continue;
    for(const line of tocLike){const match=line.match(/^(.*?)\s*(?:\.{2,}|\s{2,})(\d{1,4})\s*$/);if(!match)continue;const title=clean(match[1]),target=Number(match[2]);if(title.length<3||target<1||target>pages.length)continue;const numbering=title.match(/^(\d+(?:\.\d+)*)\s+/);candidates.push({title:title.slice(0,180),page:target,level:numbering?Math.min(4,numbering[1].split(".").length):1,confidence:.9,source:"toc",confidenceReason:"repeated TOC title/page pattern"})}
  }
  return candidates;
}
function stripRepeatedMargins(pages:Page[]){
  const counts=new Map<string,number>();
  for(const page of pages)for(const line of [...page.text.split("\n").slice(0,2),...page.text.split("\n").slice(-2)]){const key=clean(line).toLowerCase();if(key.length>2)counts.set(key,(counts.get(key)||0)+1)}
  const repeated=new Set([...counts].filter(([,count])=>count>=Math.max(3,Math.ceil(pages.length*.35))).map(([line])=>line));
  if(!repeated.size)return pages;
  return pages.map(page=>({...page,text:clean(page.text.split("\n").filter(line=>!repeated.has(clean(line).toLowerCase())).join("\n")),headings:page.headings.filter(heading=>!repeated.has(heading.title.toLowerCase()))}));
}
function rebasePages(pages:Page[]){let cursor=0;return pages.map(page=>{const charStart=cursor,charEnd=charStart+page.text.length;cursor=charEnd+1;return{...page,charStart,charEnd}})}
async function extractPdf(bytes:Uint8Array):Promise<{pages:Page[];outline:Heading[]}>{
  const{getDocumentProxy}=await import("unpdf");const pdf=await getDocumentProxy(bytes,{disableFontFace:true,useSystemFonts:false,maxImageSize:16_777_216});const pages:Page[]=[];let cursor=0;
  try{const outline=await outlineHeadings(pdf);for(let pageNumber=1;pageNumber<=pdf.numPages;pageNumber++){const page=await pdf.getPage(pageNumber);try{const content=await page.getTextContent();const items=content.items.filter((item:any)=>typeof item.str==="string"&&item.str.trim());const bodyHeight=median(items.map((item:any)=>Math.abs(Number(item.height||item.transform?.[3]||0))).filter(Boolean));const lines:{text:string;height:number;y:number}[]=[];for(const item of items as any[]){const y=Math.round(Number(item.transform?.[5]||0)),value=String(item.str).trim(),existing=lines.find(line=>Math.abs(line.y-y)<=2);if(existing){existing.text+=`${existing.text?" ":""}${value}`;existing.height=Math.max(existing.height,Number(item.height||item.transform?.[3]||0))}else lines.push({text:value,height:Number(item.height||item.transform?.[3]||0),y})}lines.sort((a,b)=>b.y-a.y);const text=clean(lines.map(line=>line.text).join("\n")),charStart=cursor,charEnd=cursor+text.length;pages.push({pageNumber,text,charStart,charEnd,headings:lines.map(line=>inferHeading(line.text,line.height,bodyHeight,pageNumber)).filter(Boolean) as Heading[]});cursor=charEnd+1}finally{page.cleanup()}}return{pages,outline}}finally{await pdf.cleanup()}
}
function textPages(text:string){let cursor=0;return clean(text).split(/\f|\n\s*---\s*\n/).map((value,index)=>{const pageText=clean(value),charStart=cursor;cursor+=pageText.length+1;return{pageNumber:index+1,text:pageText,charStart,charEnd:charStart+pageText.length,headings:pageText.split("\n").slice(0,20).map(line=>inferHeading(line,16,12,index+1)).filter(Boolean) as Heading[]}}).filter(page=>page.text)}
export function buildSections(inputPages:Page[],outline:Heading[],documentTitle:string):Section[]{
  const pages=stripRepeatedMargins(inputPages);const toc=outline.length?[]:tocHeadings(pages);const layout=outline.length||toc.length?[]:pages.flatMap(page=>page.headings);const candidates=outline.length?outline:toc.length?toc:layout;const deduped=candidates.filter((heading,index)=>index===candidates.findIndex(other=>other.page===heading.page&&other.title.toLowerCase()===heading.title.toLowerCase()));
  const neutral=Array.from({length:Math.max(1,Math.ceil(pages.length/20))},(_,index)=>({title:pages.length>20?`Pages ${index*20+1}–${Math.min(pages.length,(index+1)*20)}`:documentTitle,page:index*20+1,level:1,confidence:.3,source:"neutral" as const,confidenceReason:"no reliable outline, TOC, or layout heading"}));
  const roots=deduped.length?deduped:neutral;const ordered=roots.sort((a,b)=>a.page-b.page||a.level-b.level).map((heading,orderIndex)=>({...heading,id:randomUUID(),parentId:null as string|null,orderIndex,pageEnd:pages.at(-1)?.pageNumber||heading.page,charStart:0,charEnd:pages.at(-1)?.charEnd||0}));const stack:Section[]=[];
  for(let index=0;index<ordered.length;index++){const section=ordered[index];while(stack.length&&stack.at(-1)!.level>=section.level)stack.pop();section.parentId=stack.at(-1)?.id||null;const next=ordered[index+1];section.pageEnd=next?Math.max(section.page,next.page-1):pages.at(-1)?.pageNumber||section.page;section.charStart=pages.find(page=>page.pageNumber===section.page)?.charStart||0;section.charEnd=pages.find(page=>page.pageNumber===section.pageEnd)?.charEnd||section.charStart;stack.push(section)}return ordered;
}
function chunksForSections(pages:Page[],sections:Section[]){const chunks:Array<any>=[];for(const page of pages){const section=sections.filter(candidate=>candidate.page<=page.pageNumber&&candidate.pageEnd>=page.pageNumber).sort((a,b)=>b.level-a.level||b.orderIndex-a.orderIndex)[0]||sections[0];for(let start=0;start<page.text.length;start+=CHUNK_CHARACTERS-CHUNK_OVERLAP){const end=Math.min(page.text.length,start+CHUNK_CHARACTERS),content=page.text.slice(start,end);chunks.push({content,page_start:page.pageNumber,page_end:page.pageNumber,section:section.title,section_id:section.id,char_start:page.charStart+start,char_end:page.charStart+end,token_estimate:Math.ceil(content.length/4)});if(end===page.text.length)break}}return chunks.map((chunk,chunk_index)=>({...chunk,chunk_index}))}
async function setStatus(documentId:string,userId:string,status:string){await db()`update public.documents set processing_status=${status},processing_error=null,updated_at=now() where id=${documentId} and user_id=${userId}`}
export async function processDocument(documentId:string,userId:string){
  const sql=db(),rows=await sql`select id,pathname,mime_type,title from public.documents where id=${documentId} and user_id=${userId} limit 1`,document=rows[0];if(!document)throw new Error("Document not found");await setStatus(documentId,userId,"extracting_pages");const blob=await get(String(document.pathname),{access:"private",useCache:false});if(!blob?.stream)throw new Error("Uploaded file could not be opened");const bytes=new Uint8Array(await new Response(blob.stream).arrayBuffer());let pages:Page[],outline:Heading[]=[];
  if(String(document.mime_type)==="application/pdf")({pages,outline}=await extractPdf(bytes));else{const raw=String(document.mime_type)==="text/plain"?new TextDecoder().decode(bytes):(await OfficeParser.parseOffice(bytes,{fileType:String(document.mime_type).includes("wordprocessingml")?"docx":"pptx",ignoreNotes:false})).toText();pages=textPages(raw)}if(!pages.length)throw new Error("No readable text was found. Scanned PDFs need OCR before they can be indexed.");pages=rebasePages(stripRepeatedMargins(pages));
  await setStatus(documentId,userId,"detecting_structure");const sections=buildSections(pages,outline,String(document.title)),confidence=sections.reduce((sum,section)=>sum+section.confidence,0)/sections.length;await setStatus(documentId,userId,"building_index");const chunks=chunksForSections(pages,sections);
  await sql`delete from public.document_chunks where document_id=${documentId} and user_id=${userId}`;await sql`delete from public.document_pages where document_id=${documentId} and user_id=${userId}`;await sql`delete from public.document_sections where document_id=${documentId} and user_id=${userId}`;
  for(const page of pages)await sql`insert into public.document_pages(document_id,user_id,page_number,content,char_start,char_end)values(${documentId},${userId},${page.pageNumber},${page.text},${page.charStart},${page.charEnd})`;
  for(const s of sections)await sql`insert into public.document_sections(id,document_id,user_id,parent_id,kind,level,title,order_index,page_start,page_end,char_start,char_end,confidence,source,detection_method,confidence_reason)values(${s.id},${documentId},${userId},${s.parentId},${s.level===1?"chapter":s.level===2?"section":"subsection"},${s.level},${s.title},${s.orderIndex},${s.page},${s.pageEnd},${s.charStart},${s.charEnd},${s.confidence},${s.source},${s.source},${s.confidenceReason||null})`;
  for(const c of chunks)await sql`insert into public.document_chunks(document_id,user_id,chunk_index,content,page_start,page_end,section,section_id,char_start,char_end,token_estimate,char_count)values(${documentId},${userId},${c.chunk_index},${c.content},${c.page_start},${c.page_end},${c.section},${c.section_id},${c.char_start},${c.char_end},${c.token_estimate},${c.content.length})`;
  await sql`update public.documents set processing_status='ready',processing_error=null,page_count=${pages.length},index_confidence=${confidence},index_version=index_version+1,updated_at=now() where id=${documentId} and user_id=${userId}`;return{pageCount:pages.length,sectionCount:sections.length,chunkCount:chunks.length,indexConfidence:confidence};
}
export function citationLabel(name:string,chunk:StoredChunk){const pages=chunk.page_start?`pp. ${chunk.page_start}${chunk.page_end&&chunk.page_end!==chunk.page_start?`–${chunk.page_end}`:""}`:"location unavailable";return`${name} · ${chunk.section||`chunk ${chunk.chunk_index+1}`} · ${pages}`}
