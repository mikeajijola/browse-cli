import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { paths } from "../src/util.mjs";
import { Worker } from "../src/worker.mjs";

function fixture(t, agent) {
  const p = paths(fs.mkdtempSync(path.join(os.tmpdir(), "browse-worker-"))),
    worker = new Worker(p, { agent });
  worker.initialize();
  t.after(() => {
    worker.store.close();
    fs.rmSync(p.root, { recursive: true, force: true });
  });
  return worker;
}
const success = async () => ({ answer: "Done", result: { usage: {} } });

test("workflow waits and input survive worker recreation without executing browser steps early", async (t) => {
  let calls = 0;
  const worker = fixture(t, async () => {
    calls++;
    return success();
  });
  worker.store.saveWorkflow({
    format: "browse.workflow/v1",
    name: "demo",
    steps: [
      { type: "wait", duration: "10ms" },
      { type: "input", question: "Which account?" },
      { type: "browser", task: "Read account" },
    ],
  });
  const run = await worker.dispatch("workflow_run", { name: "demo" });
  await worker.tick();
  assert.equal(worker.store.run(run.id).state, "waiting");
  assert.equal(calls, 0);
  await new Promise((r) => setTimeout(r, 20));
  await worker.tick();
  assert.equal(worker.store.run(run.id).question, "Which account?");
  await worker.dispatch("respond", { id: run.id, answer: "Personal" });
  await worker.tick();
  assert.equal(calls, 1);
  assert.equal(worker.store.run(run.id).state, "completed");
});

test("uncertain side effects pause and enter read-only recovery", async (t) => {
  let call = 0;
  const worker = fixture(t, async ({ store, run }) => {
    call++;
    if (call === 1) {
      store.actionStart(run.id, "act", { kind: "click" });
      throw Error("Network lost");
    }
    return {
      answer: "Unclear",
      recovery: true,
      control: { type: "input", question: "The submission is still uncertain. Which page do you see?" },
      unresolved: store.actions(run.id).filter((a) => a.state === "dispatched"),
    };
  });
  const run = await worker.dispatch("submit", { task: "Submit form" });
  await worker.tick();
  assert.equal(worker.store.run(run.id).state, "waiting");
  assert.equal(worker.store.actions(run.id).length, 1);
  assert.equal(worker.store.run(run.id).recoveryNeeded, true);
  // Transport failure retries automatically into read-only recovery. The model
  // asks for a person only after observations leave the outcome uncertain.
  const retry = worker.store.run(run.id);
  assert.equal(retry.question, undefined);
  retry.wakeAt = Date.now() - 1;
  worker.store.saveRun(retry);
  await worker.tick();
  assert.match(worker.store.run(run.id).question, /uncertain/);
  await worker.dispatch("respond", {
    id: run.id,
    answer: "I see a confirmation",
  });
  await worker.tick();
  assert.equal(worker.store.run(run.id).state, "waiting");
  assert.equal(worker.store.actions(run.id).length, 1);
});

test("worker startup recovers a running turn without replaying completed actions", async (t) => {
  const worker = fixture(t, success);
  const run = worker.store.createRun("Submit");
  run.state = "running";
  worker.store.saveRun(run);
  const a = worker.store.actionStart(run.id, "act", {});
  worker.store.actionEnd(a, { ok: true });
  worker.initialize();
  assert.equal(worker.store.run(run.id).state, "queued");
  assert.equal(worker.store.run(run.id).recoveryNeeded, true);
  assert.equal(worker.store.actions(run.id)[0].state, "completed");
});

test("schedules run overdue work once and cannot overlap waiting runs", async (t) => {
  const worker = fixture(t, async () => ({
    control: { type: "input", question: "Need login" },
  }));
  worker.store.saveWorkflow({
    format: "browse.workflow/v1",
    name: "demo",
    steps: [{ type: "browser", task: "Check" }],
  });
  const s = await worker.dispatch("schedule_create", {
    name: "check",
    workflow: "demo",
    every: "1ms",
  });
  await new Promise((r) => setTimeout(r, 5));
  await worker.tick();
  assert.equal(worker.store.runs().length, 1);
  await new Promise((r) => setTimeout(r, 5));
  await worker.tick();
  assert.equal(worker.store.runs().length, 1);
  assert.ok(worker.store.schedules()[0].nextAt >= s.nextAt);
});

