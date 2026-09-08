"use client";
import { useEffect, useState } from "react";

type Props = {
  task: {
    id: string;
    title: string;
    page_start?: number;
    page_end?: number;
  } | null;
};
const actions = [
  ["simpler", "Explain simpler"],
  ["deeper", "Go deeper"],
  ["example", "Give example"],
  ["comparison", "Show comparison"],
  ["why", "Why?"],
] as const;
function Inline({ text }: { text: string }) {
  return <>{text.split(/(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`)/g).filter(Boolean).map((part, index) =>
    (part.startsWith("**") && part.endsWith("**")) || (part.startsWith("__") && part.endsWith("__"))
      ? <strong key={index}>{part.slice(2, -2)}</strong>
      : part.startsWith("`") && part.endsWith("`")
        ? <code key={index}>{part.slice(1, -1)}</code>
        : <span key={index}>{part}</span>)}</>;
}
function Rich({ text }: { text: string }) {
  const lines=String(text||"").replace(/\r/g,"").split("\n"),nodes=[] as React.ReactNode[];let index=0;
  while(index<lines.length){const line=lines[index].trim();if(!line){index++;continue}
    const heading=line.match(/^(#{1,4})\s+(.+)$/);if(heading){nodes.push(heading[1].length===1?<h2 key={index}><Inline text={heading[2]}/></h2>:<h3 key={index}><Inline text={heading[2]}/></h3>);index++;continue}
    if(/^[-*]\s+/.test(line)){const items=[] as string[];while(index<lines.length&&/^[-*]\s+/.test(lines[index].trim())){items.push(lines[index].trim().replace(/^[-*]\s+/,""));index++}nodes.push(<ul key={`ul-${index}`}>{items.map((item,itemIndex)=><li key={itemIndex}><Inline text={item}/></li>)}</ul>);continue}
    if(/^\d+[.)]\s+/.test(line)){const items=[] as string[];while(index<lines.length&&/^\d+[.)]\s+/.test(lines[index].trim())){items.push(lines[index].trim().replace(/^\d+[.)]\s+/,""));index++}nodes.push(<ol key={`ol-${index}`}>{items.map((item,itemIndex)=><li key={itemIndex}><Inline text={item}/></li>)}</ol>);continue}
    const paragraph=[line];index++;while(index<lines.length&&lines[index].trim()&&!/^(#{1,4})\s+|^[-*]\s+|^\d+[.)]\s+/.test(lines[index].trim())){paragraph.push(lines[index].trim());index++}nodes.push(<p key={`p-${index}`}><Inline text={paragraph.join(" ")}/></p>)}
  return <div className="rich-ai-text professor-prose">{nodes}</div>;
}
async function patch(
  lessonId: string,
  action: string,
  extra: Record<string, unknown> = {},
) {
  const response = await fetch("/api/professor", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lessonId, action, ...extra }),
    }),
    data = await response.json();
  if (!response.ok) throw data;
  return data;
}

export function ProfessorExperience({ task }: Props) {
  const [lesson, setLesson] = useState<any>(null),
    [section, setSection] = useState<any>(null),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [answer, setAnswer] = useState(""),
    [doubt, setDoubt] = useState(""),
    [masteryAnswers, setMasteryAnswers] = useState<string[]>([]),
    [result, setResult] = useState<any>(null),
    [started,setStarted]=useState(false),
    [quickVerification,setQuickVerification]=useState<any>(null),
    [examProfile,setExamProfile]=useState({examDate:"",examFormat:"mixed",confidence:"medium",availableStudyDays:"",professorNotes:""});
  async function load(profile=examProfile) {
    if (!task) return;
    setBusy("load");
    setError("");
    try {
      const response = await fetch("/api/professor", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ taskId: task.id, examProfile: profile }),
        }),
        data = await response.json();
      if (!response.ok) throw data;
      setLesson(data.lesson);
      setSection(data.section);
    } catch (caught: any) {
      setError(
        String(
          caught?.error ||
            "The lesson could not be created. Your progress is safe; retry.",
        ),
      );
    } finally {
      setBusy("");
    }
  }
  useEffect(() => { setStarted(false); setLesson(null); }, [task?.id]);
  if (!task)
    return (
      <>
        <div className="page-title">
          <span>TEACH ME</span>
          <h1>Professor</h1>
          <p>Open an indexed Tutor item to begin.</p>
        </div>
        <div className="panel empty-row">Choose Start lesson from Tutor.</div>
      </>
    );
  if(!started) return <>
    <div className="page-title"><span>PROFESSOR · EXAM SETUP</span><h1>Prepare for your real exam</h1><p>Professor adapts teaching, recall, and practice to this target. You can leave unknown details blank.</p></div>
    <form className="panel professor-onboarding" onSubmit={event=>{event.preventDefault();setStarted(true);void load();}}>
      <label>Exam date (optional)<input type="date" value={examProfile.examDate} onChange={e=>setExamProfile(p=>({...p,examDate:e.target.value}))}/></label>
      <label>Exam format<select value={examProfile.examFormat} onChange={e=>setExamProfile(p=>({...p,examFormat:e.target.value}))}><option value="oral">Oral</option><option value="mcq">Multiple choice</option><option value="written">Written open-answer</option><option value="calculations">Calculations / problems</option><option value="mixed">Mixed</option></select></label>
      <label>Current confidence<select value={examProfile.confidence} onChange={e=>setExamProfile(p=>({...p,confidence:e.target.value}))}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
      <label>Available study days<input type="number" min="1" value={examProfile.availableStudyDays} onChange={e=>setExamProfile(p=>({...p,availableStudyDays:e.target.value}))}/></label>
      <label className="wide">Professor notes or past-question clues (optional)<textarea value={examProfile.professorNotes} onChange={e=>setExamProfile(p=>({...p,professorNotes:e.target.value}))}/></label>
      <button className="primary">Begin adaptive lesson</button>
    </form>
  </>;
  const data = lesson?.stages_json || {},
    stages = data.stages || [],
    index = Number(lesson?.current_stage || 0),
    stage = stages[index],
    questions = lesson?.mastery_questions_json || [],
    expansions = (lesson?.interactions_json || []).filter(
      (x: any) => Number(x.stageIndex) === index,
    ),
    check = (lesson?.stage_checks_json || []).find(
      (x: any) => Number(x.stageIndex) === index,
    ),
    doubts = lesson?.doubts_json || [];
  async function run(action: string, extra: Record<string, unknown> = {}) {
    if (!lesson || busy) return;
    setBusy(action);
    setError("");
    try {
      const response = await patch(lesson.id, action, {
        stageIndex: index,
        ...extra,
      });
      if (response.lesson) setLesson(response.lesson);
      if(response.quickVerification)setQuickVerification(response.quickVerification);
      return response;
    } catch (caught: any) {
      setError(
        String(
          caught?.error ||
            "The AI is temporarily unavailable. Your progress is safe; retry.",
        ),
      );
    } finally {
      setBusy("");
    }
  }
  return (
    <>
      <div className="page-title">
        <span>PROFESSOR · GUIDED LESSON</span>
        <h1>{section?.section_title || task.title}</h1>
        <p>
          {section?.original_name || "Course"} › pages{" "}
          {section?.page_start || task.page_start}–
          {section?.page_end || task.page_end}
        </p>
      </div>
      {busy === "load" && !lesson ? (
        <div className="panel ai-loading">
          Professor is inspecting the full indexed section and building its
          lesson plan…
        </div>
      ) : null}
      {error ? (
        <div className="panel ai-recovery">
          <b>{error}</b>
          <button onClick={() => setError("")}>Dismiss</button>
        </div>
      ) : null}
      {lesson ? (
        <div className="tutor-grid professor-workspace">
          <article className="panel lesson-panel">
            <div className="lesson-head">
              <div>
                <span>
                  {stage
                    ? `CONCEPT ${index + 1} OF ${stages.length}`
                    : "DOUBT CLEARING & MASTERY"}
                </span>
                <h3>{stage?.title || "Consolidamento finale"}</h3>
              </div>
              <div className="mini-progress">
                <span>LESSON PROGRESS</span>
                <b>
                  {Math.round(
                    Math.min(100, (index / Math.max(1, stages.length)) * 100),
                  )}
                  %
                </b>
              </div>
            </div>
            <div className="lesson-progress-track">
              <span
                style={{
                  width: `${Math.min(100, (index / Math.max(1, stages.length)) * 100)}%`,
                }}
              />
            </div>
            <div className="lesson-body ai-output">
              {index === 0 && stage ? (
                <section className="lesson-overview">
                  <h3>Obiettivi di apprendimento</h3>
                  <ul>
                    {(data.objectives || []).map((x: string) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                  <h3>Mappa concettuale</h3>
                  <ol>
                    {(data.conceptMap || []).map((x: string) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ol>
                </section>
              ) : null}
              {stage ? (
                <>
                  <h2>{stage.title}</h2>
                  <p className="concept-purpose">{stage.purpose}</p>
                  <Rich text={stage.content} />
                  <div className="citation-list">
                    {(stage.citations || []).map((x: string) => (
                      <span className="source-chip" key={x}>
                        {x}
                      </span>
                    ))}
                  </div>
                  {expansions.map((x: any) => (
                    <aside
                      className={`teaching-expansion expansion-${x.action}`}
                      key={x.id}
                    >
                      <span>
                        {actions.find((a) => a[0] === x.action)?.[1] ||
                          x.action}
                      </span>
                      <Rich text={x.content} />
                      <div className="citation-list">
                        {(x.citations || []).map((c: string) => (
                          <span className="source-chip" key={c}>
                            {c}
                          </span>
                        ))}
                      </div>
                    </aside>
                  ))}
                  <div
                    className="quick-actions"
                    aria-label="Quick teaching actions"
                  >
                    {actions.map(([action, label]) => (
                      <button
                        key={action}
                        disabled={Boolean(busy)}
                        onClick={() => void run(action)}
                      >
                        {busy === action ? "Teaching…" : label}
                      </button>
                    ))}
                    <button disabled={Boolean(busy)} onClick={() => void run("explain_differently")}>Explain differently</button>
                    <button disabled={Boolean(busy)} onClick={() => void run("test_me")}>Test me</button>
                    <button disabled={Boolean(busy)} onClick={() => void run("exam_appearance")}>How could this appear on my exam?</button>
                  </div>
                  <div className="professor-primary-actions"><button className="secondary" disabled={Boolean(busy)} onClick={()=>void run("skip")}>Skip · I already know this</button></div>
                  {quickVerification?<section className="concept-box skip-check"><b>Optional 15-second check</b><p>{quickVerification.question}</p><small>Answer through the comprehension check below, or force-skip. A failed check flags a gap but never traps you here.</small><button className="secondary" disabled={Boolean(busy)} onClick={()=>void run("force_skip")}>Force skip anyway</button></section>:null}
                  <section className="concept-box checkpoint-box">
                    <b>Comprehension check</b>
                    <p>{stage.check}</p>
                    {check ? (
                      <div className={`checkpoint-feedback ${check.verdict}`}>
                        <b>{check.verdict.replaceAll("_", " ")}</b>
                        <p>{check.feedback}</p>
                        <small>What you understood: {check.strength}</small>
                        <small>Correction: {check.correction}</small>
                        <small>Next step: {check.nextStep}</small>
                      </div>
                    ) : (
                      <>
                        <textarea
                          aria-label="Your comprehension answer"
                          value={answer}
                          onChange={(e) => setAnswer(e.target.value)}
                          placeholder="Spiega con parole tue…"
                        />
                        <button
                          className="secondary"
                          disabled={Boolean(busy) || answer.trim().length < 2}
                          onClick={() => void run("comprehension", { answer })}
                        >
                          {busy === "comprehension"
                            ? "Professor is reviewing…"
                            : "Submit answer"}
                        </button>
                      </>
                    )}
                  </section>
                  <button
                    className="primary continue-button"
                    disabled={Boolean(busy) || !check}
                    onClick={() => void run("stage")}
                  >
                    {busy === "stage"
                      ? "Preparing next concept…"
                      : check?.verdict === "needs_review" ? "Repair this gap before continuing" : index === stages.length - 1
                        ? "I understand · begin final review"
                        : "I understand · continue"}
                  </button>
                </>
              ) : (
                <>
                  <h2>Recap, doubts & mastery</h2>
                  <p>
                    The lesson stages are complete, but the section is not
                    mastered yet. Resolve doubts, then complete the mastery
                    check.
                  </p>
                  <ul>
                    {(data.recap || []).map((x: string) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                  {doubts.map((x: any) => (
                    <aside className="teaching-expansion" key={x.id}>
                      <b>Domanda: {x.question}</b>
                      <Rich text={x.answer} />
                      <div className="citation-list">
                        {(x.citations || []).map((c: string) => (
                          <span className="source-chip" key={c}>
                            {c}
                          </span>
                        ))}
                      </div>
                    </aside>
                  ))}
                  <section className="doubt-composer">
                    <h3>Hai ancora dubbi?</h3>
                    <textarea
                      value={doubt}
                      onChange={(e) => setDoubt(e.target.value)}
                      placeholder="Chiedi un chiarimento…"
                    />
                    <button
                      className="secondary"
                      disabled={Boolean(busy) || doubt.trim().length < 2}
                      onClick={() => void run("doubt", { question: doubt })}
                    >
                      {busy === "doubt" ? "Answering…" : "Clarify this doubt"}
                    </button>
                  </section>
                  <h3>Mastery check</h3>
                  {questions.map((q: any, i: number) => (
                    <label className="mastery-question" key={i}>
                      <b>
                        {i + 1}. {q.question}
                      </b>
                      <textarea
                        value={masteryAnswers[i] || ""}
                        onChange={(e) =>
                          setMasteryAnswers((a) => {
                            const n = [...a];
                            n[i] = e.target.value;
                            return n;
                          })
                        }
                      />
                    </label>
                  ))}
                  <button
                    className="primary"
                    disabled={
                      Boolean(busy) ||
                      masteryAnswers.filter(Boolean).length < questions.length
                    }
                    onClick={async () => {
                      setBusy("mastery");
                      try {
                        setResult(
                          await patch(lesson.id, "mastery", {
                            answers: masteryAnswers,
                          }),
                        );
                      } catch (caught: any) {
                        setError(String(caught?.error || "Assessment failed"));
                      } finally {
                        setBusy("");
                      }
                    }}
                  >
                    {busy === "mastery"
                      ? "Assessing…"
                      : "Complete mastery check"}
                  </button>
                  {result ? (
              <div
                      className={`result ${result.status === "mastered" ? "correct" : "wrong"}`}
                    >
                      <b>
                        {result.score}% · {result.status.replaceAll("_", " ")}
                      </b>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </article>
          <aside className="panel tutor-side">
            <b>Lesson structure</b>
            <small>{stages.length} source-grounded concepts</small>
            <div className="topic-list">
              {stages.map((x: any, i: number) => (
                <div
                  className={i === index ? "active" : ""}
                  key={x.id || x.title}
                >
                  <span>{x.title}</span>
                  <b>
                    {(lesson.completed_stages_json || []).includes(i)
                      ? "✓"
                      : i + 1}
                  </b>
                  {x.cached?<small>cached</small>:null}
                </div>
              ))}
            </div>
          </aside>
        </div>
      ) : null}
    </>
  );
}
