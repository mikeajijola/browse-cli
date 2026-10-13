import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "../src/worker.mjs";
import { paths, atomic } from "../src/util.mjs";
import { executeAgent } from "../src/agent.mjs";

const success = async ({ store, run }) => {
  store.event(run.id, "text_delta", { delta: `Answer to ${run.task}` });
  return { answer: `Answer to ${run.task}`, result: { usage: {} } };
};

function fixture(t, agent = success) {
  const p = paths(fs.mkdtempSync(path.join(os.tmpdir(), "browse-conversation-")));
  let worker = new Worker(p, { agent });
  worker.initialize();
  t.after(() => { worker.store.close(); fs.rmSync(p.root, { recursive: true, force: true }); });
  return { p, get worker() { return worker; }, restart() {
    worker.store.close(); worker = new Worker(p, { agent }); worker.initialize(); return worker;
  } };
}

test("reopening Browse continues the same conversation and preserves both user and assistant messages", async (t) => {
  const f = fixture(t);
  const first = await f.worker.dispatch("conversation_submit", { task: "Remember my contract rate" });
  await f.worker.tick();
  const opened = await f.restart().dispatch("conversation_open");
  assert.equal(opened.run.id, first.id);
  assert.deepEqual(opened.messages.map((m) => [m.role, m.content]), [
    ["user", "Remember my contract rate"], ["assistant", "Answer to Remember my contract rate"],
  ]);
  const second = await f.worker.dispatch("conversation_submit", { task: "Use that rate for this search" });
  assert.equal(second.id, first.id);
  assert.equal(second.conversationId, first.conversationId);
  await f.worker.tick();
  assert.equal(f.worker.store.conversationMessages(first.conversationId).length, 4);
  assert.deepEqual(f.worker.store.events(first.id, opened.after).filter((e) => e.type === "text_delta").map((e) => e.delta), ["Answer to Use that rate for this search"]);
  assert.match(f.worker.store.conversationSearch(first.conversationId, "contract rate")[0].content, /contract rate/);
});

test("legacy manual runs migrate into the ongoing transcript while workflows stay separate", async (t) => {
  const f = fixture(t);
  const first = await f.worker.dispatch("submit", { task: "Older chat" });
  await f.worker.tick();
  const second = await f.worker.dispatch("submit", { task: "Latest chat" });
  await f.worker.tick();
  const workflow = f.worker.store.createRun("Scheduled work", { workflowRevision: "fixture-workflow" });
  const opened = await f.worker.dispatch("conversation_open");
  assert.equal(opened.run.id, second.id);
  assert.equal(f.worker.store.run(first.id).conversationId, opened.conversation.id);
  assert.equal(f.worker.store.run(workflow.id).conversationId, undefined);
  assert.deepEqual(opened.messages.filter((m) => m.role === "user").map((m) => m.content), ["Older chat", "Latest chat"]);
});

test("Fossil versions self-contained history.sqlite snapshots and import continues the narrative without replaying runs", async (t) => {
  const f = fixture(t);
  const run = await f.worker.dispatch("conversation_submit", { task: "First message" });
  await f.worker.tick();
  const revision = f.worker.workspace.fossil(["info"]).match(/checkout:\s+([a-f0-9]+)/)[1];
  const snapshot = path.join(f.p.checkout, "history.sqlite");
  assert.ok(fs.existsSync(snapshot));
  assert.equal(fs.existsSync(`${snapshot}-wal`), false);
  const db = new DatabaseSync(snapshot, { readOnly: true });
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map((r) => r.name), ["conversations", "messages", "metadata"]);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages").get().count, 2);
  db.close();
  await f.worker.dispatch("conversation_submit", { task: "Second message" });
  await f.worker.tick();
  const historic = f.worker.workspace.extract("history.sqlite", revision);
  const old = new DatabaseSync(historic, { readOnly: true });
  assert.equal(old.prepare("SELECT COUNT(*) AS count FROM messages").get().count, 2);
  old.close();
  const exported = path.join(f.p.root, "conversation.fossil");
  f.worker.workspace.export(exported);
  let calls = 0;
  const p2 = paths(path.join(f.p.root, "imported"));
  const imported = new Worker(p2, { agent: async (options) => { calls++; return success(options); } });
  t.after(() => imported.store.close());
  imported.workspace.fossil(["backup", "-R", exported, p2.repo], { cwd: p2.root });
  imported.initialize();
  const opened = await imported.dispatch("conversation_open");
  assert.equal(opened.conversation.id, run.conversationId);
  assert.equal(opened.run.historical, true);
  assert.equal(opened.messages.length, 4);
  await imported.tick();
  assert.equal(calls, 0);
  const next = await imported.dispatch("conversation_submit", { task: "Continue here" });
  assert.notEqual(next.id, run.id);
  assert.equal(next.conversationId, run.conversationId);
  await imported.tick();
  assert.equal(calls, 1);
  assert.equal(imported.store.conversationMessages(run.conversationId).at(-1).content, "Answer to Continue here");
  assert.equal(imported.store.run(run.id).historical, true);
});

