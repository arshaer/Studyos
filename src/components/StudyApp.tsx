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
  return "Uploaded · AI processing next";
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
    <div className="panel pipeline"><b>AI processing pipeline</b><div className="pipeline-flow"><span className="done">Upload</span><i>→</i><span>Extract text</span><i>→</i><span>Detect sections</span><i>→</i><span>Create chunks</span><i>→</i><span>Source index</span><i>→</i><span>Ready for AI</span></div><small className="pipeline-note">File storage + Library are live now. Text extraction and AI indexing are the next build step.</small></div>
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

function Tutor() {
  const [message,setMessage]=useState("");
  const [log,setLog]=useState<string[]>([]);
  return <>
    <PageTitle kicker="ACTIVE LEARNING" title="AI Tutor" text="A source-grounded tutor that teaches the notes step by step instead of merely summarizing them." />
    <div className="tutor-grid"><div className="panel lesson-panel">
      <div className="lesson-head"><div><span>Pharmacology · Drug Metabolism</span><h3>CYP450 system</h3></div><div className="mini-progress"><span>Lesson 4 / 7</span><b>58%</b></div></div>
      <div className="lesson-body"><span className="ai-badge">AI TUTOR</span><h2>Let’s build the mechanism from the beginning.</h2><p>Cytochrome P450 enzymes are a superfamily of heme-containing monooxygenases. In your uploaded notes, this section connects drug oxidation with NADPH, molecular oxygen and the catalytic heme group.</p><div className="concept-box"><b>Core mechanism</b><ol><li>Substrate binds near the heme iron.</li><li>Electrons are transferred from NADPH.</li><li>Molecular oxygen is activated.</li><li>One oxygen atom is incorporated into the substrate.</li><li>The second oxygen atom becomes water.</li></ol></div><div className="source-chip">Source · General Pharmacology.pdf · p. 37–39</div>
      {log.map((m,i)=><div className="user-msg" key={i}>{m}</div>)}</div>
      <div className="quick-actions">{["Explain more simply","Go deeper","Give an example","Ask me a question","Compare concepts"].map(x=><button key={x} onClick={()=>setLog(v=>[...v,x])}>{x}</button>)}</div>
      <form className="chat-box" onSubmit={e=>{e.preventDefault();if(message.trim()){setLog(v=>[...v,message]);setMessage("")}}}><input value={message} onChange={e=>setMessage(e.target.value)} placeholder="Ask about this part of your notes…"/><button>↑</button></form>
    </div><div className="panel tutor-side"><b>Lesson progress</b><div className="ring" style={{"--p":"58%"} as React.CSSProperties}><span>58%</span></div><div className="topic-list"><div><span>Introduction</span><b>100%</b></div><div><span>Heme group</span><b>100%</b></div><div><span>NADPH transfer</span><b>78%</b></div><div className="active"><span>Oxygen activation</span><b>58%</b></div><div><span>Phase I reactions</span><b>32%</b></div></div></div></div>
  </>
}

function Summary() { return <>
  <PageTitle kicker="SOURCE-GROUNDED" title="AI Summary" text="Generate revision notes at the depth you need without losing the structure of the original material." />
  <div className="summary-controls panel"><label>Material<select><option>General Pharmacology.pdf</option></select></label><label>Coverage<select><option>CYP450 · pages 37–44</option><option>Entire document</option></select></label><label>Depth<select><option>Detailed</option><option>Standard</option><option>Quick</option></select></label><button className="primary">Generate summary</button></div>
  <div className="panel article"><div className="article-top"><span>DETAILED SUMMARY</span><span>Source: p. 37–44</span></div><h2>Cytochrome P450 and Phase I metabolism</h2><p>Cytochrome P450 enzymes catalyze oxidation reactions that typically increase the polarity of lipophilic compounds and prepare them for subsequent elimination or conjugation.</p><h3>1. Catalytic components</h3><div className="definition-grid"><div><b>CYP enzyme</b><span>Heme-containing monooxygenase</span></div><div><b>Electron source</b><span>NADPH</span></div><div><b>Oxidant</b><span>Molecular oxygen</span></div></div><h3>2. High-yield mechanism</h3><p>The substrate binds close to the heme group. Electrons ultimately originating from NADPH allow activation of oxygen. One atom is incorporated into the substrate while the second is reduced to water.</p><div className="high-yield"><b>High-yield exam point</b><span>The P450 reaction is a monooxygenation: one oxygen atom enters the substrate, the other forms H₂O.</span></div></div>
  </> }

function Flashcards() {
  const [index,setIndex]=useState(0); const [flip,setFlip]=useState(false);
  const cards=[
    ["What is the role of NADPH in CYP450 reactions?","It provides reducing equivalents/electrons required for the catalytic cycle."],
    ["Why is CYP450 called a monooxygenase?","Because one oxygen atom is inserted into the substrate while the second is reduced to water."],
    ["Where is the catalytic iron located?","Inside the heme group of the CYP enzyme."],
  ];
  return <><PageTitle kicker="SPACED REPETITION" title="Flashcards" text="Cards generated from your own notes and prioritized by memory strength." /><div className="flash-layout"><div className="panel deck-info"><b>CYP450 · Generated deck</b><div className="deck-stats"><span><strong>42</strong>Due</span><span><strong>87%</strong>Retention</span><span><strong>12</strong>Difficult</span></div><div className="meter"><span style={{width:"68%"}}/></div><small>34 / 50 reviewed today</small></div><div className={`flashcard ${flip?"flipped":""}`} onClick={()=>setFlip(!flip)}><div className="flash-meta"><span>CONCEPT · MEDIUM</span><span>{index+1} / {cards.length}</span></div><h2>{flip?cards[index][1]:cards[index][0]}</h2><span className="tap-hint">{flip?"Rate your recall":"Tap to reveal answer"}</span></div><div className="ratings">{["Again","Hard","Good","Easy"].map(x=><button key={x} onClick={()=>{setFlip(false);setIndex((index+1)%cards.length)}}>{x}</button>)}</div></div></>
}

