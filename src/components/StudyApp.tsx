"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { upload as uploadBlob } from "@vercel/blob/client";
import { authClient } from "@/lib-auth";

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
  page_count?: number | null;
  created_at: string;
};

type UploadState = { status: "idle" | "uploading" | "saving" | "done" | "error"; message?: string };
type AiTextResult = { title: string; content: string; citations: string[]; followUps: string[] };
type AiCard = { front: string; back: string; citation: string };
type AiQuestion = { question: string; options: string[]; answer: string; explanation: string; citation: string };

function DocumentSelect({ documents, value, onChange }: { documents: StudyDocument[]; value: string; onChange: (value: string) => void }) {
  return <select value={value} onChange={event => onChange(event.target.value)}>
    <option value="">Choose study material…</option>
    {documents.map(document => <option key={document.id} value={document.id}>{document.title}</option>)}
  </select>;
}

async function requestAi<T>(userId: string, mode: string, documentId: string, prompt: string) {
  const response = await fetch("/api/ai", {
    method: "POST",
    headers: { "content-type": "application/json", "x-studyos-user-id": userId },
    body: JSON.stringify({ mode, documentId, prompt }),
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

const masteryData = [41, 45, 47, 52, 56, 58, 61, 65, 68, 71, 73, 76];
const studyBars = [34, 50, 22, 68, 46, 73, 58];

function Metric({ label, value, suffix = "%", hint }: { label: string; value: number; suffix?: string; hint?: string }) {
  return (
    <div className="metric-card">
      <div className="metric-top"><span>{label}</span><span className="metric-arrow">↗</span></div>
      <div className="metric-value">{value}<small>{suffix}</small></div>
      {hint && <div className="metric-hint">{hint}</div>}
      <div className="meter"><span style={{ width: `${Math.min(value, 100)}%` }} /></div>
    </div>
  );
}

function LineChart() {
  const pts = masteryData.map((v, i) => `${(i / (masteryData.length - 1)) * 100},${100 - v}`).join(" ");
  return (
    <div className="chart-shell">
      <div className="chart-head"><div><b>Mastery trend</b><span>Last 12 study sessions</span></div><strong>+35%</strong></div>
      <svg viewBox="0 0 100 60" className="line-chart" preserveAspectRatio="none" aria-label="Mastery trend chart">
        {[15, 30, 45].map(y => <line key={y} x1="0" x2="100" y1={y} y2={y} className="grid-line" />)}
        <polyline points={pts} className="trend-line" fill="none" />
      </svg>
      <div className="chart-axis"><span>S1</span><span>S4</span><span>S8</span><span>S12</span></div>
    </div>
  );
}

function UploadCard({ onUpload, state }: { onUpload: (f: File) => void; state: UploadState }) {
  const ref = useRef<HTMLInputElement>(null);
  const busy = state.status === "uploading" || state.status === "saving";
  return (
    <button className={`upload-card ${busy ? "busy" : ""}`} disabled={busy} onClick={() => ref.current?.click()}>
      <input ref={ref} type="file" accept=".pdf,.docx,.pptx,.txt" hidden onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])} />
      <span className="upload-icon">{busy ? "↻" : "↑"}</span>
      <b>{state.status === "uploading" ? "Uploading securely…" : state.status === "saving" ? "Adding to your library…" : "Upload study material"}</b>
      <span>{state.message || "PDF, DOCX, PPTX or TXT · up to 60 MB"}</span>
      <em>{busy ? "Please wait" : "Choose file"}</em>
    </button>
  );
}

