import test from "node:test";
import assert from "node:assert/strict";
import { frontendRoute, runFrontend } from "../src/frontend.mjs";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { bridge } from "../src/fx-bridge.mjs";
import { paths } from "../src/util.mjs";
import { saveToken } from "../src/frontend-tokens.mjs";
import { frontendAuth } from "../src/fx-provider.mjs";

const until = async (fn) => {
  for (let i = 0; i < 300; i++) { if (fn()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw Error("Frontend did not reach expected state");
};

test("default onboarding, help, setup, models and session flags use the native fx frontend", () => {
  for (const args of [[], ["--help"], ["setup"], ["login"], ["models"], ["--continue"], ["--resume", "last"], ["ask", "Read this page"], ["ask", "memory"], ["--model", "context"]])
    assert.deepEqual(frontendRoute(args), { native: true, args });
  assert.deepEqual(frontendRoute(["durable", "--resume", "run-id"]), { native: false, args: ["--resume", "run-id"] });
  assert.equal(frontendRoute(["worker", "serve"]).native, false);
  assert.deepEqual(frontendRoute(["--home", "/tmp/browse-home"]), { native: true, args: [], home: "/tmp/browse-home" });
  assert.equal(frontendRoute(["--home", "/tmp/browse-home", "--json", "worker", "status"]).native, false);
});

test("native launcher inherits the real terminal and uses the same Node for its private bridge", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "browse-frontend-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const binary = path.join(directory, "frontend"); fs.writeFileSync(binary, "fixture");
  let observed;
  const previous = process.exitCode;
  await runFrontend(["--continue"], { binary, launch: (command, args, options) => {
    observed = { command, args, options };
    const child = new EventEmitter(); queueMicrotask(() => child.emit("exit", 0, null)); return child;
  } });
  process.exitCode = previous;
  assert.equal(observed.command, binary);
  assert.equal(observed.options.stdio, "inherit");
  assert.equal(observed.options.env.BROWSE_NODE, process.execPath);
  assert.equal(observed.options.env.FX_AUTO_UPGRADE, "0");
  assert.ok(observed.options.env.BROWSE_FRONTEND_BRIDGE.endsWith("/src/fx-bridge.mjs"));
  assert.ok(observed.options.env.BROWSE_TOKEN_HELPER.endsWith("/src/frontend-tokens.mjs"));
  await runFrontend(["setup"], { binary, launch: (command, args, options) => {
    assert.deepEqual(args, []);
    assert.equal(options.env.BROWSE_OPEN_SETUP, "1");
    const child = new EventEmitter(); queueMicrotask(() => child.emit("exit", 0, null)); return child;
  } });
  process.exitCode = previous;
});

test("bridge renders events, forwards steering and answers, and detaches without cancelling", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "browse-bridge-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = new PassThrough(), emitted = [], calls = [], events = [];
  let state = "running", question;
  const p = paths(directory);
  const call = async (_p, method, args) => {
    calls.push({ method, args });
    if (method === "frontend_submit") return { run: { id: "run" }, after: 0 };
    if (method === "events") return events.filter((event) => event.seq > args.after);
    if (method === "run") return { id: "run", state, question, questionOptions: ["Personal", "Work"] };
    if (method === "event_cursor") return events.length;
    if (method === "conversation_submit") return { id: "run" };
    if (method === "respond") { state = "running"; question = undefined; return { id: "run" }; }
    throw Error(`Unexpected call ${method}`);
  };
  const done = bridge({ p, input, emit: (event) => emitted.push(event), connect: async () => {}, call });
  const send = (value) => input.write(JSON.stringify(value) + "\n");
  send({ type: "start", protocol: 1, session: "native-session", prompt: "Read invoices", provider: "gateway", model: "anthropic/claude", apiKey: "fixture-secret" });
  await until(() => calls.some((entry) => entry.method === "events"));
  events.push({ seq: 1, type: "text_delta", delta: "**Invoice**\n" },
    { seq: 2, type: "tool_start", actionId: "one", name: "read" },
    { seq: 3, type: "tool_end", actionId: "one", name: "read" });
  send({ type: "steer", text: "Only October" });
  await until(() => emitted.some((event) => event.type === "tool_done"));
  question = "Which account?"; state = "waiting";
  await until(() => emitted.some((event) => event.type === "question"));
  send({ type: "answer", text: "Personal" });
  await until(() => calls.some((entry) => entry.method === "respond"));
  input.end(); await done;
  assert.equal(calls.filter((entry) => entry.method === "cancel").length, 0);
  assert.equal(calls.find((entry) => entry.method === "conversation_submit").args.task, "Only October");
  assert.ok(emitted.some((event) => event.delta === "**Invoice**\n"));
  assert.ok(!JSON.stringify(calls).includes("fixture-secret"));
  const credentials = path.join(p.private, "frontend-credentials");
  assert.equal(fs.statSync(path.join(credentials, fs.readdirSync(credentials)[0])).mode & 0o777, 0o600);
});