function Questions({ exams=false }: { exams?: boolean }) {
  const [submitted,setSubmitted]=useState(false); const [answer,setAnswer]=useState("");
  return <><PageTitle kicker={exams?"SIMULATION":"ACTIVE RECALL"} title={exams?"Exam Simulator":"Questions"} text={exams?"Simulate the real exam and measure readiness by topic.":"Upload existing question banks or generate questions directly from selected study material."} />
  {!exams && <div className="mode-cards"><div className="panel mode-card"><span>↑</span><b>Upload question file</b><p>Import PDF, DOCX, TXT or image-based question banks.</p><button>Upload questions</button></div><div className="panel mode-card"><span>✦</span><b>Generate with AI</b><p>Create source-grounded questions from your selected notes.</p><button>Configure generator</button></div></div>}
  <div className="panel exam-builder"><div className="builder-row"><label>Exam type<select><option>Multiple Choice</option><option>True / False</option><option>Short Answer</option><option>Open-Ended Written</option><option>Oral Exam</option><option>Mixed Exam</option></select></label><label>Difficulty<select><option>Mixed</option><option>Easy</option><option>Medium</option><option>Hard</option></select></label><label>Questions<select><option>10</option><option>20</option><option>30</option><option>50</option></select></label><label>Coverage<select><option>CYP450</option><option>Entire document</option></select></label></div></div>
  <div className="panel question-card"><div className="question-top"><span>QUESTION 1 OF 10</span><span>Pharmacology · CYP450</span></div><h2>Which statement best describes the role of molecular oxygen in the CYP450 catalytic cycle?</h2>{["Both oxygen atoms are incorporated into the substrate.","One oxygen atom enters the substrate and one forms water.","Oxygen acts only as an electron donor.","Oxygen is not required when NADPH is present."].map((x,i)=><label className={`option ${answer===x?"selected":""}`} key={x}><input type="radio" name="q" value={x} checked={answer===x} onChange={()=>setAnswer(x)}/><span>{String.fromCharCode(65+i)}</span>{x}</label>)}<div className="question-footer"><button className="ghost">Flag question</button><button className="primary" onClick={()=>setSubmitted(true)}>Check answer</button></div>{submitted&&<div className={`result ${answer.includes("One oxygen")?"correct":"wrong"}`}><b>{answer.includes("One oxygen")?"Correct":"Review this concept"}</b><span>One oxygen atom is incorporated into the substrate while the other is reduced to water.</span><small>Source · General Pharmacology.pdf · p. 39</small></div>}</div></>
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
      setUploadState({ status: "done", message: "Uploaded successfully. Ready for the AI processing step." });
      setTimeout(() => setUploadState({status:"idle"}), 4000);
    } catch (error) {
      setUploadState({ status: "error", message: error instanceof Error ? error.message : "Upload failed" });
    }
  }
  return <div className={`app ${collapsed?"collapsed":""}`}>
    <aside className="sidebar"><div className="brand"><div className="brand-mark">S</div><div><b>StudyOS</b><span>AI Learning System</span></div></div><nav>{nav.map(x=><button key={x.id} className={section===x.id?"active":""} onClick={()=>setSection(x.id)}><span>{x.icon}</span><b>{x.label}</b></button>)}</nav><div className="sidebar-bottom"><button className="upload-small" onClick={()=>setSection("library")}><span>＋</span><b>Upload material</b></button><div className="profile"><span>{initials}</span><div><b>{userName}</b><small>Signed in</small></div></div><button className="signout" onClick={()=>void handleSignOut()} disabled={signingOut}><span>↪</span><b>{signingOut?"Logging out…":"Log out"}</b></button></div></aside>
    <main><header><button className="collapse" onClick={()=>setCollapsed(!collapsed)}>☰</button><span className="mobile-title">{title}</span><div className="header-actions"><div className="global-progress"><span>Exam in 12 days</span><b>76% ready</b></div><button className="icon-btn">⌕</button><button className="icon-btn">◐</button></div></header><div className="content">
      {section==="dashboard"&&<Dashboard go={setSection} documents={documents}/>} {section==="session"&&<StudySession userId={userId} documents={documents}/>} {section==="library"&&<Library documents={documents} upload={handleUpload} state={uploadState} loading={libraryLoading}/>} {section==="tutor"&&<Tutor/>} {section==="summary"&&<Summary/>} {section==="flashcards"&&<Flashcards/>} {section==="questions"&&<Questions/>} {section==="exams"&&<Questions exams/>} {section==="progress"&&<Progress/>}
    </div></main>
  </div>
}