test("cancellation aborts active work and workspace export waits for it", async (t) => {
  let started;
  const ready = new Promise((r) => (started = r));
  const worker = fixture(t, async ({ signal }) => {
    started();
    await new Promise((resolve, reject) =>
      signal.addEventListener("abort", () => reject(Error("cancelled")), {
        once: true,
      }),
    );
  });
  const run = await worker.dispatch("submit", { task: "Wait" });
  const execution = worker.tick();
  await ready;
  await assert.rejects(
    worker.dispatch("export", { destination: "/tmp/not-used.fossil" }),
    /active run/,
  );
  await worker.dispatch("cancel", { id: run.id });
  await execution;
  assert.equal(worker.store.run(run.id).state, "cancelled");
});

test("imported historical runs cannot resume or continue", async (t) => {
  const worker = fixture(t, success);
  const run = worker.store.createRun("old");
  run.historical = true;
  run.state = "completed";
  worker.store.saveRun(run);
  await assert.rejects(worker.dispatch("resume", { id: run.id }), /history/);
  await assert.rejects(
    worker.dispatch("continue", { id: run.id, task: "Again" }),
    /continuation/,
  );
});

test("a fresh worker restores durable waits from SQLite", async (t) => {
  const p = paths(fs.mkdtempSync(path.join(os.tmpdir(), "browse-restart-")));
  let calls = 0;
  const w1 = new Worker(p, {
    agent: async () => {
      calls++;
      return success();
    },
  });
  w1.initialize();
  const run = w1.store.createRun("Wait then browse", {
    steps: [
      { type: "wait", duration: "1h" },
      { type: "browser", task: "Read" },
    ],
  });
  await w1.tick();
  const deadline = w1.store.run(run.id).wakeAt;
  w1.store.close();
  const w2 = new Worker(p, {
    agent: async () => {
      calls++;
      return success();
    },
  });
  w2.initialize();
  t.after(() => {
    w2.store.close();
    fs.rmSync(p.root, { recursive: true, force: true });
  });
  assert.equal(w2.store.run(run.id).wakeAt, deadline);
  await w2.tick();
  assert.equal(calls, 0);
  const resumed = w2.store.run(run.id);
  resumed.wakeAt = Date.now() - 1;
  w2.store.saveRun(resumed);
  await w2.tick();
  assert.equal(calls, 1);
  assert.equal(w2.store.run(run.id).state, "completed");
});

test("cancelled questions and queued steering do not leak into a new request", async (t) => {
  const worker = fixture(t, success);
  const run = await worker.dispatch("conversation_submit", { task: "Original task" });
  await worker.dispatch("steer", { id: run.id, text: "Old correction" });
  await worker.dispatch("cancel", { id: run.id });
  const next = await worker.dispatch("conversation_submit", { task: "New task" });
  await worker.tick();
  assert.equal(worker.store.run(next.id).state, "completed");
  assert.equal(worker.store.run(next.id).inputs[0].discarded, true);
  worker.agent = async () => ({ control: { type: "input", question: "Which account?", options: ["Personal", "Work"] } });
  await worker.dispatch("conversation_submit", { task: "Ask account" });
  await worker.tick();
  assert.deepEqual(worker.store.run(next.id).questionOptions, ["Personal", "Work"]);
  await worker.dispatch("cancel", { id: next.id });
  assert.equal(worker.store.run(next.id).question, undefined);
  assert.equal(worker.store.run(next.id).questionOptions, undefined);
  assert.equal((await worker.dispatch("conversation_submit", { task: "A different task" })).state, "queued");
});

test("native frontend sessions route to separate durable conversations despite active conversation changes", async (t) => {
  const worker = fixture(t, success);
  const one = await worker.dispatch("frontend_submit", { session: "session-one", task: "Read account one", model: "fx:gateway:anthropic/claude" });
  await worker.tick();
  const two = await worker.dispatch("frontend_submit", { session: "session-two", task: "Read account two", model: "fx:gateway:anthropic/claude" });
  await worker.tick();
  const followup = await worker.dispatch("frontend_submit", { session: "session-one", task: "Keep discussing account one", model: "fx:gateway:anthropic/claude" });
  assert.equal(followup.run.id, one.run.id);
  assert.notEqual(followup.run.conversationId, two.run.conversationId);
  assert.equal(followup.after, worker.store.events(one.run.id, 0).filter((event) => event.seq <= followup.after).at(-1).seq);
  assert.equal(worker.store.run(two.run.id).task, "Read account two");
  await assert.rejects(worker.dispatch("frontend_submit", { session: "../escape", task: "Read" }), /Invalid frontend session/);
});
