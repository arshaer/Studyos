import assert from "node:assert/strict";
import test from "node:test";
import { actionInstruction, chunksForStage, compactRecentTurns, isNearExam, isProfessorAction, learningStateForScore, nextAdaptivePhase, nextLessonState, selectRetrievalChunks } from "../src/lib-professor.ts";

test("Professor advances one concept and enters doubt clearing after the final stage", () => {
  assert.deepEqual(nextLessonState(0, 4), { currentStage: 1, status: "learning" });
  assert.deepEqual(nextLessonState(3, 4), { currentStage: 4, status: "doubt_clearing" });
});

test("adaptive loop reteaches gaps and advances demonstrated understanding", () => {
  assert.equal(nextAdaptivePhase("verify", "needs_review"), "reteach");
  assert.equal(nextAdaptivePhase("verify", "correct"), "connect");
  assert.equal(nextAdaptivePhase("exam_test", "correct"), "advance");
  assert.equal(learningStateForScore(82, true), "exam_ready");
  assert.equal(learningStateForScore(94, true), "mastered");
});

test("exam mode and compact retrieval keep prompts bounded", () => {
  assert.equal(isNearExam("2026-09-18", new Date("2026-09-08T12:00:00Z")), true);
  const chunks=Array.from({length:10},(_,chunk_index)=>({chunk_index,content:`topic ${chunk_index}`,page_start:chunk_index+1,page_end:chunk_index+1,section:"A"}));
  const selected=selectRetrievalChunks(chunks,{id:"x",title:"Topic",purpose:"learn",keyTerms:[],chunkIndexes:[1,2,3,4,5,6,7]},[2],4);
  assert.deepEqual(selected.map(x=>x.chunk_index),[1,3,4,5]);
  assert.equal(compactRecentTurns(Array.from({length:9},(_,i)=>({role:"student",text:`${i}`.repeat(1000)}))).length,6);
});

test("all five quick actions are valid and have distinct teaching behavior", () => {
  const actions = ["simpler", "deeper", "example", "comparison", "why"] as const;
  const instructions = actions.map(action => actionInstruction(action));
  assert.equal(instructions.length, new Set(instructions).size);
  for (const action of actions) assert.equal(isProfessorAction(action), true);
  assert.equal(isProfessorAction("continue"), false);
});

test("stage retrieval selects only planned original chunk indexes", () => {
  const chunks = [
    { chunk_index: 10, content: "neurone", page_start: 2, page_end: 2, section: "A" },
    { chunk_index: 11, content: "sinapsi", page_start: 3, page_end: 3, section: "A" },
    { chunk_index: 12, content: "glia", page_start: 4, page_end: 4, section: "A" },
  ];
  const selected = chunksForStage(chunks, { id: "concept-1", title: "Sinapsi", purpose: "trasmissione", keyTerms: ["recettore"], chunkIndexes: [11, 12] });
  assert.deepEqual(selected.map(chunk => chunk.chunk_index), [11, 12]);
});
