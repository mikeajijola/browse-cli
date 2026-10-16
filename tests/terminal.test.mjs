import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createChatInput, safeText, cellWidth } from "../src/terminal.mjs";

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

function editor(t, history = []) {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = output.isTTY = true;
  output.columns = 40; output.rows = 15;
  let raw = false, screen = "";
  input.setRawMode = (value) => { raw = value; };
  output.on("data", (data) => { screen += data; });
  const chat = createChatInput({ input, output, history });
  chat.prompt();
  t.after(() => { chat.close(); input.destroy(); output.destroy(); });
  return { input, output, chat, get screen() { return screen; }, get raw() { return raw; },
    type: async (value) => { input.write(value); await new Promise(setImmediate); } };
}

test("plain and split bracketed multiline pastes stay editable until Enter", async (t) => {
  const e = editor(t), submitted = [];
  e.chat.on("line", (line) => submitted.push(line));
  await e.type("first\nsecond\n");
  assert.deepEqual(submitted, []);
  assert.equal(e.chat.line, "first\nsecond\n");
  await e.type("\r");
  assert.deepEqual(submitted, ["first\nsecond\n"]);
  for (const chunk of ["\x1b[2", "00~a\r\nb\n/stop\n\x03", "\x1b[20", "1~"]) await e.type(chunk);
  assert.equal(e.chat.line, "a\nb\n/stop\n");
  assert.equal(submitted.length, 1);
  await e.type("\r");
  assert.equal(submitted[1], "a\nb\n/stop\n");
});

test("newlines, Unicode deletion and draft recall preserve complete messages", async (t) => {
  const e = editor(t, ["previous"]);
  await e.type("draft 👩‍💻");
  await e.type("\x7f");
  assert.equal(e.chat.line, "draft ");
  await e.type("\x1b\r");
  await e.type("second");
  await e.type("\x1b[A");
  assert.equal(e.chat.line, "draft \nsecond");
  await e.type("\x1b[A");
  assert.equal(e.chat.line, "previous");
  await e.type("\x1b[B");
  assert.equal(e.chat.line, "draft \nsecond");
});

test("output, partial responses and resize preserve draft and caret", async (t) => {
  const e = editor(t);
  await e.type("keep this draft");
  await e.type("\x1b[D");
  const cursor = e.chat.cursor;
  e.chat.setPreview("An assistant reply that is streaming while you type");
  e.chat.writeAbove("Tool completed\n");
  e.output.columns = 20; e.output.emit("resize");
  assert.equal(e.chat.line, "keep this draft");
  assert.equal(e.chat.cursor, cursor);
  await e.type("!");
  assert.equal(e.chat.line, "keep this draf!t");
  assert.ok(e.screen.includes("Tool completed"));
  assert.ok(e.screen.includes("\x1b[0J"));
  e.chat.close();
  assert.equal(e.raw, false);
  assert.ok(e.screen.includes("\x1b[?2004l"));
});

test("question choices require explicit submission and allow freeform answers", async (t) => {
  const e = editor(t), replies = [];
  e.chat.on("line", (line) => replies.push(line));
  e.chat.setChoices(["Personal", "Work"]);
  await e.type("\x1b[B");
  assert.deepEqual(replies, []);
  await e.type("\r");
  assert.deepEqual(replies, ["Work"]);
  await e.type("Another account");
  await e.type("\r");
  assert.equal(replies[1], "Another account");
});

test("command completion and terminal controls cannot enter a message", async (t) => {
  const e = editor(t);
  await e.type("/contr"); await e.type("\t");
  assert.equal(e.chat.line, "/contract ");
  assert.equal(safeText("safe\x1b[2J\x1b]0;spoof\x07\x00text"), "safetext");
  assert.equal(cellWidth("a界👩‍💻é"), 6);
});

test("piped input stays line oriented and receives no terminal escapes", async (t) => {
  const input = new PassThrough(), output = new PassThrough();
  let text = ""; output.on("data", (chunk) => { text += chunk; });
  const chat = createChatInput({ input, output }), lines = [];
  chat.on("line", (line) => lines.push(line));
  t.after(() => { chat.close(); input.destroy(); output.destroy(); });
  input.write("one\ntwo\n"); await new Promise(setImmediate);
  chat.writeAbove("reply\n");
  assert.deepEqual(lines, ["one", "two"]);
  assert.ok(!text.includes("\x1b"));
});

test("vertical navigation never splits Unicode graphemes in multiline messages", async (t) => {
  const e = editor(t);
  e.chat.replace("a👩‍💻z\nabcdef");
  e.chat.cursor = e.chat.line.length - 2;
  await e.type("\x1b[A");
  assert.equal(e.chat.cursor, "a👩‍💻z".length);
  await e.type("!");
  assert.equal(e.chat.line, "a👩‍💻z!\nabcdef");
});
