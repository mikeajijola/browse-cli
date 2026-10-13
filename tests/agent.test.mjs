import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { paths, atomic } from "../src/util.mjs";
import { Store } from "../src/store.mjs";
import { Workspace } from "../src/workspace.mjs";
import { executeAgent, reportedFiles } from "../src/agent.mjs";

function fixture(t) {
  const p = paths(fs.mkdtempSync(path.join(os.tmpdir(), "browse-agent-")));
  p.auth = path.join(p.private, "auth.json");
  atomic(
    p.auth,
    JSON.stringify({ model: "google/test", credentials: { google: "test" } }),
  );
  const store = new Store(p),
    workspace = new Workspace(p, store);
  workspace.init();
  t.after(() => {
    store.close();
    fs.rmSync(p.root, { recursive: true, force: true });
  });
  return { p, store, workspace };
}
function fakeAgent(fn) {
  return async (options) => ({
    prompt() {
      const result = Promise.resolve({ stopReason: "end_turn", usage: {} });
      return {
        result,
        async *[Symbol.asyncIterator]() {
          await fn(options);
          yield { type: "text_delta", delta: "Verified" };
        },
      };
    },
    async checkpoint() {
      return Buffer.from("checkpoint");
    },
    async close() {},
  });
}
const schema = {
  type: "object",
  properties: { kind: { type: "string" } },
  required: ["kind"],
  additionalProperties: false,
};

test("browser outcome is recorded before generated artifacts and checkpoint", async (t) => {
  const f = fixture(t),
    run = f.store.createRun("Submit");
  let calls = 0;
  const neo = {
    tools: [{ name: "act", description: "act", inputSchema: schema }],
    async ready() {},
    async call() {
      calls++;
      return { content: [{ type: "text", text: "Confirmation" }] };
    },
  };
  const result = await executeAgent({
    ...f,
    run,
    neo,
    createAgent: fakeAgent(async ({ tools }) => {
      await tools.find((t) => t.name === "act").execute({ kind: "click" });
      await tools
        .find((t) => t.name === "artifact_write")
        .execute({ filename: "report.md", content: "Confirmed" });
    }),
  });
  assert.equal(calls, 1);
  assert.equal(f.store.actions(run.id)[0].state, "completed");
  assert.equal(f.store.records("artifact").length, 1);
  assert.equal(result.answer, "Verified");
  assert.ok(fs.existsSync(path.join(f.p.private, "checkpoints", run.id)));
});

test("recovery blocks effectful calls and requires read-only evidence to resolve", async (t) => {
  const f = fixture(t),
    run = f.store.createRun("Submit");
  run.recoveryNeeded = true;
  const uncertain = f.store.actionStart(run.id, "act", { kind: "click" });
  let clicks = 0;
  const neo = {
    tools: [
      { name: "act", description: "act", inputSchema: schema },
      {
        name: "read",
        description: "read",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    async ready() {},
    async call(tool) {
      if (tool === "act") clicks++;
      return { content: [{ type: "text", text: "Submission confirmed" }] };
    },
  };
  const result = await executeAgent({
    ...f,
    run,
    neo,
    createAgent: fakeAgent(async ({ tools }) => {
      await assert.rejects(
        tools.find((t) => t.name === "act").execute({ kind: "click" }),
        /observations only/,
      );
      await tools.find((t) => t.name === "read").execute({});
      const observation = f.store.actions(run.id).at(-1);
      await tools
        .find((t) => t.name === "reconcile_action")
        .execute({
          actionId: uncertain.id,
          outcome: "succeeded",
          observationIds: [observation.id],
          evidence: "Page says submission confirmed",
        });
    }),
  });
  assert.equal(clicks, 0);
  assert.equal(result.unresolved.length, 0);
});

test("yield prevents subsequent browser dispatch", async (t) => {
  const f = fixture(t),
    run = f.store.createRun("Wait");
  let calls = 0;
  const neo = {
    tools: [{ name: "act", description: "act", inputSchema: schema }],
    async ready() {},
    async call() {
      calls++;
    },
  };
  const result = await executeAgent({
    ...f,
    run,
    neo,
    createAgent: fakeAgent(async ({ tools }) => {
      await tools
        .find((t) => t.name === "workflow_wait")
        .execute({ duration: "1h", reason: "Wait" });
      await assert.rejects(
        tools.find((t) => t.name === "act").execute({ kind: "click" }),
        /yielded/,
      );
    }),
  });
  assert.equal(calls, 0);
  assert.equal(result.control.milliseconds, 3600000);
});

test("reported downloads include browser-renamed filenames containing spaces", (t) => {
  const f = fixture(t),
    file = path.join(f.p.private, "invoice (2).pdf");
  fs.writeFileSync(file, "pdf");
  assert.deepEqual(
    reportedFiles({
      structuredContent: { value: { download: { path: file } } },
    }),
    [file],
  );
  assert.deepEqual(
    reportedFiles({
      content: [{ type: "text", text: `Downloaded file: ${file}\n` }],
    }),
    [file],
  );
});

test("provider authentication failures cannot become successful task answers", async (t) => {
  const f = fixture(t),
    run = f.store.createRun("Read page", { model: "openai/test-model" });
  atomic(
    f.p.auth,
    JSON.stringify({
      model: "openai/test-model",
      credentials: { openai: "test" },
    }),
  );
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json(
      {
        error: { message: "Invalid credentials", type: "authentication_error" },
      },
      { status: 401 },
    );
  try {
    await assert.rejects(
      executeAgent({
        ...f,
        run,
        neo: { tools: [], async ready() {} },
        signal: AbortSignal.timeout(5000),
      }),
      /Provider request failed/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
