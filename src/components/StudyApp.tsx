"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { upload as uploadBlob } from "@vercel/blob/client";
import dynamic from "next/dynamic";
import { authClient } from "@/lib-auth";
import { DocumentScopePicker,type DocumentScope } from "@/components/DocumentScopePicker";
import { DocumentIndexPreview } from "@/components/DocumentIndexPreview";

const PdfReader = dynamic(() => import("@/components/PdfReader"), { ssr: false });

type Section = "dashboard" | "session" | "library" | "tutor" | "summary" | "flashcards" | "questions" | "exams" | "progress";

type StudyDocument = {
  id: string;
  title: string;
  original_name: string;
  file_url: string;
  pathname: string;
  mime_type: string;
  size_bytes: number | string;
  processing_status: string;
  processing_error?: string | null;
  ai_status: "idle" | "generating" | "completed" | "error";
  ai_error?: string | null;
  page_count?: number | null;
  current_page?: number | string;
  total_pages?: number | string;
  percent_complete?: number | string;
  reading_seconds?: number | string;
  last_opened_at?: string | null;
  created_at: string;
};

type UploadState = { status: "idle" | "uploading" | "saving" | "processing" | "done" | "error"; message?: string };
type AiTextResult = { title: string; content: string; citations: string[]; followUps: string[] };
type AiCard = { front: string; back: string; citation: string };
type AiQuestion = { question: string; options: string[]; answer: string; explanation: string; citation: string };
type ProgressData = {
  documents: { total: number; ready: number };
  sessions: { total: number; focused_seconds: number | string; cycles: number };
  generations: { total: number; tutor: number; summaries: number; flashcards: number; questions: number };
  reading: { reading_seconds: number | string; completed_documents: number; average_percent: number | string };
};
const EMPTY_PROGRESS: ProgressData = {
  documents: { total: 0, ready: 0 },
  sessions: { total: 0, focused_seconds: 0, cycles: 0 },
  generations: { total: 0, tutor: 0, summaries: 0, flashcards: 0, questions: 0 },
  reading: { reading_seconds: 0, completed_documents: 0, average_percent: 0 },
};

function useReadyDocumentId(documents: StudyDocument[]) {
  const [documentId, setDocumentId] = useState("");
  useEffect(() => {
    const ready = documents.filter(document => document.processing_status === "ready");
    if (!ready.some(document => document.id === documentId)) setDocumentId(ready[0]?.id || "");
  }, [documents, documentId]);
  return [documentId, setDocumentId] as const;
}

function DocumentSelect({ documents, value, onChange }: { documents: StudyDocument[]; value: string; onChange: (value: string) => void }) {
  const readyDocuments = documents.filter(document => document.processing_status === "ready");
  return <select value={value} onChange={event => onChange(event.target.value)}>
    <option value="">Choose study material…</option>
    {readyDocuments.map(document => <option key={document.id} value={document.id}>{document.title}</option>)}
  </select>;
}

async function requestAi<T>(mode: string, documentId: string, prompt: string,scope:DocumentScope) {
  const response = await fetch("/api/ai", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode, documentId, prompt,scope }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "AI generation failed");
  return data.result as T;
}

const nav: { id: Section; label: string; icon: string }[] = [
  { id: "dashboard", label: "Dashboard", icon: "⌂" },
  { id: "session", label: "Study Session", icon: "◷" },
  { id: "library", label: "Library", icon: "▤" },
  { id: "tutor", label: "AI Tutor", icon: "✦" },
  { id: "summary", label: "Summary", icon: "≡" },
  { id: "flashcards", label: "Flashcards", icon: "◫" },
  { id: "questions", label: "Questions", icon: "?" },
  { id: "exams", label: "Exams", icon: "✓" },
  { id: "progress", label: "Progress", icon: "↗" },
];

function Metric({ label, value, suffix = "", hint }: { label: string; value: number | string; suffix?: string; hint?: string }) {
  return (
    <div className="metric-card">
      <div className="metric-top"><span>{label}</span><span className="metric-arrow">↗</span></div>
      <div className="metric-value">{value}<small>{suffix}</small></div>
      {hint && <div className="metric-hint">{hint}</div>}
      <div className="meter"><span style={{ width: value === 0 ? "0%" : "100%" }} /></div>
    </div>
  );
}

function UploadCard({ onUpload, state }: { onUpload: (f: File) => void; state: UploadState }) {
  const ref = useRef<HTMLInputElement>(null);
  const busy = state.status === "uploading" || state.status === "saving" || state.status === "processing";
  return (
    <button className={`upload-card ${busy ? "busy" : ""}`} disabled={busy} onClick={() => ref.current?.click()}>
      <input ref={ref} type="file" accept=".pdf,.docx,.pptx,.txt" hidden onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])} />
      <span className="upload-icon">{busy ? "↻" : "↑"}</span>
      <b>{state.status === "uploading" ? "Uploading securely…" : state.status === "saving" ? "Adding to your library…" : state.status === "processing" ? "Processing document…" : "Upload study material"}</b>
      <span>{state.message || "PDF, DOCX, PPTX or TXT · up to 250 MB"}</span>
      <em>{busy ? "Please wait" : "Choose file"}</em>
    </button>
  );
}