function Dashboard({ go, documents }: { go: (s: Section) => void; documents: StudyDocument[] }) {
  return (
    <>
      <div className="hero-row">
        <div><div className="eyebrow">TUESDAY · STUDY PLAN</div><h1>Good evening.</h1><p>Your exam readiness is moving in the right direction. Keep the momentum.</p></div>
        <button className="primary" onClick={() => go("session")}>Start study session <span>→</span></button>
      </div>
      <div className="metrics-grid">
        <Metric label="Course progress" value={72} hint="+6% this week" />
        <Metric label="Knowledge mastery" value={68} hint="+9% this week" />
        <Metric label="Exam readiness" value={76} hint="On track" />
        <Metric label="Flashcard retention" value={87} hint="42 due today" />
      </div>
      <div className="dashboard-grid">
        <LineChart />
        <div className="focus-card">
          <div className="section-kicker">AI PRIORITY</div><h3>What should I study now?</h3>
          <div className="focus-topic"><div><span>Weakest high-value topic</span><b>CYP450 Metabolism</b></div><strong>52%</strong></div>
          <div className="focus-plan"><span>10 min Tutor</span><span>10 min Flashcards</span><span>15 min Questions</span></div>
          <button onClick={() => go("session")}>Start 35-min session</button>
        </div>
      </div>
      <div className="lower-grid">
        <div className="panel">
          <div className="panel-head"><div><b>Study activity</b><span>This week · 8h 24m</span></div><button onClick={() => go("progress")}>View analytics</button></div>
          <div className="bar-chart">{studyBars.map((v, i) => <div className="bar-col" key={i}><span style={{ height: `${v}%` }} /><small>{["M","T","W","T","F","S","S"][i]}</small></div>)}</div>
        </div>
        <div className="panel">
          <div className="panel-head"><div><b>Recent material</b><span>{documents.length ? `${documents.length} uploaded` : "Your active library"}</span></div><button onClick={() => go("library")}>Open library</button></div>
          {documents.length === 0 && <div className="empty-row">Upload your first document to start building your knowledge base.</div>}
          {documents.slice(0,3).map((d) => <div className="material-row" key={d.id}><span className="doc-icon">{d.mime_type === "application/pdf" ? "PDF" : "FILE"}</span><div><b>{d.title}</b><small>{formatBytes(d.size_bytes)} · {statusLabel(d.processing_status)}</small></div><strong>0%</strong></div>)}
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

function statusLabel(status: string) {
  if (status === "ready") return "Ready for AI";
  if (status === "processing") return "Processing";
  return "Uploaded";
}

function Library({ documents, upload, state, loading }: { documents: StudyDocument[]; upload: (f: File) => void; state: UploadState; loading: boolean }) {
  return <>
    <PageTitle kicker="KNOWLEDGE BASE" title="Study Library" text="Upload course material once. Every AI study mode will use it as the primary source of truth." />
    <div className="library-layout"><UploadCard onUpload={upload} state={state} /><div className="panel file-list">
      <div className="panel-head"><div><b>Your material</b><span>{documents.length} document{documents.length === 1 ? "" : "s"} in your private library</span></div></div>
      {loading && <div className="library-empty">Loading your library…</div>}
      {!loading && documents.length === 0 && <div className="library-empty"><b>No study material yet.</b><span>Upload a PDF and it will appear here permanently under your account.</span></div>}
      {documents.map((d)=><div className="material-row" key={d.id}><span className="doc-icon">{d.mime_type === "application/pdf" ? "PDF" : "FILE"}</span><div><b>{d.title}</b><small>{formatBytes(d.size_bytes)} · {d.page_count ? `${d.page_count} pages · ` : ""}{new Date(d.created_at).toLocaleDateString()}</small></div><span className={`status ${d.processing_status === "ready" ? "good" : ""}`}>{statusLabel(d.processing_status)}</span></div>)}
    </div></div>
    {state.status === "error" && <div className="upload-error">{state.message}</div>}
    <div className="panel pipeline"><b>AI processing pipeline</b><div className="pipeline-flow"><span className="done">Upload</span><i>→</i><span className="done">Private source</span><i>→</i><span className="done">Grounded context</span><i>→</i><span className="done">Citations</span><i>→</i><span className="done">Ready for AI</span></div><small className="pipeline-note">Phase 4 reads the selected private source directly for Tutor, Summary, Flashcards, and Questions.</small></div>
  </>
}

function PageTitle({ kicker, title, text }: { kicker:string; title:string; text:string }) {
  return <div className="page-title"><div className="eyebrow">{kicker}</div><h1>{title}</h1><p>{text}</p></div>
}


function StudySession({ userId, documents }: { userId: string; documents: StudyDocument[] }) {
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
    const r=await fetch('/api/study-sessions',{method:'POST',headers:{'content-type':'application/json','x-studyos-user-id':userId},body:JSON.stringify({title:'Pomodoro Study Session',mode:'pomodoro',documentId:documentId||null,focusMinutes,breakMinutes,targetCycles})});
    const d=await r.json(); if(!r.ok) throw new Error(d.error||'Could not start session');
    setSessionId(d.session.id); return d.session.id as string;
  }
  async function start(){
    try{ await ensureSession(); setRunning(true); setStatus(phase==='focus'?'Focus in progress':'Break in progress'); }catch(e){ setStatus(e instanceof Error?e.message:'Could not start'); }
  }
  async function completeInterval(){
    const id=await ensureSession();
    const planned=(phase==='focus'?focusMinutes:breakMinutes)*60;
    await fetch('/api/study-sessions',{method:'POST',headers:{'content-type':'application/json','x-studyos-user-id':userId},body:JSON.stringify({action:'interval',sessionId:id,intervalType:phase,plannedSeconds:planned,actualSeconds:planned,completed:true})});
    setRunning(false);
    if(phase==='focus'){ const next=cycles+1; setCycles(next); if(next>=targetCycles){ await finish(id); return; } setPhase('break'); setSecondsLeft(breakMinutes*60); setStatus('Focus complete · take a break'); }
    else { setPhase('focus'); setSecondsLeft(focusMinutes*60); setStatus('Break complete · ready to focus'); }
  }
  async function finish(id=sessionId){
    if(id) await fetch('/api/study-sessions',{method:'POST',headers:{'content-type':'application/json','x-studyos-user-id':userId},body:JSON.stringify({action:'finish',sessionId:id})});
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

function Tutor({ userId, documents }: { userId: string; documents: StudyDocument[] }) {
  const [message,setMessage]=useState("");
  const [documentId,setDocumentId]=useState(documents[0]?.id || "");
  const [result,setResult]=useState<AiTextResult | null>(null);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  async function ask(prompt=message) {
    if (!documentId || !prompt.trim()) { setError("Choose a document and enter a question."); return; }
    setLoading(true); setError("");
    try { setResult(await requestAi<AiTextResult>(userId,"tutor",documentId,prompt)); setMessage(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "AI Tutor failed"); }
    finally { setLoading(false); }
  }
  return <>
    <PageTitle kicker="ACTIVE LEARNING" title="AI Tutor" text="Ask questions grounded only in your uploaded study material, with source references." />
    <div className="tutor-grid"><div className="panel lesson-panel">
      <div className="ai-source-row"><label>Source<DocumentSelect documents={documents} value={documentId} onChange={setDocumentId}/></label><span className="ai-badge">SOURCE-GROUNDED</span></div>
      <div className="lesson-body ai-output">{!result && !loading && <div className="ai-empty"><b>Ask your first question</b><span>StudyOS will answer using only the selected file.</span></div>}{loading && <div className="ai-loading">Reading your material and preparing an answer…</div>}{result && <><h2>{result.title}</h2><p>{result.content}</p><div className="citation-list">{result.citations.map(source=><span className="source-chip" key={source}>{source}</span>)}</div></>}</div>
      {result && <div className="quick-actions">{result.followUps.map(item=><button key={item} onClick={()=>void ask(item)}>{item}</button>)}</div>}
      {error && <div className="upload-error">{error}</div>}
      <form className="chat-box" onSubmit={event=>{event.preventDefault();void ask();}}><input value={message} onChange={event=>setMessage(event.target.value)} placeholder="Ask about your notes…"/><button disabled={loading}>↑</button></form>
    </div><div className="panel tutor-side"><b>How grounding works</b><div className="grounding-steps"><span>1</span><p><b>Select a source</b>Your private document is loaded securely.</p><span>2</span><p><b>Ask naturally</b>Use English, Italian, or Persian.</p><span>3</span><p><b>Verify citations</b>Answers identify their source location.</p></div><small>Daily safeguard · up to 40 AI generations per account.</small></div></div>
  </>
}

function Summary({ userId, documents }: { userId: string; documents: StudyDocument[] }) {
  const [documentId,setDocumentId]=useState(documents[0]?.id || "");
  const [depth,setDepth]=useState("Detailed");
  const [result,setResult]=useState<AiTextResult | null>(null);
  const [loading,setLoading]=useState(false); const [error,setError]=useState("");
  async function generate(){ if(!documentId){setError("Choose study material first.");return;} setLoading(true);setError("");try{setResult(await requestAi<AiTextResult>(userId,"summary",documentId,`${depth} depth. Preserve the original structure and emphasize exam-relevant concepts.`));}catch(reason){setError(reason instanceof Error?reason.message:"Summary failed");}finally{setLoading(false);} }
  return <>
  <PageTitle kicker="SOURCE-GROUNDED" title="AI Summary" text="Generate revision notes at the depth you need without losing the structure of the original material." />
  <div className="summary-controls panel"><label>Material<DocumentSelect documents={documents} value={documentId} onChange={setDocumentId}/></label><label>Coverage<select><option>Entire document</option></select></label><label>Depth<select value={depth} onChange={event=>setDepth(event.target.value)}><option>Detailed</option><option>Standard</option><option>Quick</option></select></label><button className="primary" disabled={loading} onClick={()=>void generate()}>{loading?"Generating…":"Generate summary"}</button></div>
  {error&&<div className="upload-error">{error}</div>}
  <div className="panel article ai-output">{!result&&!loading&&<div className="ai-empty"><b>No summary generated yet</b><span>Select a document and choose the depth.</span></div>}{loading&&<div className="ai-loading">Building your source-grounded summary…</div>}{result&&<><div className="article-top"><span>{depth.toUpperCase()} SUMMARY</span><span>{result.citations.length} source references</span></div><h2>{result.title}</h2><p>{result.content}</p><div className="citation-list">{result.citations.map(source=><span className="source-chip" key={source}>{source}</span>)}</div></>}</div>
  </> }

function Flashcards({ userId, documents }: { userId: string; documents: StudyDocument[] }) {
  const [index,setIndex]=useState(0); const [flip,setFlip]=useState(false);
  const [documentId,setDocumentId]=useState(documents[0]?.id||""); const [cards,setCards]=useState<AiCard[]>([]);
  const [title,setTitle]=useState("Generated deck"); const [loading,setLoading]=useState(false); const [error,setError]=useState("");
  async function generate(){if(!documentId){setError("Choose study material first.");return;}setLoading(true);setError("");try{const data=await requestAi<{title:string;items:AiCard[]}>(userId,"flashcards",documentId,"Focus on high-yield concepts and common misconceptions.");setCards(data.items);setTitle(data.title);setIndex(0);setFlip(false);}catch(reason){setError(reason instanceof Error?reason.message:"Flashcards failed");}finally{setLoading(false);}}
  const card=cards[index];
  return <><PageTitle kicker="ACTIVE RECALL" title="Flashcards" text="Generate source-grounded cards directly from your own notes." /><div className="flash-layout"><div className="panel deck-info"><b>{title}</b><label>Material<DocumentSelect documents={documents} value={documentId} onChange={setDocumentId}/></label><button className="primary" disabled={loading} onClick={()=>void generate()}>{loading?"Generating…":"Generate 10 cards"}</button><small>{cards.length?`${cards.length} cards ready`:`Select a source to create a deck.`}</small></div>{error&&<div className="upload-error">{error}</div>}{card?<><div className={`flashcard ${flip?"flipped":""}`} onClick={()=>setFlip(!flip)}><div className="flash-meta"><span>SOURCE-GROUNDED</span><span>{index+1} / {cards.length}</span></div><h2>{flip?card.back:card.front}</h2><span className="tap-hint">{flip?card.citation:"Tap to reveal answer"}</span></div><div className="ratings">{["Again","Hard","Good","Easy"].map(x=><button key={x} onClick={()=>{setFlip(false);setIndex((index+1)%cards.length)}}>{x}</button>)}</div></>:<div className="panel ai-empty"><b>No cards yet</b><span>Generate a new deck from an uploaded document.</span></div>}</div></>
}

function Questions({ userId, documents, exams=false }: { userId: string; documents: StudyDocument[]; exams?: boolean }) {
  const [submitted,setSubmitted]=useState(false); const [answer,setAnswer]=useState(""); const [index,setIndex]=useState(0);
  const [documentId,setDocumentId]=useState(documents[0]?.id||""); const [questions,setQuestions]=useState<AiQuestion[]>([]);
  const [loading,setLoading]=useState(false); const [error,setError]=useState("");
  async function generate(){if(!documentId){setError("Choose study material first.");return;}setLoading(true);setError("");try{const data=await requestAi<{title:string;items:AiQuestion[]}>(userId,"questions",documentId,exams?"Use mixed difficulty and exam-style distractors.":"Prioritize active recall and concise explanations.");setQuestions(data.items);setIndex(0);setAnswer("");setSubmitted(false);}catch(reason){setError(reason instanceof Error?reason.message:"Question generation failed");}finally{setLoading(false);}}
  const question=questions[index];
  return <><PageTitle kicker={exams?"SIMULATION":"ACTIVE RECALL"} title={exams?"Exam Simulator":"Questions"} text={exams?"Simulate the real exam and measure readiness by topic.":"Upload existing question banks or generate questions directly from selected study material."} />
  <div className="panel exam-builder"><div className="builder-row"><label>Material<DocumentSelect documents={documents} value={documentId} onChange={setDocumentId}/></label><label>Type<select><option>Multiple Choice</option></select></label><label>Difficulty<select><option>Mixed</option><option>Easy</option><option>Medium</option><option>Hard</option></select></label><button className="primary" disabled={loading} onClick={()=>void generate()}>{loading?"Generating…":exams?"Build exam":"Generate questions"}</button></div></div>
  {error&&<div className="upload-error">{error}</div>}
  {question?<div className="panel question-card"><div className="question-top"><span>QUESTION {index+1} OF {questions.length}</span><span>SOURCE-GROUNDED</span></div><h2>{question.question}</h2>{question.options.map((option,i)=><label className={`option ${answer===option?"selected":""}`} key={option}><input type="radio" name="q" value={option} checked={answer===option} onChange={()=>setAnswer(option)}/><span>{String.fromCharCode(65+i)}</span>{option}</label>)}<div className="question-footer"><button className="ghost" disabled={index===0} onClick={()=>{setIndex(index-1);setSubmitted(false);setAnswer("");}}>Previous</button><button className="primary" disabled={!answer} onClick={()=>setSubmitted(true)}>Check answer</button></div>{submitted&&<div className={`result ${answer===question.answer?"correct":"wrong"}`}><b>{answer===question.answer?"Correct":"Review this concept"}</b><span>{question.explanation}</span><small>{question.citation}</small><button className="ghost" disabled={index>=questions.length-1} onClick={()=>{setIndex(index+1);setSubmitted(false);setAnswer("");}}>Next question</button></div>}</div>:<div className="panel ai-empty"><b>No questions generated yet</b><span>Choose a document to build a source-grounded practice set.</span></div>}</>
}

function Progress() {
  const topics=[["Pharmacokinetics",89],["Pharmacodynamics",81],["CYP450",63],["Drug interactions",58],["Receptor theory",52]] as const;
  return <><PageTitle kicker="MEASURABLE LEARNING" title="Progress & Analytics" text="See exactly what you know, what you are forgetting, and whether you are getting closer to the exam." />
  <div className="metrics-grid"><Metric label="Course progress" value={72}/><Metric label="Knowledge mastery" value={68}/><Metric label="Exam readiness" value={76}/><Metric label="Question accuracy" value={81}/></div>
  <div className="dashboard-grid"><LineChart/><div className="panel readiness"><div className="section-kicker">EXAM READINESS</div><div className="readiness-score"><strong>76%</strong><span>Good progress · On track</span></div>{[["Course coverage",91],["Knowledge mastery",73],["Question accuracy",82],["Flashcard retention",86]].map(([n,v])=><div className="factor" key={n as string}><span>{n}</span><div className="meter"><i style={{width:`${v}%`}}/></div><b>{v}%</b></div>)}</div></div>
  <div className="lower-grid"><div className="panel"><div className="panel-head"><div><b>Mastery by topic</b><span>Click a weak topic to review it</span></div></div><div className="topic-bars">{topics.map(([t,v])=><div key={t}><span>{t}</span><div className="meter"><i style={{width:`${v}%`}}/></div><b>{v}%</b></div>)}</div></div><div className="panel"><div className="panel-head"><div><b>Weekly consistency</b><span>Current streak · 8 days</span></div></div><div className="heatmap">{Array.from({length:35},(_,i)=><span key={i} style={{opacity:.15+((i*7)%10)/12}}/> )}</div><div className="stat-row"><span><b>8h 24m</b>Study time</span><span><b>327</b>Questions</span><span><b>412</b>Cards</span></div></div></div>
  <div className="panel weekly"><div><span className="section-kicker">THIS WEEK</span><h3>Visible improvement</h3></div><div className="weekly-change"><span>Overall mastery</span><b>61% <i>→</i> 68%</b><strong>+7%</strong></div><div className="weekly-change"><span>Biggest improvement</span><b>Pharmacokinetics</b><strong>+21%</strong></div><div className="weekly-change"><span>Priority weakness</span><b>Receptor theory</b><strong className="warn">52%</strong></div></div></>
}

export default function StudyApp() {
  const session = authClient.useSession();
  const userName = session.data?.user?.name || session.data?.user?.email?.split("@")[0] || "Student";
  const initials = userName.split(/\s+/).map((x:string)=>x[0]).join("").slice(0,2).toUpperCase();
  const userId = session.data?.user?.id || "";
  const [section,setSection]=useState<Section>("dashboard");
  const [documents,setDocuments]=useState<StudyDocument[]>([]);
  const [libraryLoading,setLibraryLoading]=useState(true);
  const [uploadState,setUploadState]=useState<UploadState>({status:"idle"});
  const [collapsed,setCollapsed]=useState(false);
  const [signingOut,setSigningOut]=useState(false);
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
      const response = await fetch("/api/documents", { headers: { "x-studyos-user-id": userId } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load library");
      setDocuments(data.documents || []);
    } catch (error) {
      console.error(error);
    } finally {
      setLibraryLoading(false);
    }
  }

  useEffect(() => { void loadDocuments(); }, [userId]);

  async function handleUpload(file: File) {
    if (!userId) return;
    setSection("library");
    setUploadState({ status: "uploading", message: `${file.name} · ${formatBytes(file.size)}` });
    try {
      const blob = await uploadBlob(`users/${userId}/documents/${file.name}`, file, {
        access: "private",
        handleUploadUrl: "/api/documents/upload",
        clientPayload: JSON.stringify({ userId }),
      });
      setUploadState({ status: "saving", message: "Upload complete. Saving document metadata…" });
      const title = file.name.replace(/\.[^/.]+$/, "");
      const response = await fetch("/api/documents", {
        method: "POST",
        headers: { "content-type": "application/json", "x-studyos-user-id": userId },
        body: JSON.stringify({
          title, originalName: file.name, fileUrl: blob.url, pathname: blob.pathname, mimeType: file.type || "application/octet-stream", sizeBytes: file.size, sourceLanguage: "it", explanationLanguage: "it"
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save document");
      setDocuments((current) => [data.document, ...current]);
      setUploadState({ status: "done", message: "Uploaded successfully. Ready for AI study tools." });
      setTimeout(() => setUploadState({status:"idle"}), 4000);
    } catch (error) {
      setUploadState({ status: "error", message: error instanceof Error ? error.message : "Upload failed" });
    }
  }
  return <div className={`app ${collapsed?"collapsed":""}`}>
    <aside className="sidebar"><div className="brand"><div className="brand-mark">S</div><div><b>StudyOS</b><span>AI Learning System</span></div></div><nav>{nav.map(x=><button key={x.id} className={section===x.id?"active":""} onClick={()=>setSection(x.id)}><span>{x.icon}</span><b>{x.label}</b></button>)}</nav><div className="sidebar-bottom"><button className="upload-small" onClick={()=>setSection("library")}><span>＋</span><b>Upload material</b></button><div className="profile"><span>{initials}</span><div><b>{userName}</b><small>Signed in</small></div></div><button className="signout" onClick={()=>void handleSignOut()} disabled={signingOut}><span>↪</span><b>{signingOut?"Logging out…":"Log out"}</b></button></div></aside>
    <main><header><button className="collapse" onClick={()=>setCollapsed(!collapsed)}>☰</button><span className="mobile-title">{title}</span><div className="header-actions"><div className="global-progress"><span>Exam in 12 days</span><b>76% ready</b></div><button className="icon-btn">⌕</button><button className="icon-btn">◐</button></div></header><div className="content">
      {section==="dashboard"&&<Dashboard go={setSection} documents={documents}/>} {section==="session"&&<StudySession userId={userId} documents={documents}/>} {section==="library"&&<Library documents={documents} upload={handleUpload} state={uploadState} loading={libraryLoading}/>} {section==="tutor"&&<Tutor userId={userId} documents={documents}/>} {section==="summary"&&<Summary userId={userId} documents={documents}/>} {section==="flashcards"&&<Flashcards userId={userId} documents={documents}/>} {section==="questions"&&<Questions userId={userId} documents={documents}/>} {section==="exams"&&<Questions userId={userId} documents={documents} exams/>} {section==="progress"&&<Progress/>}
    </div></main>
  </div>
}
