// Explicit integration check against the user's running BrowserOS Neo.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createFxAgent } from "libfx";
import { paths, atomic } from "../src/util.mjs";
import { Store } from "../src/store.mjs";
import { Workspace } from "../src/workspace.mjs";
import { Neo } from "../src/neo.mjs";
import { executeAgent } from "../src/agent.mjs";
import { providerOptions } from "../src/provider.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "browse-live-")),
  p = paths(root);
p.auth = path.join(p.private, "auth.json");
atomic(
  p.auth,
  JSON.stringify({
    model: "anthropic/test-model",
    credentials: { anthropic: "fixture-key" },
  }),
);
const store = new Store(p),
  workspace = new Workspace(p, store);
workspace.init();
let uploaded;
const server = http.createServer(async (req, res) => {
  if (req.url === "/download") {
    res.writeHead(200, {
      "content-type": "application/pdf",
      "content-disposition": 'attachment; filename="invoice.pdf"',
    });
    res.end(Buffer.from("%PDF-1.4\nBrowse invoice fixture\n"));
    return;
  }
  if (req.url === "/upload") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    uploaded = Buffer.concat(chunks).toString();
    res.end("Confirmed report.md");
    return;
  }
  res.setHeader("content-type", "text/html");
  res.end(
    `<title>Browse controlled fixture</title><h1>Browse fixture</h1><input type="file" aria-label="Upload file" id="file"><button onclick="const data=new FormData();data.append('file',document.getElementById('file').files[0]);fetch('/upload',{method:'POST',body:data}).then(r=>r.text()).then(t=>document.getElementById('status').textContent=t)">Submit report</button><p id="status"></p><a href="/download" download="invoice.pdf">Download invoice</a>`,
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`,
  run = store.createRun(
    "Upload the report, submit it, download the invoice, and retain a screenshot.",
  );
const report = workspace.artifact(
  run.id,
  "report.md",
  Buffer.from("Browse upload fixture"),
);
workspace.flush();
let pageId,
  requests = 0;
const code = String.raw`await browser.pages.list(); const page=await browser.open(${JSON.stringify(url)}); const snap=await page.snapshot(); const ref=(label,text)=>text.split('\n').find(line=>line.includes(label)).match(/ref=(e\d+)/)[1]; await page.upload(ref('Upload file',snap.text),[${JSON.stringify(path.join(p.checkout, report.body.path))}]); await page.click(ref('Submit report',snap.text)); const settled=await page.waitForText('Confirmed report.md'); if(!settled.matched)throw Error('Submission not confirmed'); const next=await page.snapshot(); const download=await page.download(ref('Download invoice',next.text)); return {pageId:page.id,download,confirmation:await page.read()};`;
const neo = new Neo();
const network = async () => {
  requests++;
  let tool;
  if (requests === 1)
    tool = {
      name: "name_session",
      input: {
        name: "Browse integration",
        category: "testing-and-qa",
        summary: "Controlled upload download and Fossil artifact verification",
      },
    };
  if (requests === 2) tool = { name: "run", input: { code } };
  if (requests === 3) {
    pageId = store.actions(run.id).find((a) => a.tool === "run")?.result
      ?.structuredContent?.value?.pageId;
    assert.ok(pageId, "Native Neo script must return its page ID");
    tool = { name: "screenshot", input: { page: pageId } };
  }
  const events = [
    {
      type: "message_start",
      message: {
        id: `msg_${requests}`,
        model: "test-model",
        role: "assistant",
        type: "message",
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
  ];
  if (tool) {
    events.push(
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: `tool_${requests}`,
          name: tool.name,
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(tool.input),
        },
      },
    );
  } else
    events.push(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Upload and download verified." },
      },
    );
  events.push(
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: {
        stop_reason: tool ? "tool_use" : "end_turn",
        stop_sequence: null,
      },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  );
  return new Response(
    events
      .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
};
try {
  const result = await executeAgent({
    p,
    store,
    workspace,
    run,
    neo,
    signal: AbortSignal.timeout(90000),
    createAgent: (options) =>
      createFxAgent({
        ...options,
        ...providerOptions({
          provider: "anthropic",
          model: "anthropic/test-model",
          apiKey: "fixture-key",
          fetch: network,
          onError: (error) => {
            console.error(error.message);
            console.error(JSON.stringify(store.actions(run.id), null, 2));
          },
        }),
      }),
  });
  assert.match(result.answer, /verified/);
  assert.match(uploaded, /Browse upload fixture/);
  assert.ok(
    store
      .records("artifact")
      .some((a) => /^invoice.*\.pdf$/.test(a.body.filename)),
    "Browser download must enter Fossil",
  );
  assert.ok(
    store
      .records("artifact")
      .some((a) => a.body.mediaType.startsWith("image/")),
    "Screenshot must enter Fossil",
  );
  store.portableRun(run.id);
  workspace.flush();
  assert.equal(workspace.verify().verified, true);
  console.log(
    JSON.stringify(
      {
        verified: true,
        provider: "deterministic Anthropic fixture through real libfx",
        browser: "live Neo",
        artifacts: store
          .records("artifact")
          .map((a) => ({ filename: a.body.filename, hash: a.body.hash })),
        browserCalls: store.actions(run.id).length,
      },
      null,
      2,
    ),
  );
} finally {
  if (pageId)
    try {
      await neo.call("tabs", { action: "close", page: pageId });
    } catch {}
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
}