function Dashboard({ go, documents, progress, openPdf }: { go: (s: Section) => void; documents: StudyDocument[]; progress: ProgressData; openPdf: (document: StudyDocument) => void }) {
  const focusedMinutes = Math.floor(Number(progress.sessions.focused_seconds || 0) / 60);
  const readingMinutes = Math.floor(Number(progress.reading?.reading_seconds || 0) / 60);
  return (
    <>
      <div className="hero-row">
        <div><div className="eyebrow">YOUR STUDY WORKSPACE</div><h1>Welcome back.</h1><p>{documents.length ? "Continue with your own uploaded material." : "Upload your first document to begin."}</p></div>
        <button className="primary" onClick={() => go("session")}>Start study session <span>→</span></button>
      </div>
      <div className="metrics-grid">
        <Metric label="Documents" value={progress.documents.total} hint={`${progress.documents.ready} ready for AI`} />
        <Metric label="Study sessions" value={progress.sessions.total} hint={`${progress.sessions.cycles} focus cycles`} />
        <Metric label="Study time" value={focusedMinutes + readingMinutes} suffix=" min" hint={`${readingMinutes} min reading PDFs`} />
        <Metric label="AI generations" value={progress.generations.total} hint="Tutor and study tools" />
      </div>
      <div className="dashboard-grid">
        <div className="panel empty-dashboard"><div className="section-kicker">REAL ACTIVITY</div><h3>{progress.sessions.total ? "Your saved study activity" : "No study activity yet"}</h3><p>{progress.sessions.total ? `${focusedMinutes} focused minutes across ${progress.sessions.total} sessions.` : "Start a study session and your activity will appear here."}</p><button onClick={() => go("session")}>Start study session</button></div>
        <div className="focus-card"><div className="section-kicker">AI STUDY TOOLS</div><h3>{progress.documents.ready ? "Your material is ready" : "Add source material"}</h3><p>{progress.documents.ready ? "Ask Tutor, summarize, or generate active-recall material from your documents." : "AI tools remain empty until you upload a document."}</p><button onClick={() => go(progress.documents.ready ? "tutor" : "library")}>{progress.documents.ready ? "Ask AI Tutor" : "Open Library"}</button></div>
      </div>
      <div className="lower-grid">
        <div className="panel">
          <div className="panel-head"><div><b>Generated study material</b><span>Only your real AI activity</span></div><button onClick={() => go("progress")}>View progress</button></div>
          <div className="real-counts"><span><b>{progress.generations.tutor}</b>Tutor answers</span><span><b>{progress.generations.summaries}</b>Summaries</span><span><b>{progress.generations.flashcards}</b>Flashcard decks</span><span><b>{progress.generations.questions}</b>Question sets</span></div>
        </div>
        <div className="panel">
          <div className="panel-head"><div><b>Recent material</b><span>{documents.length ? `${documents.length} uploaded` : "Your active library"}</span></div><button onClick={() => go("library")}>Open library</button></div>
          {documents.length === 0 && <div className="empty-row">Upload your first document to start building your knowledge base.</div>}
          {documents.slice(0,3).map((d) => <div className="material-row" key={d.id}><span className="doc-icon">{d.mime_type === "application/pdf" ? "PDF" : "FILE"}</span><div><b>{d.title}</b><small>{formatBytes(d.size_bytes)} · {d.mime_type === "application/pdf" ? `${Math.round(Number(d.percent_complete || 0))}% read · page ${Number(d.current_page || 1)}` : statusLabel(d.processing_status)}</small></div>{d.mime_type === "application/pdf" ? <button className="read-button" onClick={() => openPdf(d)}>{Number(d.percent_complete || 0) ? "Resume" : "Read"}</button> : <span className={`status ${d.processing_status === "ready" ? "good" : ""}`}>{aiStatusLabel(d.ai_status)}</span>}</div>)}
        </div>
      </div>
    </>
  );
}

