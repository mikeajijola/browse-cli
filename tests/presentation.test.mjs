import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { Markdown, ChatPresentation } from "../src/presentation.mjs";

test("Markdown formats headings, fenced code, links and tables without losing content", () => {
  const markdown = new Markdown({ columns: 80 });
  let rendered = ["## Findings", "**Ready** [source](https://example.com)", "```js", "const value = 1;", "```",
    "| Item | State |", "| --- | --- |", "| Download | Saved |", ""].map((line) => markdown.line(line)).join("") + markdown.finish();
  assert.match(rendered, /Findings/);
  assert.match(rendered, /Ready source \(https:\/\/example.com\)/);
  assert.match(rendered, /│ const value = 1;/);
  assert.match(rendered, /\| Download \| Saved \|/);
  assert.ok(!rendered.includes("\x1b"));
  const narrow = new Markdown({ columns: 10 });
  rendered = ["| Item | State |", "| --- | --- |", "| Download | Saved |"].map((line) => narrow.line(line)).join("") + narrow.finish();
  assert.match(rendered, /Item: Download\nState: Saved/);
});

test("streaming retains partial Markdown, shows applied steering and tool outcomes", () => {
  let output = "", preview = "", status = "";
  const stream = new PassThrough(); stream.columns = 80; stream.resume();
  const composer = { terminal: true, writeAbove: (text) => { output += text; }, setPreview: (text) => { preview = text; }, setStatus: (text) => { status = text; } };
  const view = new ChatPresentation({ composer, output: stream, now: () => 1000 });
  try {
    view.start({ state: "running" });
    view.event({ seq: 1, type: "text_delta", delta: "**Hel" });
    view.event({ seq: 2, type: "text_delta", delta: "lo**\n" });
    view.event({ seq: 3, type: "tool_start", name: "read", actionId: "read-1" });
    view.event({ seq: 4, type: "tool_end", name: "read", actionId: "read-1" });
    view.event({ seq: 5, type: "steering_applied", text: "Use PDF" });
    view.event({ seq: 6, type: "contract_progress", version: 2, completed: 1, total: 2 });
    view.finish({ state: "completed" });
    assert.match(output, /Hello/);
    assert.ok(!output.includes("**Hel"));
    assert.match(output, /✓ Read page/);
    assert.match(output, /Follow-up applied/);
    assert.match(output, /1\/2 criteria/);
    assert.equal(preview, "");
    assert.match(status, /Complete/);
  } finally { view.close(); }
});

test("tool result details and questions escape website control sequences", () => {
  const stream = new PassThrough(); let output = ""; stream.on("data", (value) => { output += value; });
  const view = new ChatPresentation({ output: stream });
  view.details([{ id: "id", tool: "read", state: "completed", result: "hello\x1b[2J" }]);
  view.finish({ state: "waiting", question: "Which account?\x1b[2J", questionOptions: ["Personal", "Work"] });
  assert.ok(!output.includes("\x1b"));
  assert.match(output, /Which account/);
  assert.match(output, /2\. Work/);
});