test("bridge resolves a saved provider token privately instead of forwarding its UI credential", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "browse-byot-bridge-"));
  const previousHome = process.env.BROWSE_PROFILE_HOME;
  process.env.BROWSE_PROFILE_HOME = directory;
  t.after(() => {
    if (previousHome === undefined) delete process.env.BROWSE_PROFILE_HOME;
    else process.env.BROWSE_PROFILE_HOME = previousHome;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await saveToken({ provider: "custom", apiKey: "private-provider-token", endpoint: "http://localhost:1234/v1", profileHome: directory,
    network: async () => Response.json({ data: [{ id: "vendor/model" }] }) });
  const p = paths(path.join(directory, "durable")), input = new PassThrough(), calls = [];
  const done = bridge({ p, input, connect: async () => {}, emit: () => {}, call: async (_p, method, args) => {
    calls.push({ method, args });
    if (method === "frontend_submit") return { run: { id: "run" }, after: 0 };
    if (method === "events") return [];
    if (method === "run") return { id: "run", state: "running" };
    throw Error(`Unexpected ${method}`);
  } });
  input.write(JSON.stringify({ type: "start", protocol: 1, session: "token-session", provider: "gateway",
    model: "custom/vendor/model", apiKey: "browse-token-profile", prompt: "Read this page" }) + "\n");
  await until(() => calls.some((entry) => entry.method === "frontend_submit"));
  input.end(); await done;
  const credential = frontendAuth(p, calls.find((entry) => entry.method === "frontend_submit").args.model);
  assert.equal(credential.apiKey, "private-provider-token");
  assert.equal(credential.tokenProvider, "custom");
  assert.equal(credential.tokenModel, "vendor/model");
  assert.equal(credential.tokenEndpoint, "http://localhost:1234/v1");
  assert.ok(!JSON.stringify(calls).includes("private-provider-token"));
  assert.ok(!JSON.stringify(calls).includes("browse-token-profile"));
});

test("an unknown BYOT model is rejected before any worker or gateway request", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "browse-byot-binding-"));
  const previousHome = process.env.BROWSE_PROFILE_HOME;
  process.env.BROWSE_PROFILE_HOME = directory;
  t.after(() => {
    if (previousHome === undefined) delete process.env.BROWSE_PROFILE_HOME;
    else process.env.BROWSE_PROFILE_HOME = previousHome;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await saveToken({ provider: "openai", apiKey: "private-token", profileHome: directory,
    network: async () => Response.json({ data: [{ id: "gpt-fixture" }] }) });
  const input = new PassThrough(), events = [];
  const done = bridge({ p: paths(path.join(directory, "durable")), input, emit: (event) => events.push(event),
    connect: async () => assert.fail("Unknown model connected to worker") });
  input.write(JSON.stringify({ type: "start", protocol: 1, session: "token-session", provider: "gateway",
    model: "anthropic/unknown-gateway-model", apiKey: "private-token", prompt: "Read this page" }) + "\n");
  await done;
  assert.ok(events.some((event) => event.type === "finished" && event.state === "failed"));
  assert.ok(events.some((event) => event.text?.includes("Choose a model from /model")));
  assert.ok(!JSON.stringify(events).includes("private-token"));
  input.destroy();
});

test("frontend finish handshake admits a last-moment follow-up before closing the turn", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "browse-bridge-finish-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = new PassThrough(), events = [], calls = [];
  const image = path.join(directory, "image.png"); fs.writeFileSync(image, Buffer.from([137,80,78,71]));
  let run = { id: "run", state: "completed", conversationId: "conversation", model: "fx:gateway:fixture" };
  const send = (value) => input.write(JSON.stringify(value) + "\n");
  const done = bridge({ p: paths(directory), input, connect: async () => {}, emit: (event) => events.push(event), call: async (_p, method, args) => {
    calls.push({ method, args });
    if (method === "frontend_submit") return { run, after: 0 };
    if (method === "events") return [];
    if (method === "event_cursor") return 0;
    if (method === "run") return { ...run };
    if (method === "conversation_submit") { run.state = "running"; return { ...run }; }
    throw Error(`Unexpected ${method}`);
  } });
  send({ type: "start", protocol: 1, session: "native", prompt: "Read", provider: "gateway", model: "fixture", apiKey: "fixture", images: [{ path: image }] });
  await until(() => events.some((event) => event.type === "settled"));
  assert.equal(events.some((event) => event.type === "finished"), false);
  const staged = calls.find((entry) => entry.method === "frontend_submit").args.attachments[0];
  fs.unlinkSync(image); assert.deepEqual(fs.readFileSync(staged), Buffer.from([137,80,78,71]));
  send({ type: "steer", text: "One more thing" });
  await until(() => calls.some((entry) => entry.method === "conversation_submit"));
  assert.equal(events.some((event) => event.type === "finished"), false);
  run.state = "completed";
  await until(() => events.filter((event) => event.type === "settled").length === 2);
  send({ type: "finish" }); await done;
  assert.equal(events.filter((event) => event.type === "finished").length, 1);
  input.destroy();
});
