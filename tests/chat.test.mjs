import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { chat } from "../src/cli.mjs";
import { safeText } from "../src/terminal.mjs";

async function until(check) {
  for (let count = 0; count < 400; count++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error("Chat did not reach expected state");
}

async function fixture(t, { pendingQuestion = false } = {}) {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = output.isTTY = true; output.columns = 100; output.rows = 24;
  let screen = "", selected = "one", readRun, run = pendingQuestion ? {
    id: "run-one", state: "waiting", question: "Which account?", questionOptions: ["Personal", "Work"],
  } : null;
  const calls = [], events = [], messages = { one: [], two: [{ role: "user", content: "Older discussion", ordinal: 1 }] };
  output.on("data", (chunk) => { screen += chunk; });
  const call = async (method, args = {}) => {
    calls.push({ method, args });
    if (method === "conversation_open") return { conversation: { id: selected }, run,
      messages: messages[selected], inputHistory: [], after: events.length };
    if (method === "conversation_submit") {
      run = { id: "run-one", state: "running" };
      events.push({ seq: events.length + 1, type: "steering_applied", text: args.task });
      return { ...run };
    }
    if (method === "event_cursor") return events.length;
    if (method === "events") return events.filter((event) => event.seq > args.after);
    if (method === "run") return readRun ? readRun({ ...run, actions: [] }) : { ...run, actions: [] };
    if (method === "cancel") { run.state = "cancelled"; return { ...run }; }
    if (method === "status") return { conversation: selected, progress: null };
    if (method === "conversations") return [
      { id: "one", title: "Current discussion", message_count: 0 },
      { id: "two", title: "Older discussion", message_count: 1 },
    ];
    if (method === "conversation_select") { selected = args.id; run = null; return call("conversation_open"); }
    if (method === "conversation_history") return { messages: messages[selected], before: null };
    if (method === "conversation_search") return messages[selected].filter((message) => message.content.includes(args.query));
    if (method === "conversation_new") { selected = "one"; run = null; return { id: selected }; }
    throw Error(`Unexpected operation ${method}`);
  };
  const done = chat({}, { model: "fixture/model" }, undefined, {
    input, output, call, authenticate: async () => {}, connect: async () => {},
  });
  t.after(async () => { input.end(); await done; output.destroy(); });
  await until(() => screen.includes("browse ›"));
  return { input, output, calls, events, done,
    get screen() { return safeText(screen); },
    setState(state) { run.state = state; },
    interceptRun(fn) { readRun = fn; },
    send: async (text) => { input.write(text); await new Promise(setImmediate); input.write("\r"); await new Promise(setImmediate); },
  };
}

test("chat steers during streaming, acknowledges delivery and exits without cancelling", async (t) => {
  const f = await fixture(t);
  await f.send("Read this page");
  await until(() => f.calls.some((call) => call.method === "events"));
  f.events.push({ seq: f.events.length + 1, type: "text_delta", delta: "**Reading**\n" });
  f.input.write("keep my draft");
  await until(() => f.screen.includes("Reading"));
  f.input.write("\x15");
  await f.send("Only this month");
  await until(() => f.calls.filter((call) => call.method === "conversation_submit").length === 2);
  await until(() => f.screen.includes("Follow-up applied"));
  await f.send("/exit"); await f.done;
  assert.equal(f.calls.filter((call) => call.method === "cancel").length, 0);
  assert.equal(f.calls.filter((call) => call.method === "conversation_submit")[1].args.task, "Only this month");
});

test("conversation selection and history commands do not become agent tasks", async (t) => {
  const f = await fixture(t);
  await f.send("/conversations");
  await until(() => f.screen.includes("Current discussion"));
  await f.send("/switch 2");
  await until(() => f.calls.some((call) => call.method === "conversation_select"));
  await f.send("/history"); await f.send("/search Older");
  await until(() => f.calls.some((call) => call.method === "conversation_search"));
  assert.ok(f.screen.includes("Older discussion"));
  assert.equal(f.calls.filter((call) => call.method === "conversation_submit").length, 0);
});

test("attachments are consumed by the next message, including a pending answer", async (t) => {
  const f = await fixture(t, { pendingQuestion: true });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "browse-chat-attachment-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "account notes.txt"); fs.writeFileSync(file, "Personal account");
  await f.send(`/attach "${file}"`);
  await until(() => f.screen.includes("Attached account notes.txt"));
  await f.send("2");
  await until(() => f.calls.some((call) => call.method === "conversation_submit"));
  const submission = f.calls.find((call) => call.method === "conversation_submit");
  assert.equal(submission.args.task, "Work");
  assert.deepEqual(submission.args.attachments, [file]);
  await f.send("Next instruction");
  await until(() => f.calls.filter((call) => call.method === "conversation_submit").length === 2);
  assert.deepEqual(f.calls.filter((call) => call.method === "conversation_submit")[1].args.attachments, []);
});

test("multiline paste through chat submits one complete task and stop cancels it", async (t) => {
  const f = await fixture(t);
  f.input.write("\x1b[200~Read the invoice\nThen save a report\x1b[201~");
  await new Promise(setImmediate);
  assert.equal(f.calls.filter((call) => call.method === "conversation_submit").length, 0);
  f.input.write("\r");
  await until(() => f.calls.some((call) => call.method === "conversation_submit"));
  assert.equal(f.calls.find((call) => call.method === "conversation_submit").args.task, "Read the invoice\nThen save a report");
  await f.send("/stop");
  await until(() => f.calls.some((call) => call.method === "cancel"));
});

test("a follow-up submitted as the previous turn finishes keeps streaming", async (t) => {
  const f = await fixture(t);
  await f.send("First task");
  await until(() => f.calls.some((call) => call.method === "events"));
  let release, captured = false;
  f.setState("completed");
  f.interceptRun(async (snapshot) => {
    if (snapshot.state === "completed" && !captured) {
      captured = true;
      await new Promise((resolve) => { release = resolve; });
    }
    return snapshot;
  });
  await until(() => captured);
  await f.send("Second task");
  await until(() => f.calls.filter((call) => call.method === "conversation_submit").length === 2);
  f.events.push({ seq: f.events.length + 1, type: "text_delta", delta: "Second response\n" });
  release();
  await until(() => f.screen.includes("Second response"));
});

test("an explicitly submitted task is accepted even when the terminal exits immediately", async (t) => {
  const f = await fixture(t);
  f.input.write("Keep working after I exit");
  f.input.write("\r");
  f.input.write("/exit");
  f.input.write("\r");
  await f.done;
  assert.equal(f.calls.filter((call) => call.method === "conversation_submit").length, 1);
  assert.equal(f.calls.filter((call) => call.method === "cancel").length, 0);
});