function formatBytes(value: number | string) {
  const bytes = Number(value || 0);
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function uploadMimeType(file: File) {
  if (file.type) return file.type;
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "pdf") return "application/pdf";
  if (extension === "txt") return "text/plain";
  if (extension === "docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (extension === "pptx") return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  return "application/octet-stream";
}

function safeUploadName(name: string) {
  const extension = name.match(/\.[a-z0-9]+$/i)?.[0] || "";
  const stem = extension ? name.slice(0, -extension.length) : name;
  const safeStem = stem.normalize("NFKD").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
  return `${safeStem || "document"}${extension.toLowerCase()}`;
}

function uploadErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (/expected pattern|invalid url|failed to retrieve|client token|presigned url/i.test(message)) {
    return "The secure upload could not be started. Refresh the page and try again. If it continues, sign out and back in.";
  }
  if (/network|fetch|load failed/i.test(message)) return "The upload lost its network connection. Check your connection and try again.";
  if (/too large|size/i.test(message)) return "This file is larger than the 250 MB upload limit.";
  return message || "The upload failed before it could be saved. Please try again.";
}

function statusLabel(status: string) {
  if (status === "ready") return "Ready for AI";
  if (status === "extracting_pages") return "Extracting pages";
  if (status === "detecting_structure") return "Detecting structure";
  if (status === "building_index") return "Building index";
  if (status === "processing") return "Processing";
  if (status === "error") return "Processing error";
  return "Uploaded";
}

function aiStatusLabel(status: StudyDocument["ai_status"]) {
  if (status === "generating") return "Generating";
  if (status === "completed") return "Completed";
  if (status === "error") return "AI error";
  return "No AI actions yet";
}

function Library({ documents, upload, retry, retryingId, state, loading, openPdf }: { documents: StudyDocument[]; upload: (f: File) => void; retry: (documentId: string) => void; retryingId: string | null; state: UploadState; loading: boolean; openPdf: (document: StudyDocument) => void }) {
  return <>
    <PageTitle kicker="KNOWLEDGE BASE" title="Study Library" text="Upload course material once. Every AI study mode will use it as the primary source of truth." />
    <div className="library-layout"><UploadCard onUpload={upload} state={state} /><div className="panel file-list">
      <div className="panel-head"><div><b>Your material</b><span>{documents.length} document{documents.length === 1 ? "" : "s"} in your private library</span></div></div>
      {loading && <div className="library-empty">Loading your library…</div>}
      {!loading && documents.length === 0 && <div className="library-empty"><b>No study material yet.</b><span>Upload a PDF and it will appear here permanently under your account.</span></div>}
      {documents.map((d)=><div className="material-row" key={d.id}><span className="doc-icon">{d.mime_type === "application/pdf" ? "PDF" : "FILE"}</span><div><b>{d.title}</b><small>{formatBytes(d.size_bytes)} · {new Date(d.created_at).toLocaleDateString()}{d.processing_error ? ` · ${d.processing_error}` : d.ai_error ? ` · ${d.ai_error}` : ""}</small>{d.mime_type === "application/pdf" && <div className="document-reading"><span><i style={{width:`${Math.min(100,Number(d.percent_complete || 0))}%`}}/></span><b>{Math.round(Number(d.percent_complete || 0))}% · Continue page {Number(d.current_page || 1)}</b></div>}{d.processing_status === "ready" && <DocumentIndexPreview documentId={d.id} pageCount={d.page_count}/>}</div><div className="state-stack">{d.mime_type === "application/pdf" && <button className="read-button" onClick={() => openPdf(d)}>{Number(d.percent_complete || 0) > 0 ? "Continue reading" : "Read PDF"}</button>}{d.processing_status === "error" && <button className="read-button" disabled={retryingId === d.id} onClick={() => retry(d.id)}>{retryingId === d.id ? "Retrying…" : "Retry processing"}</button>}<span className={`status ${d.processing_status === "ready" ? "good" : d.processing_status === "error" ? "bad" : ""}`}>{statusLabel(d.processing_status)}</span><span className={`status ${d.ai_status === "completed" ? "good" : d.ai_status === "error" ? "bad" : ""}`}>{aiStatusLabel(d.ai_status)}</span></div></div>)}
    </div></div>
    {state.status === "error" && <div className="upload-error">{state.message}</div>}
    <div className="panel pipeline"><b>Document index pipeline</b><div className="pipeline-flow"><span>Extracting pages</span><i>→</i><span>Detecting structure</span><i>→</i><span>Building index</span><i>→</i><span>Ready for AI</span></div><small className="pipeline-note">The file stays private. Gemini receives only text chunks from the scope you choose.</small></div>
  </>
}

function PageTitle({ kicker, title, text }: { kicker:string; title:string; text:string }) {
  return <div className="page-title"><div className="eyebrow">{kicker}</div><h1>{title}</h1><p>{text}</p></div>
}


