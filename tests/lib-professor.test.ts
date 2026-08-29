import assert from "node:assert/strict";
import test from "node:test";
import { actionInstruction, chunksForStage, isProfessorAction, nextLessonState } from "../src/lib-professor.ts";

test("Professor advances one concept and enters doubt clearing after the final stage", () => {
  assert.deepEqual(nextLessonState(0, 4), { currentStage: 1, status: "learning" });
  assert.deepEqual(nextLessonState(3, 4), { currentStage: 4, status: "doubt_clearing" });
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