test("explicit new conversation retains the previous transcript and does not reuse its run", async (t) => {
  const f = fixture(t);
  const old = await f.worker.dispatch("conversation_submit", { task: "Old discussion" });
  await f.worker.tick();
  await f.worker.dispatch("conversation_new");
  assert.equal((await f.restart().dispatch("conversation_open")).run, null);
  const next = await f.worker.dispatch("conversation_submit", { task: "New discussion" });
  await f.worker.tick();
  assert.notEqual(next.id, old.id);
  assert.notEqual(next.conversationId, old.conversationId);
  assert.equal(f.worker.store.conversationMessages(old.conversationId).length, 2);
});

test("reopened conversation accepts a pending answer instead of creating a separate run", async (t) => {
  let calls = 0;
  const f = fixture(t, async (options) => ++calls === 1
    ? { answer: "Which account?", control: { type: "input", question: "Which account?" } }
    : success(options));
  const run = await f.worker.dispatch("conversation_submit", { task: "Find invoices" });
  await f.worker.tick();
  const opened = await f.restart().dispatch("conversation_open");
  assert.equal(opened.run.question, "Which account?");
  const answered = await f.worker.dispatch("conversation_submit", { task: "Personal" });
  assert.equal(answered.id, run.id);
  await f.worker.tick();
  assert.equal(f.worker.store.run(run.id).inputs[0].answer, "Personal");
  assert.ok(f.worker.store.conversationMessages(run.conversationId).some((m) => m.content === "Personal"));
});

test("conversation snapshot publication retries safely after commit acknowledgement failure", async (t) => {
  const f = fixture(t);
  await f.worker.dispatch("conversation_submit", { task: "Keep this" });
  const acknowledge = f.worker.store.acknowledge.bind(f.worker.store);
  f.worker.store.acknowledge = () => { throw Error("Simulated acknowledgement crash"); };
  assert.throws(() => f.worker.workspace.flush(), /acknowledgement crash/);
  f.worker.store.acknowledge = acknowledge;
  await f.worker.tick();
  f.worker.workspace.flush();
  assert.equal(f.worker.store.pending().length, 0);
  assert.equal(f.worker.workspace.verify().verified, true);
  const db = new DatabaseSync(path.join(f.p.checkout, "history.sqlite"), { readOnly: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages").get().count, 2);
  db.close();
});

test("agent restores conversation checkpoints and falls back to searchable history when a checkpoint is unavailable", async (t) => {
  const seen = [];
  const agent = (options) => executeAgent({
    ...options,
    neo: { tools: [], async ready() {} },
    createAgent: async (config) => {
      seen.push(config);
      return {
        prompt() {
          return { result: Promise.resolve({ stopReason: "end_turn", usage: {} }),
            async *[Symbol.asyncIterator]() { yield { type: "text_delta", delta: "I remember your preference" }; } };
        },
        async checkpoint() {
          if (seen.length === 2) return Buffer.alloc(256 * 1024 + 1);
          return Buffer.from("fixture-conversation-checkpoint");
        },
        async close() {},
      };
    },
  });
  const f = fixture(t, agent);
  f.p.auth = path.join(f.p.private, "auth.json");
  atomic(f.p.auth, JSON.stringify({ model: "google/test-model", credentials: { google: "fixture-key" } }));
  const first = await f.worker.dispatch("conversation_submit", { task: "Only outside IR35 contracts" });
  await f.worker.tick();
  await f.restart().dispatch("conversation_open");
  await f.worker.dispatch("conversation_submit", { task: "Remember that for my search" });
  await f.worker.tick();
  assert.equal(Buffer.from(seen[1].checkpoint).toString(), "fixture-conversation-checkpoint");
  assert.equal(fs.existsSync(path.join(f.p.private, "checkpoints", first.id)), false);
  await f.worker.dispatch("conversation_submit", { task: "Which contracts did I want?" });
  await f.worker.tick();
  assert.equal(seen[2].checkpoint, undefined);
  assert.match(seen[2].instructions, /Only outside IR35 contracts/);
  const search = seen[2].tools.find((tool) => tool.name === "conversation_search");
  assert.ok((await search.execute({ query: "IR35" })).some((m) => m.content.includes("Only outside IR35 contracts")));
  assert.equal(f.worker.store.run(first.id).state, "completed");
});
