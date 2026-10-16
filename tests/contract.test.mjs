import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.mjs";
import { Worker } from "../src/worker.mjs";
import { paths, atomic, hash } from "../src/util.mjs";
import { reviseContract, readContract, recordCriterion, contractProgress } from "../src/contract.mjs";

function fixture(t) {
  const p = paths(fs.mkdtempSync(path.join(os.tmpdir(), "browse-contract-")));
  const store = new Store(p), run = store.createRun("Download the invoice and write a report");
  t.after(() => { store.close(); fs.rmSync(p.root, { recursive: true, force: true }); });
  return { p, store, run };
}
const objective = { expectedVersion: 0, sourceId: "task:0", objective: "Invoice and report", reason: "Initial user request",
  criteria: [{ id: "invoice", description: "Invoice saved" }, { id: "report", description: "Report saved" }] };
function observation(store, run, tool = "read", effectful = false) {
  const action = store.actionStart(run.id, tool, {}, effectful);
  store.actionEnd(action, { text: "Invoice download confirmed" });
  return action.id;
}
function record(store, run, criterionId, observationIds, artifactPaths = [], expectedVersion = 1) {
  return recordCriterion(store, run.id, { expectedVersion, criterionId, observationIds, artifactPaths, summary: "Checked saved evidence" });
}

test("contract versions require real instruction sources and preserve only unchanged completion evidence", (t) => {
  const { store, run } = fixture(t);
  assert.throws(() => reviseContract(store, run.id, { ...objective, sourceId: "website" }), /user instruction/);
  const first = reviseContract(store, run.id, objective);
  assert.equal(first.progress.complete, false);
  assert.equal(reviseContract(store, run.id, objective).contract.version, 1);
  const evidence = observation(store, run);
  record(store, run, "invoice", [evidence]);
  const latest = store.run(run.id);
  latest.inputs.push({ steering: "Also include line items in the report" }); store.saveRun(latest);
  const change = { ...objective, expectedVersion: 1, sourceId: "input:0", reason: "User clarified report",
    criteria: [objective.criteria[0], { id: "report", description: "Report includes line items" }] };
  const revised = reviseContract(store, run.id, change);
  assert.equal(revised.contract.criteria[0].status, "completed");
  assert.equal(revised.contract.criteria[1].status, "pending");
  assert.equal(revised.contract.versions.length, 2);
  assert.deepEqual(revised.contract.versions[0].criteria, objective.criteria);
  assert.throws(() => reviseContract(store, run.id, { ...change, objective: "Conflicting edit" }), /version changed/);
  assert.equal(store.pending().filter((item) => /\/v\d+\.json$/.test(item.path)).length, 2);
});

test("completion rejects missing, effectful, failed and other-run observations", (t) => {
  const { store, run } = fixture(t);
  reviseContract(store, run.id, objective);
  assert.throws(() => record(store, run, "invoice", []), /requires saved/);
  assert.throws(() => record(store, run, "invoice", ["invented"]), /read-only/);
  assert.throws(() => record(store, run, "invoice", [observation(store, run, "act", true)]), /read-only/);
  const failed = store.actionStart(run.id, "read", {}, false); store.actionEnd(failed, {}, "failed");
  assert.throws(() => record(store, run, "invoice", [failed.id]), /read-only/);
  const other = store.createRun("Another request");
  assert.throws(() => record(store, run, "invoice", [observation(store, other)]), /read-only/);
  assert.throws(() => record(store, run, "invoice", [observation(store, run, "name_session")]), /read-only/);
  const evidence = observation(store, run);
  const result = record(store, run, "invoice", [evidence]);
  assert.equal(result.progress.completed, 1);
  assert.equal(record(store, run, "invoice", [evidence]).progress.completed, 1);
  assert.equal(contractProgress(store.run(run.id).contract).complete, false);
});

test("artifact evidence is checked against actual bytes and producing run", (t) => {
  const { p, store, run } = fixture(t);
  reviseContract(store, run.id, objective);
  const relative = `artifacts/${run.id}/report/report.md`, bytes = Buffer.from("Invoice report");
  atomic(path.join(p.checkout, relative), bytes);
  store.record("artifact", { path: relative, runId: run.id, hash: hash(bytes) });
  assert.equal(record(store, run, "report", [], [relative]).progress.completed, 1);
  fs.writeFileSync(path.join(p.checkout, relative), "altered");
  assert.throws(() => record(store, run, "invoice", [], [relative]), /intact artifact/);
});

test("worker continues a contract across model replies and a restart, completing only after evidence", async (t) => {
  const p = paths(fs.mkdtempSync(path.join(os.tmpdir(), "browse-contract-worker-")));
  let calls = 0, worker;
  const agent = async ({ store, run }) => {
    calls++;
    if (calls === 1) reviseContract(store, run.id, objective);
    else {
      const evidence = observation(store, run);
      record(store, run, "invoice", [evidence]); record(store, run, "report", [evidence]);
    }
    return { answer: "A model reply", result: { usage: {} } };
  };
  worker = new Worker(p, { agent }); worker.initialize();
  t.after(() => { worker.store.close(); fs.rmSync(p.root, { recursive: true, force: true }); });
  const run = await worker.dispatch("conversation_submit", { task: "Download the invoice and write a report" });
  await worker.tick();
  assert.equal(worker.store.run(run.id).state, "queued");
  assert.equal(worker.store.records("outcome").length, 0);
  worker.store.close(); worker = new Worker(p, { agent }); worker.initialize();
  assert.equal((await worker.dispatch("contract", { id: run.id })).progress.completed, 0);
  await worker.tick();
  assert.equal(worker.store.run(run.id).state, "completed");
  assert.equal(worker.store.records("outcome")[0].body.assessment, "contract_evidence_recorded");
  assert.ok(fs.existsSync(path.join(p.checkout, "contracts", run.id, "v1.json")));
  assert.equal(readContract(worker.store, run.id).progress.complete, true);
});

test("transient errors back off without completing a contract and explicit cancellation remains effective", async (t) => {
  const p = paths(fs.mkdtempSync(path.join(os.tmpdir(), "browse-contract-retry-")));
  const worker = new Worker(p, { retryDelayMs: 1, agent: async ({ store, run }) => {
    if (!store.run(run.id).contract) reviseContract(store, run.id, objective);
    throw Error("Provider request failed (503): temporarily unavailable");
  } });
  worker.initialize();
  t.after(() => { worker.store.close(); fs.rmSync(p.root, { recursive: true, force: true }); });
  const run = await worker.dispatch("submit", { task: "Download and report" });
  await worker.tick();
  assert.equal(worker.store.run(run.id).state, "waiting");
  assert.equal(worker.store.run(run.id).question, undefined);
  assert.equal(worker.store.run(run.id).contract.version, 1);
  await worker.dispatch("cancel", { id: run.id });
  await worker.tick();
  assert.equal(worker.store.run(run.id).state, "cancelled");
});
