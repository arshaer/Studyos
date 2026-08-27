import { get } from "@vercel/blob";
import { OfficeParser } from "officeparser";
import { db } from "@/lib-db";

const CHUNK_CHARACTERS = 12_000;
const CHUNK_OVERLAP = 500;

type ExtractedPart = { text: string; page?: number; section?: string };
export type StoredChunk = { chunk_index: number; content: string; page_start: number | null; page_end: number | null; section: string | null };

function splitPart(part: ExtractedPart) {
  const normalized = part.text.replace(/\u0000/g, "").replace(/[ \t]+\n/g, "\n").trim();
  const chunks: Omit<StoredChunk, "chunk_index">[] = [];
  for (let start = 0; start < normalized.length; start += CHUNK_CHARACTERS - CHUNK_OVERLAP) {
    const end = Math.min(normalized.length, start + CHUNK_CHARACTERS);
    chunks.push({ content: normalized.slice(start, end), page_start: part.page ?? null, page_end: part.page ?? null, section: part.section ?? null });
    if (end === normalized.length) break;
  }
  return chunks;
}

async function extractPdf(bytes: Uint8Array): Promise<ExtractedPart[]> {
  // unpdf's default PDF.js build is compiled for serverless runtimes and has its
  // worker inlined. Do not swap this for pdfjs-dist: its Node fallback dynamically
  // imports pdf.worker.mjs, which is not present in Next.js' Vercel function output.
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes, {
    disableFontFace: true,
    useSystemFonts: false,
    maxImageSize: 16_777_216,
  });
  const pages: ExtractedPart[] = [];
  try {
    // Process sequentially so large PDFs do not fan every page out in memory at once.
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const text = content.items.map((item) => "str" in item ? item.str : "").join(" ");
        if (text.trim()) pages.push({ text, page: pageNumber, section: `Page ${pageNumber}` });
      } finally {
        page.cleanup();
      }
    }
  } finally {
    await pdf.cleanup();
  }
  return pages;
}

function textParts(text: string): ExtractedPart[] {
  const sections = text.split(/\n(?=(?:#{1,6}\s+|[A-ZÀ-ÖØ-Þ][^\n]{2,100}\n))/g).filter((value) => value.trim());
  return sections.map((value, index) => {
    const heading = value.split("\n", 1)[0].trim().slice(0, 160);
    return { text: value, section: heading || `Section ${index + 1}` };
  });
}

export async function processDocument(documentId: string, userId: string) {
  const sql = db();
  const rows = await sql`
    select id, pathname, mime_type, original_name, size_bytes from public.documents
    where id=${documentId} and user_id=${userId} limit 1
  `;
  const document = rows[0];
  if (!document) throw new Error("Document not found");
  const blob = await get(String(document.pathname), { access: "private", useCache: false });
  if (!blob?.stream) throw new Error("Uploaded file could not be opened");
  const bytes = new Uint8Array(await new Response(blob.stream).arrayBuffer());
  let parts: ExtractedPart[];
  if (String(document.mime_type) === "application/pdf") {
    parts = await extractPdf(bytes);
  } else if (String(document.mime_type) === "text/plain") {
    parts = textParts(new TextDecoder().decode(bytes));
  } else {
    const fileType = String(document.mime_type).includes("wordprocessingml") ? "docx" : "pptx";
    const parsed = await OfficeParser.parseOffice(bytes, { fileType, ignoreNotes: false });
    parts = textParts(parsed.toText());
  }
  const chunks = parts.flatMap(splitPart).map((chunk, chunk_index) => ({ ...chunk, chunk_index }));
  if (!chunks.length) throw new Error("No readable text was found. Scanned PDFs need OCR before they can be used with AI.");
  await sql`delete from public.document_chunks where document_id=${documentId} and user_id=${userId}`;
  for (let offset = 0; offset < chunks.length; offset += 100) {
    const batch = chunks.slice(offset, offset + 100);
    await sql`
      insert into public.document_chunks (document_id, user_id, chunk_index, content, page_start, page_end, section, char_count)
      select ${documentId}::uuid, ${userId}, * from unnest(
        ${batch.map((chunk) => chunk.chunk_index)}::int[],
        ${batch.map((chunk) => chunk.content)}::text[],
        ${batch.map((chunk) => chunk.page_start)}::int[],
        ${batch.map((chunk) => chunk.page_end)}::int[],
        ${batch.map((chunk) => chunk.section)}::text[],
        ${batch.map((chunk) => chunk.content.length)}::int[]
      )
    `;
  }
  const pageCount = parts.reduce((maximum, part) => Math.max(maximum, part.page || 0), 0) || null;
  await sql`
    update public.documents set processing_status='ready', processing_error=null, page_count=${pageCount}, updated_at=now()
    where id=${documentId} and user_id=${userId}
  `;
  return { chunkCount: chunks.length, pageCount };
}

export function citationLabel(name: string, chunk: StoredChunk) {
  if (chunk.page_start) return `${name} · page ${chunk.page_start}`;
  if (chunk.section) return `${name} · ${chunk.section}`;
  return `${name} · chunk ${chunk.chunk_index + 1}`;
}
