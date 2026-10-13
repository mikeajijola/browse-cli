import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createChatInput } from "../src/terminal.mjs";

test("arrow keys recall saved messages in order and allow editing before submission", async (t) => {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = true;
  output.isTTY = true;
  output.columns = 80;
  output.resume();
  const rl = createChatInput({ input, output, history: ["Latest message", "Older message"] });
  t.after(() => { rl.close(); input.destroy(); output.destroy(); });
  const type = async (text) => { input.write(text); await new Promise(setImmediate); };
  await type("\x1b[A");
  assert.equal(rl.line, "Latest message");
  await type("\x1b[A");
  assert.equal(rl.line, "Older message");
  await type("\x1b[B");
  assert.equal(rl.line, "Latest message");
  await type(" with edits");
  assert.equal(rl.line, "Latest message with edits");
  const submitted = new Promise((resolve) => rl.once("line", resolve));
  await type("\r");
  assert.equal(await submitted, "Latest message with edits");
  await type("\x1b[A");
  assert.equal(rl.line, "Latest message with edits");
});
