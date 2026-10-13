import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { paths, hash, workflow, inside } from "../src/util.mjs";
import { Store } from "../src/store.mjs";
import { Workspace } from "../src/workspace.mjs";

export function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browse-test-")),
    p = paths(root),
    store = new Store(p),
    workspace = new Workspace(p, store);
  workspace.init();
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { p, store, workspace };
}

test("Fossil roundtrip preserves skills, links, artifacts and disabled schedules", (t) => {
  const { p, store, workspace } = fixture(t);
  const skill = store.record(
    "skill",
    { name: "invoices", instructions: "Download invoices" },
    { logicalId: "invoices" },
  );
  const run = store.createRun("Download invoices");
  run.skillRevisions = [skill.id];
  run.state = "completed";
  store.saveRun(run);
  store.portableRun(run.id);
  const bytes = Buffer.from([0, 255, 3, 12]);
  const artifact = workspace.artifact(run.id, "invoice.pdf", bytes, {
    source: "fixture",
  });
  const feedback = store.feedback(run.id, "positive", "Correct invoice");
  store.saveWorkflow(
    workflow({
      format: "browse.workflow/v1",
      name: "invoices",
      steps: [{ type: "browser", task: "Download invoices" }],
    }),
  );
  store.schedule({
    name: "monthly",
    workflow: "invoices",
    enabled: true,
    interval: 1000,
    nextAt: Date.now(),
  });
  const dest = path.join(p.root, "export.fossil");
  workspace.export(dest);
  const imported = paths(path.join(p.root, "other"));
  const s2 = new Store(imported),
    w2 = new Workspace(imported, s2);
  t.after(() => s2.close());
  w2.fossil(["backup", "-R", dest, imported.repo], { cwd: imported.root });
  w2.init();
  s2.rebuild(imported.checkout);
  s2.importedHistory(imported.checkout);
  assert.equal(s2.meta("workspace"), store.meta("workspace"));
  assert.equal(s2.getRecord(skill.id).body.instructions, "Download invoices");
  assert.equal(
    s2.getRecord(feedback.id).links.some((l) => l.to === artifact.id),
    true,
  );
  assert.equal(
    hash(fs.readFileSync(path.join(imported.checkout, artifact.body.path))),
    hash(bytes),
  );
  assert.equal(s2.schedules()[0].enabled, false);
  assert.equal(s2.run(run.id).historical, true);
  assert.equal(
    fs.existsSync(path.join(imported.private, "checkpoints", run.id)),
    false,
  );
  assert.equal(w2.verify().verified, true);
});

test("failed publication retains outbox and does not repeat browser actions", (t) => {
  const { store, workspace } = fixture(t);
  const run = store.createRun("Submit");
  const action = store.actionStart(run.id, "act", { kind: "click" });
  store.actionEnd(action, { submitted: true });
  const normal = workspace.fossil.bind(workspace);
  let fail = true;
  workspace.fossil = (args, options) => {
    if (args[0] === "commit" && fail) throw Error("disk unavailable");
    return normal(args, options);
  };
  assert.throws(() => workspace.flush(), /disk unavailable/);
  assert.ok(store.pending().length);
  fail = false;
  workspace.flush();
  assert.equal(store.pending().length, 0);
  assert.equal(store.actions(run.id).length, 1);
  assert.equal(store.actions(run.id)[0].state, "completed");
});

test("commit acknowledgement crash reconciles operation IDs with additional pending records", (t) => {
  const { store, workspace } = fixture(t);
  store.record("memory", { content: "First" });
  const acknowledge = store.acknowledge.bind(store);
  store.acknowledge = () => {
    throw Error("crash after commit");
  };
  assert.throws(() => workspace.flush(), /crash/);
  store.acknowledge = acknowledge;
  store.record("memory", { content: "Second" });
  workspace.flush();
  assert.equal(store.pending().length, 0);
  assert.equal(store.records("memory").length, 2);
  assert.equal(workspace.verify().verified, true);
});

test("index rebuild retains latest revisions and explicit feedback", (t) => {
  const { store, workspace, p } = fixture(t);
  const first = store.record(
    "skill",
    { instructions: "old invoice procedure" },
    { logicalId: "invoice" },
  );
  const last = store.record(
    "skill",
    { instructions: "new invoice procedure" },
    { logicalId: "invoice" },
  );
  const run = store.createRun("invoice");
  run.skillRevisions = [last.id];
  store.saveRun(run);
  store.feedback(run.id, "positive", "good");
  workspace.flush();
  store.rebuild(p.checkout);
  assert.equal(store.latest("skill", "invoice").id, last.id);
  assert.equal(
    store.getRecord(first.id).body.instructions,
    "old invoice procedure",
  );
  assert.equal(store.context("invoice")[0].id, last.id);
});

test("historical artifact retrieval preserves binary bytes", (t) => {
  const { workspace, store, p } = fixture(t);
  const run = store.createRun("file");
  const a = workspace.artifact(run.id, "image.png", Buffer.from([1, 0, 255]));
  workspace.flush();
  const revision = workspace
    .fossil(["info"])
    .match(/checkout:\s+([a-f0-9]+)/)?.[1];
  assert.ok(revision);
  const file = workspace.extract(a.body.path, revision);
  assert.deepEqual(fs.readFileSync(file), Buffer.from([1, 0, 255]));
  assert.ok(file.startsWith(p.private));
});

test("path confinement, definitions and export integrity", (t) => {
  const { p, workspace, store } = fixture(t);
  assert.throws(() => inside(p.checkout, "../../auth.json"), /escapes/);
  fs.symlinkSync(os.tmpdir(), path.join(p.checkout, "outside"));
  assert.throws(() => inside(p.checkout, "outside/secret"), /Symlink/);
  fs.unlinkSync(path.join(p.checkout, "outside"));
  assert.throws(
    () =>
      workflow({
        format: "browse.workflow/v1",
        name: "bad",
        steps: [{ type: "shell", command: "x" }],
      }),
    /Invalid/,
  );
  const run = store.createRun("artifact");
  const a = workspace.artifact(run.id, "report.md", Buffer.from("ok"));
  workspace.flush();
  fs.writeFileSync(path.join(p.checkout, a.body.path), "changed");
  assert.throws(
    () => workspace.export(path.join(p.root, "bad.fossil")),
    /uncommitted|altered/,
  );
});