function StudySession({ documents, onProgressChange }: { documents: StudyDocument[]; onProgressChange: () => void }) {
  const [focusMinutes,setFocusMinutes]=useState(25);
  const [breakMinutes,setBreakMinutes]=useState(5);
  const [targetCycles,setTargetCycles]=useState(4);
  const [phase,setPhase]=useState<"focus"|"break">("focus");
  const [secondsLeft,setSecondsLeft]=useState(25*60);
  const [running,setRunning]=useState(false);
  const [cycles,setCycles]=useState(0);
  const [sessionId,setSessionId]=useState<string>("");
  const [documentId,setDocumentId]=useState("");
  const [status,setStatus]=useState("Ready");

  useEffect(()=>{ if(!running) setSecondsLeft((phase==="focus"?focusMinutes:breakMinutes)*60); },[focusMinutes,breakMinutes,phase,running]);
  useEffect(()=>{
    if(!running) return;
    const timer=setInterval(()=>setSecondsLeft(v=>Math.max(0,v-1)),1000);
    return ()=>clearInterval(timer);
  },[running]);
  useEffect(()=>{
    if(!running || secondsLeft!==0) return;
    void completeInterval();
  },[secondsLeft,running]);

  async function ensureSession(){
    if(sessionId) return sessionId;
    const r=await fetch('/api/study-sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Pomodoro Study Session',mode:'pomodoro',documentId:documentId||null,focusMinutes,breakMinutes,targetCycles})});
    const d=await r.json(); if(!r.ok) throw new Error(d.error||'Could not start session');
    setSessionId(d.session.id); return d.session.id as string;
  }
  async function start(){
    try{ await ensureSession(); setRunning(true); setStatus(phase==='focus'?'Focus in progress':'Break in progress'); }catch(e){ setStatus(e instanceof Error?e.message:'Could not start'); }
  }
  async function completeInterval(){
    const id=await ensureSession();
    const planned=(phase==='focus'?focusMinutes:breakMinutes)*60;
    await fetch('/api/study-sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'interval',sessionId:id,intervalType:phase,plannedSeconds:planned,actualSeconds:planned,completed:true})});
    onProgressChange();
    setRunning(false);
    if(phase==='focus'){ const next=cycles+1; setCycles(next); if(next>=targetCycles){ await finish(id); return; } setPhase('break'); setSecondsLeft(breakMinutes*60); setStatus('Focus complete · take a break'); }
    else { setPhase('focus'); setSecondsLeft(focusMinutes*60); setStatus('Break complete · ready to focus'); }
  }
  async function finish(id=sessionId){
    if(id) await fetch('/api/study-sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'finish',sessionId:id})});
    onProgressChange();
    setRunning(false); setStatus('Session completed');
  }
  function reset(){ setRunning(false); setPhase('focus'); setCycles(0); setSessionId(''); setSecondsLeft(focusMinutes*60); setStatus('Ready'); }
  const mm=String(Math.floor(secondsLeft/60)).padStart(2,'0'), ss=String(secondsLeft%60).padStart(2,'0');
  const pct=Math.max(0,Math.min(100,100-(secondsLeft/((phase==='focus'?focusMinutes:breakMinutes)*60))*100));
  return <>
    <PageTitle kicker="DEEP WORK" title="Study Session" text="Run focused Pomodoro cycles and turn real study time into measurable progress." />
    <div className="session-grid">
      <div className="panel timer-panel"><div className="timer-top"><span>{phase==='focus'?'FOCUS':'BREAK'}</span><b>{cycles} / {targetCycles} cycles</b></div><div className="timer-ring" style={{'--timer':`${pct}%`} as React.CSSProperties}><div><strong>{mm}:{ss}</strong><span>{status}</span></div></div><div className="timer-actions"><button className="primary" onClick={running?()=>setRunning(false):start}>{running?'Pause':sessionId?'Resume':'Start session'}</button><button className="ghost" onClick={()=>void completeInterval()}>Skip interval</button><button className="ghost" onClick={reset}>Reset</button></div></div>
      <div className="panel session-settings"><div className="section-kicker">SESSION SETUP</div><h3>Pomodoro</h3><label>Study material<select value={documentId} onChange={e=>setDocumentId(e.target.value)}><option value="">No specific document</option>{documents.map(d=><option key={d.id} value={d.id}>{d.title}</option>)}</select></label><div className="session-fields"><label>Focus<input type="number" min="10" max="90" value={focusMinutes} onChange={e=>setFocusMinutes(Number(e.target.value)||25)}/><span>min</span></label><label>Break<input type="number" min="3" max="30" value={breakMinutes} onChange={e=>setBreakMinutes(Number(e.target.value)||5)}/><span>min</span></label><label>Cycles<input type="number" min="1" max="12" value={targetCycles} onChange={e=>setTargetCycles(Number(e.target.value)||4)}/></label></div><div className="language-note"><b>Course language</b><span>Italiano · AI explanations can later switch between Italiano / فارسی / English.</span></div><button className="finish-session" disabled={!sessionId} onClick={()=>void finish()}>Finish & save session</button></div>
    </div>
  </>
}

function Tutor({ documents, onStatusChange }: { documents: StudyDocument[]; onStatusChange: () => void }) {
  const [message,setMessage]=useState("");
  const [documentId,setDocumentId]=useReadyDocumentId(documents);
  const [result,setResult]=useState<AiTextResult | null>(null);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  const [scope,setScope]=useState<DocumentScope>({type:"sections",sectionIds:[]});
  async function ask(prompt=message) {
    if (!documentId || !prompt.trim()) { setError("Choose a document and enter a question."); return; }
    setLoading(true); setError("");
    try { setResult(await requestAi<AiTextResult>("tutor",documentId,prompt,scope)); setMessage(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "AI Tutor failed"); }
    finally { setLoading(false); onStatusChange(); }
  }
  return <>
    <PageTitle kicker="ACTIVE LEARNING" title="AI Tutor" text="Ask questions grounded only in your uploaded study material, with source references." />
    <div className="tutor-grid"><div className="panel lesson-panel">
      <div className="ai-source-row"><label>Source<DocumentSelect documents={documents} value={documentId} onChange={setDocumentId}/></label><span className="ai-badge">SOURCE-GROUNDED</span></div>
      <DocumentScopePicker compact documentId={documentId} pageCount={documents.find(d=>d.id===documentId)?.page_count} value={scope} onChange={setScope}/>
      <div className="lesson-body ai-output">{!result && !loading && <div className="ai-empty"><b>Ask your first question</b><span>StudyOS will answer using only the selected file.</span></div>}{loading && <div className="ai-loading">Reading your material and preparing an answer…</div>}{result && <><h2>{result.title}</h2><p>{result.content}</p><div className="citation-list">{result.citations.map(source=><span className="source-chip" key={source}>{source}</span>)}</div></>}</div>
      {result && <div className="quick-actions">{result.followUps.map(item=><button key={item} onClick={()=>void ask(item)}>{item}</button>)}</div>}
      {error && <div className="upload-error">{error}</div>}
      <form className="chat-box" onSubmit={event=>{event.preventDefault();void ask();}}><input value={message} disabled={loading || !documents.some(d=>d.processing_status==="ready")} onChange={event=>setMessage(event.target.value)} placeholder={documents.some(d=>d.processing_status==="ready") ? "Ask about your notes…" : "Upload and process a document first"}/><button aria-label="Ask AI" disabled={loading || !message.trim()}>↑</button></form>
    </div><div className="panel tutor-side"><b>How grounding works</b><div className="grounding-steps"><span>1</span><p><b>Select a source</b>Your private document is loaded securely.</p><span>2</span><p><b>Ask naturally</b>Use English, Italian, or Persian.</p><span>3</span><p><b>Verify citations</b>Answers identify their source location.</p></div><small>Daily safeguard · up to 40 AI generations per account.</small></div></div>
  </>
}

function Summary({ documents, onStatusChange }: { documents: StudyDocument[]; onStatusChange: () => void }) {
  const [documentId,setDocumentId]=useReadyDocumentId(documents);
  const [depth,setDepth]=useState("Detailed");
  const [result,setResult]=useState<AiTextResult | null>(null);
  const [loading,setLoading]=useState(false); const [error,setError]=useState("");
  const [scope,setScope]=useState<DocumentScope>({type:"sections",sectionIds:[]});
  async function generate(){ if(!documentId){setError("Choose study material first.");return;} setLoading(true);setError("");try{setResult(await requestAi<AiTextResult>("summary",documentId,`${depth} depth. Preserve the original structure and emphasize exam-relevant concepts.`,scope));}catch(reason){setError(reason instanceof Error?reason.message:"Summary failed");}finally{setLoading(false);onStatusChange();} }
  return <>
  <PageTitle kicker="SOURCE-GROUNDED" title="AI Summary" text="Generate revision notes at the depth you need without losing the structure of the original material." />
  <div className="summary-controls panel"><label>Material<DocumentSelect documents={documents} value={documentId} onChange={setDocumentId}/></label><label>Depth<select value={depth} onChange={event=>setDepth(event.target.value)}><option>Detailed</option><option>Standard</option><option>Quick</option></select></label><button className="primary" disabled={loading} onClick={()=>void generate()}>{loading?"Generating…":"Generate summary"}</button></div><DocumentScopePicker documentId={documentId} pageCount={documents.find(d=>d.id===documentId)?.page_count} value={scope} onChange={setScope}/>
  {error&&<div className="upload-error">{error}</div>}
  <div className="panel article ai-output">{!result&&!loading&&<div className="ai-empty"><b>No summary generated yet</b><span>Select a document and choose the depth.</span></div>}{loading&&<div className="ai-loading">Building your source-grounded summary…</div>}{result&&<><div className="article-top"><span>{depth.toUpperCase()} SUMMARY</span><span>{result.citations.length} source references</span></div><h2>{result.title}</h2><p>{result.content}</p><div className="citation-list">{result.citations.map(source=><span className="source-chip" key={source}>{source}</span>)}</div></>}</div>
  </> }

function Flashcards({ documents, onStatusChange }: { documents: StudyDocument[]; onStatusChange: () => void }) {
  const [index,setIndex]=useState(0); const [flip,setFlip]=useState(false);
  const [documentId,setDocumentId]=useReadyDocumentId(documents); const [cards,setCards]=useState<AiCard[]>([]);
  const [title,setTitle]=useState("Generated deck"); const [loading,setLoading]=useState(false); const [error,setError]=useState("");
  const [scope,setScope]=useState<DocumentScope>({type:"sections",sectionIds:[]});
  async function generate(){if(!documentId){setError("Choose study material first.");return;}setLoading(true);setError("");try{const data=await requestAi<{title:string;items:AiCard[]}>("flashcards",documentId,"Focus on high-yield concepts and common misconceptions.",scope);setCards(data.items);setTitle(data.title);setIndex(0);setFlip(false);}catch(reason){setError(reason instanceof Error?reason.message:"Flashcards failed");}finally{setLoading(false);onStatusChange();}}
  const card=cards[index];
  return <><PageTitle kicker="ACTIVE RECALL" title="Flashcards" text="Generate source-grounded cards directly from your own notes." /><div className="flash-layout"><div className="panel deck-info"><b>{title}</b><label>Material<DocumentSelect documents={documents} value={documentId} onChange={setDocumentId}/></label><DocumentScopePicker compact documentId={documentId} pageCount={documents.find(d=>d.id===documentId)?.page_count} value={scope} onChange={setScope}/><button className="primary" disabled={loading} onClick={()=>void generate()}>{loading?"Generating…":"Generate 10 cards"}</button><small>{cards.length?`${cards.length} cards ready`:`Select a source to create a deck.`}</small></div>{error&&<div className="upload-error">{error}</div>}{card?<><div className={`flashcard ${flip?"flipped":""}`} onClick={()=>setFlip(!flip)}><div className="flash-meta"><span>SOURCE-GROUNDED</span><span>{index+1} / {cards.length}</span></div><h2>{flip?card.back:card.front}</h2><span className="tap-hint">{flip?card.citation:"Tap to reveal answer"}</span></div><div className="ratings">{["Again","Hard","Good","Easy"].map(x=><button key={x} onClick={()=>{setFlip(false);setIndex((index+1)%cards.length)}}>{x}</button>)}</div></>:<div className="panel ai-empty"><b>No cards yet</b><span>Generate a new deck from an uploaded document.</span></div>}</div></>
}

function Questions({ documents, exams=false, onStatusChange }: { documents: StudyDocument[]; exams?: boolean; onStatusChange: () => void }) {
  const [submitted,setSubmitted]=useState(false); const [answer,setAnswer]=useState(""); const [index,setIndex]=useState(0);
  const [documentId,setDocumentId]=useReadyDocumentId(documents); const [questions,setQuestions]=useState<AiQuestion[]>([]);
  const [loading,setLoading]=useState(false); const [error,setError]=useState("");
  const [scope,setScope]=useState<DocumentScope>({type:"sections",sectionIds:[]});
  async function generate(){if(!documentId){setError("Choose study material first.");return;}setLoading(true);setError("");try{const data=await requestAi<{title:string;items:AiQuestion[]}>("questions",documentId,exams?"Use mixed difficulty and exam-style distractors.":"Prioritize active recall and concise explanations.",scope);setQuestions(data.items);setIndex(0);setAnswer("");setSubmitted(false);}catch(reason){setError(reason instanceof Error?reason.message:"Question generation failed");}finally{setLoading(false);onStatusChange();}}
  const question=questions[index];
  return <><PageTitle kicker={exams?"SIMULATION":"ACTIVE RECALL"} title={exams?"Exam Simulator":"Questions"} text={exams?"Simulate the real exam and measure readiness by topic.":"Upload existing question banks or generate questions directly from selected study material."} />
  <div className="panel exam-builder"><div className="builder-row"><label>Material<DocumentSelect documents={documents} value={documentId} onChange={setDocumentId}/></label><DocumentScopePicker compact documentId={documentId} pageCount={documents.find(d=>d.id===documentId)?.page_count} value={scope} onChange={setScope}/><label>Type<select><option>Multiple Choice</option></select></label><label>Difficulty<select><option>Mixed</option><option>Easy</option><option>Medium</option><option>Hard</option></select></label><button className="primary" disabled={loading} onClick={()=>void generate()}>{loading?"Generating…":exams?"Build exam":"Generate questions"}</button></div></div>
  {error&&<div className="upload-error">{error}</div>}
  {question?<div className="panel question-card"><div className="question-top"><span>QUESTION {index+1} OF {questions.length}</span><span>SOURCE-GROUNDED</span></div><h2>{question.question}</h2>{question.options.map((option,i)=><label className={`option ${answer===option?"selected":""}`} key={option}><input type="radio" name="q" value={option} checked={answer===option} onChange={()=>setAnswer(option)}/><span>{String.fromCharCode(65+i)}</span>{option}</label>)}<div className="question-footer"><button className="ghost" disabled={index===0} onClick={()=>{setIndex(index-1);setSubmitted(false);setAnswer("");}}>Previous</button><button className="primary" disabled={!answer} onClick={()=>setSubmitted(true)}>Check answer</button></div>{submitted&&<div className={`result ${answer===question.answer?"correct":"wrong"}`}><b>{answer===question.answer?"Correct":"Review this concept"}</b><span>{question.explanation}</span><small>{question.citation}</small><button className="ghost" disabled={index>=questions.length-1} onClick={()=>{setIndex(index+1);setSubmitted(false);setAnswer("");}}>Next question</button></div>}</div>:<div className="panel ai-empty"><b>No questions generated yet</b><span>Choose a document to build a source-grounded practice set.</span></div>}</>
}

function Progress({ progress }: { progress: ProgressData }) {
  const focusedMinutes = Math.floor(Number(progress.sessions.focused_seconds || 0) / 60);
  const readingMinutes = Math.floor(Number(progress.reading?.reading_seconds || 0) / 60);
  return <><PageTitle kicker="MEASURABLE LEARNING" title="Progress & Analytics" text="Every number below comes from your saved StudyOS activity." />
  <div className="metrics-grid"><Metric label="Documents" value={progress.documents.total}/><Metric label="Focused minutes" value={focusedMinutes}/><Metric label="PDF reading" value={readingMinutes} suffix=" min"/><Metric label="Average read" value={Math.round(Number(progress.reading?.average_percent || 0))} suffix="%"/></div>
  <div className="lower-grid"><div className="panel"><div className="panel-head"><div><b>AI activity</b><span>Generated from your own documents</span></div></div><div className="real-counts"><span><b>{progress.generations.tutor}</b>Tutor answers</span><span><b>{progress.generations.summaries}</b>Summaries</span><span><b>{progress.generations.flashcards}</b>Flashcard decks</span><span><b>{progress.generations.questions}</b>Question sets</span></div></div><div className="panel empty-dashboard"><div className="section-kicker">YOUR ACTIVITY</div><h3>{progress.generations.total || progress.sessions.total ? "Your real activity is recorded" : "Your progress starts at zero"}</h3><p>StudyOS adds progress only after you study or generate content.</p></div></div></>
}

export default function StudyApp() {
  const session = authClient.useSession();
  const userName = session.data?.user?.name || session.data?.user?.email?.split("@")[0] || "Student";
  const initials = userName.split(/\s+/).map((x:string)=>x[0]).join("").slice(0,2).toUpperCase();
  const userId = session.data?.user?.id || "";
  const [section,setSection]=useState<Section>("dashboard");
  const [documents,setDocuments]=useState<StudyDocument[]>([]);
  const [progress,setProgress]=useState<ProgressData>(EMPTY_PROGRESS);
  const [libraryLoading,setLibraryLoading]=useState(true);
  const [uploadState,setUploadState]=useState<UploadState>({status:"idle"});
  const [retryingId,setRetryingId]=useState<string | null>(null);
  const [collapsed,setCollapsed]=useState(false);
  const [signingOut,setSigningOut]=useState(false);
  const [readerDocument,setReaderDocument]=useState<StudyDocument | null>(null);
  const title=useMemo(()=>nav.find(x=>x.id===section)?.label,[section]);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await authClient.signOut();
    } finally {
      setSigningOut(false);
    }
  }

  async function loadDocuments() {
    if (!userId) return;
    setLibraryLoading(true);
    try {
      const response = await fetch("/api/documents");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load library");
      setDocuments(data.documents || []);
    } catch (error) {
      console.error(error);
    } finally {
      setLibraryLoading(false);
    }
  }

  async function loadProgress() {
    if (!userId) return;
    try {
      const response = await fetch("/api/progress");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load progress");
      setProgress(data);
    } catch (error) { console.error(error); }
  }

  useEffect(() => { void Promise.all([loadDocuments(), loadProgress()]); }, [userId]);

  async function retryProcessing(documentId: string) {
    setRetryingId(documentId);
    setDocuments(current => current.map(document => document.id === documentId
      ? { ...document, processing_status: "processing", processing_error: null }
      : document));
    try {
      const response = await fetch("/api/documents", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "process", documentId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Document processing failed");
      setDocuments(current => current.map(document => document.id === documentId ? data.document : document));
      void loadProgress();
    } catch (error) {
      console.error("document retry failed", error);
      await loadDocuments();
    } finally {
      setRetryingId(null);
    }
  }

  async function handleUpload(file: File) {
    if (!userId) return;
    if (file.size > 250 * 1024 * 1024) {
      setUploadState({ status: "error", message: "Choose a file no larger than 250 MB." });
      return;
    }
    const mimeType = uploadMimeType(file);
    if (mimeType === "application/octet-stream") {
      setUploadState({ status: "error", message: "Choose a PDF, DOCX, PPTX, or TXT file." });
      return;
    }
    setSection("library");
    setUploadState({ status: "uploading", message: `${file.name} · ${formatBytes(file.size)}` });
    try {
      // Supplying an absolute endpoint avoids Safari's native URL parser failure before
      // the token request is sent. Multipart keeps the same flow suitable for large PDFs.
      const handleUploadUrl = new URL("/api/documents/upload", window.location.origin).toString();
      const blob = await uploadBlob(`users/${userId}/documents/${safeUploadName(file.name)}`, file, {
        access: "private",
        handleUploadUrl,
        clientPayload: JSON.stringify({ userId }),
        multipart: file.size >= 5 * 1024 * 1024,
        contentType: mimeType,
      });
      setUploadState({ status: "saving", message: "Upload complete. Saving document metadata…" });
      const title = file.name.replace(/\.[^/.]+$/, "");
      const response = await fetch("/api/documents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title, originalName: file.name, fileUrl: blob.url, pathname: blob.pathname, mimeType, sizeBytes: file.size, sourceLanguage: "it", explanationLanguage: "it"
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save document");
      setDocuments((current) => [data.document, ...current]);
      setUploadState({ status: "processing", message: "Extracting text, pages, and source-grounded AI chunks…" });
      const processingResponse = await fetch("/api/documents", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "process", documentId: data.document.id }),
      });
      const processingData = await processingResponse.json();
      if (!processingResponse.ok) throw new Error(processingData.error || "Document processing failed");
      setDocuments(current => current.map(document => document.id === processingData.document.id ? processingData.document : document));
      setUploadState({ status: "done", message: "Chunk index complete. Ready for AI." });
      void loadProgress();
      setTimeout(() => setUploadState({status:"idle"}), 4000);
    } catch (error) {
      console.error("document upload failed", error);
      setUploadState({ status: "error", message: uploadErrorMessage(error) });
      void loadDocuments();
    }
  }
  return <div className={`app ${collapsed?"collapsed":""}`}>
    <aside className="sidebar"><div className="brand"><div className="brand-mark">S</div><div><b>StudyOS</b><span>AI Learning System</span></div></div><nav>{nav.map(x=><button key={x.id} className={section===x.id?"active":""} onClick={()=>setSection(x.id)}><span>{x.icon}</span><b>{x.label}</b></button>)}</nav><div className="sidebar-bottom"><button className="upload-small" onClick={()=>setSection("library")}><span>＋</span><b>Upload material</b></button><div className="profile"><span>{initials}</span><div><b>{userName}</b><small>Signed in</small></div></div><button className="signout" onClick={()=>void handleSignOut()} disabled={signingOut}><span>↪</span><b>{signingOut?"Logging out…":"Log out"}</b></button></div></aside>
    <main><header><button className="collapse" onClick={()=>setCollapsed(!collapsed)}>☰</button><span className="mobile-title">{title}</span><div className="header-actions"><div className="global-progress"><span>Your private workspace</span><b>{progress.documents.ready} AI-ready</b></div></div></header><div className="content">
      {section==="dashboard"&&<Dashboard go={setSection} documents={documents} progress={progress} openPdf={setReaderDocument}/>} {section==="session"&&<StudySession documents={documents} onProgressChange={()=>void loadProgress()}/>} {section==="library"&&<Library documents={documents} upload={handleUpload} retry={retryProcessing} retryingId={retryingId} state={uploadState} loading={libraryLoading} openPdf={setReaderDocument}/>} {section==="tutor"&&<Tutor documents={documents} onStatusChange={()=>void Promise.all([loadDocuments(),loadProgress()])}/>} {section==="summary"&&<Summary documents={documents} onStatusChange={()=>void Promise.all([loadDocuments(),loadProgress()])}/>} {section==="flashcards"&&<Flashcards documents={documents} onStatusChange={()=>void Promise.all([loadDocuments(),loadProgress()])}/>} {section==="questions"&&<Questions documents={documents} onStatusChange={()=>void Promise.all([loadDocuments(),loadProgress()])}/>} {section==="exams"&&<Questions documents={documents} onStatusChange={()=>void Promise.all([loadDocuments(),loadProgress()])} exams/>} {section==="progress"&&<Progress progress={progress}/>}
    </div></main>
    {readerDocument && <PdfReader document={readerDocument} onClose={() => { setReaderDocument(null); void Promise.all([loadDocuments(), loadProgress()]); }} onProgress={() => void Promise.all([loadDocuments(), loadProgress()])}/>}
  </div>
}
