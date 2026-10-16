import readline from "node:readline";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { paths, atomic, hash, json, TERMINAL } from "./util.mjs";
import path from "node:path";
import os from "node:os";
import { ensureWorker, request } from "./worker.mjs";
import { fileURLToPath } from "node:url";
import { resolveToken, tokenFile } from "./frontend-tokens.mjs";

// This private JSONL pipe joins the upstream terminal to the durable worker.
// Closing the terminal detaches observation; only an explicit interrupt cancels.
export async function bridge({ input = process.stdin, emit = (event) => process.stdout.write(JSON.stringify(event) + "\n"), p = paths(), connect = ensureWorker, call = request } = {}) {
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let run, cursor = 0, closed = false, started = false, questionPending = false, settling = false, finishRequested = false, chain = Promise.resolve();
  const pending = [];
  const send = (value) => { if (!closed) emit(value); };
  const control = async (message) => {
    if (!run) { pending.push(message); return; }
    if (message.type === "cancel") await call(p, "cancel", { id: run.id });
    else if (message.type === "answer") { run = await call(p, "respond", { id: run.id, answer: message.text }); questionPending = false; }
    else if (message.type === "detach") { send({ type: "finished", state: "waiting" }); closed = true; }
    else if (message.type === "finish") finishRequested = true;
    else if (message.type === "steer") {
      settling = false; finishRequested = false;
      run = await call(p, "conversation_submit", { conversationId: run.conversationId, task: message.text, model: run.model });
    }
  };
  const start = async (message) => {
    if (started) throw Error("Duplicate frontend start");
    if (message.protocol !== 1) throw Error("Rebuild the Browse frontend with npm run build:frontend, then reopen browse.");
    started = true;
    message.session ||= randomUUID();
    const profileHome = process.env.BROWSE_PROFILE_HOME || os.homedir();
    const configured = json(path.join(profileHome, ".browse-fx/settings.json"), {}).providers?.[message.provider];
    if (!/^[\w-]{1,160}$/.test(message.session || "") ||
        (!["gateway", "codex", "grok"].includes(message.provider) && !configured))
      throw Error("Unsupported frontend session or provider");
    if (typeof message.apiKey !== "string" || (!message.apiKey && configured?.auth?.type !== "none")) throw Error("Sign in with /setup before sending a message");
    const binding = hash(JSON.stringify([message.session, message.provider, message.model, message.accountId, message.team])).slice(0, 20);
    const model = `fx:${message.provider}:${message.model}#${binding}`;
    const gatewaySession = message.provider === "gateway" ? json(path.join(profileHome, ".browse-fx/auth.json"), null) : null;
    const token = message.provider === "gateway" ? resolveToken(message.model, profileHome) : null;
    if (message.provider === "gateway" && !token && fs.existsSync(tokenFile(profileHome)))
      throw Error("Choose a model from /model for one of your connected providers, or reconnect with /setup.");
    const credentials = { provider: message.provider, model: message.model, apiKey: message.apiKey, accountId: message.accountId, team: message.team, settings: message.settings, profileHome, configured, oauthSession: gatewaySession?.access_token === message.apiKey ? gatewaySession : undefined,
      ...(token ? { tokenProvider: token.provider, apiKey: token.apiKey, tokenModel: token.model, tokenEndpoint: token.endpoint, oauthSession: undefined, team: undefined } : {}) };
    atomic(path.join(p.private, "frontend-credentials", hash(model) + ".json"), JSON.stringify(credentials));
    await connect(p);
    const attachments = (message.images || []).map((image) => {
      const original = fs.realpathSync(image.snapshot_path || image.path);
      if (!fs.statSync(original).isFile() || fs.statSync(original).size > 64 * 1024 * 1024) throw Error("Attachment must be a file of at most 64 MiB");
      const bytes = fs.readFileSync(original);
      const staged = path.join(p.private, "staging", `${hash(bytes)}-${path.basename(image.path || original)}`);
      atomic(staged, bytes);
      return staged;
    });
    const result = await call(p, "frontend_submit", {
      session: message.session, task: message.prompt, model,
      attachments,
    });
    run = result.run; cursor = result.after;
    for (const message of pending.splice(0)) await control(message);
  };
  lines.on("line", (line) => {
    chain = chain.then(async () => {
      const message = JSON.parse(line);
      if (message.type === "start") await start(message);
      else await control(message);
    }).catch((error) => { send({ type: "notice", text: error.message }); send({ type: "finished", state: "failed" }); closed = true; lines.close(); });
  });
  lines.once("close", () => { closed = true; });
  try {
    while (!closed) {
      await chain;
      if (run) {
        const events = await call(p, "events", { id: run.id, after: cursor });
        const details = events.some((event) => ["tool_start", "tool_end", "tool_error"].includes(event.type))
          ? new Map(((await call(p, "run", { id: run.id })).actions || []).map((action) => [action.id, action])) : new Map();
        for (const event of events) {
          cursor = event.seq;
          if (event.type === "text_delta") send({ type: event.type, delta: event.delta });
          else if (["tool_start", "tool_end", "tool_error"].includes(event.type)) send({
            type: event.type === "tool_end" ? (event.isError ? "tool_error" : "tool_done") : event.type, actionId: event.actionId, name: event.name || "browser",
            result: event.error || JSON.stringify(details.get(event.actionId)?.result || "").slice(0, 100000),
          });
          else if (["recovery", "retry"].includes(event.type)) send({ type: "notice", text: event.message || event.error || "Reconnecting to continue the task…" });
        }
        run = await call(p, "run", { id: run.id });
        if (events.length < 1000 && (TERMINAL.has(run.state) || run.state === "paused" || (run.state === "waiting" && run.question))) {
          // A state transition may have committed after this event page was read.
          if (await call(p, "event_cursor", { id: run.id }) > cursor) continue;
          await chain;
          if (run.question) {
            if (!questionPending) {
              questionPending = true;
              send({ type: "question", text: run.question, options: run.questionOptions || [] });
            }
            send({ type: "heartbeat" });
            await new Promise((resolve) => setTimeout(resolve, 150));
            continue;
          }
          if (run.error) send({ type: "notice", text: run.error });
          if (finishRequested) { send({ type: "finished", state: run.state }); break; }
          if (!settling) { settling = true; send({ type: "settled", state: run.state }); }
        }
      }
      send({ type: "heartbeat" });
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  } finally { lines.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  bridge().catch(() => {
    process.stdout.write(JSON.stringify({ type: "notice", text: "The Browse worker connection failed. Reopen the session to reconnect." }) + "\n");
    process.stdout.write(JSON.stringify({ type: "finished", state: "failed" }) + "\n");
    process.exitCode = 1;
  });
}
