import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  paths,
  id,
  now,
  atomic,
  mkdir,
  duration,
  name,
  workflow,
  TERMINAL,
} from "./util.mjs";
import { Store } from "./store.mjs";
import { Workspace } from "./workspace.mjs";
import { executeAgent, compileWorkflow } from "./agent.mjs";
import { contractProgress, readContract } from "./contract.mjs";

const WORKER_PROTOCOL = 6;

export function request(p, method, params = {}, timeout = 90000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(p.socket);
    let data = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Error("Worker request timed out"));
    }, timeout);
    const finish = () => clearTimeout(timer);
    socket.on("error", (e) => {
      finish();
      reject(e);
    });
    socket.on("connect", () =>
      socket.write(JSON.stringify({ method, params }) + "\n"),
    );
    socket.on("data", (chunk) => {
      data += chunk;
      if (data.includes("\n")) {
        finish();
        socket.end();
        try {
          const result = JSON.parse(data.split("\n")[0]);
          if (result.error) reject(Error(result.error));
          else resolve(result.value);
        } catch (e) {
          reject(e);
        }
      }
    });
    socket.on("close", () => {
      finish();
      if (!data) reject(Error("Worker connection closed"));
    });
  });
}
export async function ensureWorker(p) {
  let status;
  try {
    status = await request(p, "status", {}, 1000);
  } catch {}
  if (status?.conversationProtocol === WORKER_PROTOCOL) return status;
  if (status) {
    if (status.activeRun)
      throw Error("The existing Browse worker needs an update. Let its current turn finish, then reopen browse.");
    await request(p, "stop");
    let stopped = false;
    for (let i = 0; i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try { await request(p, "status", {}, 1000); }
      catch { stopped = true; break; }
    }
    if (!stopped) throw Error("The previous Browse worker did not stop; try again shortly.");
  }
  mkdir(p.private);
  const output = fs.openSync(path.join(p.private, "worker.log"), "a", 0o600);
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../bin/browse.mjs", import.meta.url)),
      "worker",
      "serve",
    ],
    {
      detached: true,
      stdio: ["ignore", output, output],
      env: { ...process.env, BROWSE_HOME: p.root },
    },
  );
  child.unref();
  fs.closeSync(output);
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      return await request(p, "status", {}, 1000);
    } catch {}
  }
  throw Error(
    `Worker could not start; inspect ${path.join(p.private, "worker.log")}`,
  );
}

export class Worker {
  constructor(p, { agent = executeAgent, compiler = compileWorkflow, retryDelayMs = 1000 } = {}) {
    this.p = p;
    this.store = new Store(p);
    this.workspace = new Workspace(p, this.store);
    this.agent = agent;
    this.compiler = compiler;
    this.active = null;
    this.turn = null;
    this.stopping = false;
    this.retryDelayMs = retryDelayMs;
    this.deliveredSteering = new Set();
  }
  initialize() {
    this.workspace.init();
    this.store.rebuild(this.p.checkout);
    this.store.importedHistory(this.p.checkout);
    for (const pending of this.store.pending())
      if (pending.path.startsWith("context/records/"))
        this.store.index(JSON.parse(pending.data));
    for (const run of this.store.runs())
      if (run.state === "running") {
        run.recoveryNeeded = true;
        run.state = "queued";
        this.store.saveRun(run);
        this.store.event(run.id, "recovery", {
          reason: "Worker restarted during active turn",
        });
      }
  }
  status() {
    return {
      running: true,
      conversationProtocol: WORKER_PROTOCOL,
      pid: process.pid,
      workspace: this.store.meta("workspace"),
      home: this.p.root,
      activeRun: this.active?.id,
      publicationError: this.publicationError,
      pendingPublications: this.store.pending().length,
      conversation: this.store.conversation()?.id,
      progress: (() => { const c = this.store.conversation(); return c?.run_id ? contractProgress(this.store.run(c.run_id).contract) : null; })(),
    };
  }
  async dispatch(method, args = {}) {
    if (this.stopping && method !== "status") throw Error("Worker is stopping");
    switch (method) {
      case "status":
        return this.status();
      case "submit":
        return this.store.createRun(args.task, args);
      case "conversation_open": {
        let conversation = this.store.conversation();
        if (!conversation && !this.store.meta("activeConversation")) {
          const previousRuns = this.store.runs().filter((r) => !r.historical && !r.workflowRevision && !r.conversationId).reverse();
          if (previousRuns.length) {
            conversation = this.store.newConversation();
            for (const previous of previousRuns) {
              previous.conversationId = conversation.id;
              this.store.saveRun(previous);
              this.store.linkConversation(conversation.id, previous.id);
              let after = 0;
              const seen = new Set([0]);
              for (;;) {
                const events = this.store.events(previous.id, after);
                for (const event of events) {
                  if (event.type === "running" && !seen.has(event.step) && previous.steps[event.step]?.task) {
                    this.store.historyEvent(previous.id, { type: "user_message", text: previous.steps[event.step].task, at: event.at }, `${event.seq}:legacy`);
                    seen.add(event.step);
                  }
                  this.store.historyEvent(previous.id, event, event.seq);
                  after = event.seq;
                }
                if (events.length < 1000) break;
              }
              this.store.portableRun(previous.id);
            }
            conversation = this.store.conversation();
          }
        }
        const run = conversation?.run_id ? this.store.run(conversation.run_id) : null;
        return { conversation, run, after: run ? this.store.eventCursor(run.id) : 0,
          inputHistory: this.store.conversationInputHistory(conversation?.id),
          messages: conversation ? this.store.conversationMessages(conversation.id, 10) : [] };
      }
      case "conversation_new":
        return this.store.newConversation();
      case "conversations":
        return this.store.conversations();
      case "conversation_select":
        this.store.selectConversation(args.id);
        return this.dispatch("conversation_open");
      case "conversation_history":
        return this.store.conversationPage(args.id || this.store.conversation()?.id, args);
      case "conversation_search":
        return this.store.conversationSearch(args.id || this.store.conversation()?.id, args.query);
      case "contract":
        return readContract(this.store, args.id);
      case "frontend_submit": {
        if (typeof args.session !== "string" || !/^[\w-]{1,160}$/.test(args.session))
          throw Error("Invalid frontend session");
        const key = `frontend:${args.session}`;
        let conversationId = this.store.meta(key);
        if (!conversationId) {
          conversationId = this.store.newConversation().id;
          this.store.setMeta(key, conversationId);
        }
        const conversation = this.store.db.prepare("SELECT * FROM conversations WHERE id=?").get(conversationId);
        const after = conversation.run_id ? this.store.eventCursor(conversation.run_id) : 0;
        const run = await this.dispatch("conversation_submit", { ...args, conversationId });
        return { run, after: run.id === conversation.run_id ? after : 0 };
      }
      case "conversation_submit": {
        if (typeof args.task !== "string" || !args.task.trim() || args.task.length > 64000)
          throw Error("Instruction must be nonempty and at most 64000 characters");
        const conversation = args.conversationId
          ? this.store.db.prepare("SELECT * FROM conversations WHERE id=?").get(args.conversationId)
          : this.store.conversation() || this.store.newConversation();
        if (!conversation) throw Error("Conversation not found");
        const run = conversation.run_id ? this.store.run(conversation.run_id) : null;
        if (!run || run.historical) {
          return this.store.createRun(args.task, { ...args, conversationId: conversation.id });
        }
        if (run.question) return this.dispatch("respond", { ...args, id: run.id, answer: args.task });
        if (TERMINAL.has(run.state) || run.state === "paused")
          return this.dispatch("continue", { ...args, id: run.id });
        await this.dispatch("steer", { id: run.id, text: args.task, attachments: args.attachments });
        return this.store.run(run.id);
      }
      case "runs":
        return this.store.runs();
      case "run":
        return {
          ...this.store.run(args.id),
          actions: this.store.actions(args.id),
        };
      case "events":
        return this.store.events(args.id, args.after || 0);
      case "event_cursor":
        return this.store.eventCursor(args.id);
      case "pause":
      case "cancel": {
        const run = this.store.run(args.id);
        if (run.historical) throw Error("Imported history cannot execute");
        run.state = method === "pause" ? "paused" : "cancelled";
        if (method === "cancel") {
          delete run.question; delete run.questionOptions; delete run.wakeAt;
          for (const input of run.inputs) if (input.applied === false) input.discarded = true;
        }
        if (this.active?.id === run.id) {
          run.recoveryNeeded = true;
          this.active.controller.abort();
        }
        this.store.saveRun(run);
        this.store.event(run.id, run.state);
        this.store.portableRun(run.id);
        return run;
      }
      case "resume": {
        const run = this.store.run(args.id);
        if (run.historical) throw Error("Imported history cannot execute");
        if (
          run.state === "running" ||
          run.state === "queued" ||
          run.state === "completed"
        )
          throw Error("Run is active or completed");
        if (run.question)
          throw Error("Use browse respond to answer the pending question");
        run.recoveryNeeded =
          this.store
            .actions(run.id)
            .some((a) => a.state === "dispatched" && a.effectful) ||
          run.recoveryNeeded;
        run.state = "queued";
        delete run.wakeAt;
        if (args.model) run.model = args.model;
        this.store.saveRun(run);
        return run;
      }
      case "respond": {
        const run = this.store.run(args.id);
        if (run.historical || !["waiting", "paused"].includes(run.state) || !run.question)
          throw Error("Run is not waiting for input");
        run.inputs.push({
          question: run.question,
          answer: String(args.answer),
          at: now(),
        });
        delete run.question;
        delete run.questionOptions;
        if (args.attachments?.length) run.attachments = [...new Set([...run.attachments, ...args.attachments])];
        run.state = "queued";
        if (args.model) run.model = args.model;
        // User answers authorize another read-only recovery pass; they never silently mark a browser action successful.
        this.store.saveRun(run);
        this.store.event(run.id, "response", { answer: args.answer });
        return run;
      }
      case "steer": {
        const run = this.store.run(args.id);
        if (run.historical || !["running", "queued", "waiting"].includes(run.state))
          throw Error("No active turn; use continue");
        if (typeof args.text !== "string" || !args.text.trim() || args.text.length > 64000)
          throw Error("Steering must be nonempty and at most 64000 characters");
        this.store.event(run.id, "steering", { text: args.text });
        run.inputs.push({ id: id(), steering: args.text, at: now(), applied: false,
          ...(args.attachments?.length ? { modelText: `${args.text}\n\nExplicit attachments for this message: ${JSON.stringify(args.attachments)}` } : {}) });
        if (args.attachments?.length) run.attachments = [...new Set([...run.attachments, ...args.attachments])];
        this.store.saveRun(run);
        if (this.active?.id === run.id && this.turn)
          await this.deliverSteering(run.id, this.turn);
        return { accepted: true };
      }
      case "continue": {
        const run = this.store.run(args.id);
        if (run.historical || (!TERMINAL.has(run.state) && !(run.conversationId && run.state === "paused")))
          throw Error("Run is not available for continuation");
        if (typeof args.task !== "string" || !args.task.trim() || args.task.length > 64000)
          throw Error("Instruction must be nonempty and at most 64000 characters");
        run.recoveryNeeded ||= this.store
          .actions(run.id)
          .some((a) => a.state === "dispatched" && a.effectful);
        run.steps.push({ type: "browser", task: String(args.task) });
        run.step = run.steps.length - 1;
        run.task = args.task;
        run.state = "queued";
        delete run.error;
        if (args.model) run.model = args.model;
        if (args.attachments?.length)
          run.attachments = [...new Set([...run.attachments, ...args.attachments])];
        this.store.tx(() => {
          this.store.saveRun(run);
          this.store.event(run.id, "user_message", { text: args.task });
          this.store.portableRun(run.id);
        });
        return run;
      }
      case "feedback": {
        const record = this.store.feedback(args.id, args.rating, args.comment);
        this.store.portableRun(args.id);
        return record;
      }
      case "memory_search":
        return this.store.search(args.query);
      case "memory_add":
        return this.store.record(
          "memory",
          { name: name(args.name), content: String(args.content) },
          { logicalId: args.name },
        );
      case "records":
        return this.store.records(args.kind);
      case "record":
        return args.kind
          ? this.store.latest(args.kind, args.id)
          : this.store.getRecord(args.id);
      case "links":
        return [
          "skill",
          "workflow",
          "memory",
          "feedback",
          "artifact",
          "outcome",
        ]
          .flatMap((kind) => this.store.records(kind))
          .flatMap((record) =>
            (record.links || [])
              .filter((link) => record.id === args.id || link.to === args.id)
              .map((link) => ({ from: record.id, ...link })),
          );
      case "skill_save": {
        name(args.name);
        if (!args.instructions) throw Error("Skill instructions required");
        return this.store.record(
          "skill",
          {
            name: args.name,
            description: args.description || "",
            instructions: args.instructions,
            evidence: "Explicitly supplied by user",
          },
          { logicalId: args.name },
        );
      }
      case "skill_restore": {
        const record = this.store.getRecord(args.revision);
        if (record.kind !== "skill") throw Error("Not a skill revision");
        return this.store.record("skill", record.body, {
          logicalId: record.logicalId,
          links: [{ relation: "restores", to: record.id }],
        });
      }
      case "workflow_create": {
        name(args.name);
        const definition = args.definition
          ? workflow(args.definition)
          : workflow(
              await this.compiler(
                this.p,
                args.name,
                args.description,
                args.model,
              ),
            );
        if (definition.name !== args.name)
          throw Error("Workflow name mismatch");
        return this.store.saveWorkflow(definition);
      }
      case "workflow_run": {
        const r = this.store.latest("workflow", args.name);
        return this.store.createRun(r.body.description || `Run ${args.name}`, {
          ...args,
          steps: r.body.steps,
          workflowRevision: r.id,
        });
      }
      case "schedule_create": {
        name(args.name);
        this.store.latest("workflow", args.workflow);
        if (Boolean(args.at) === Boolean(args.every))
          throw Error("Specify exactly one of --at or --every");
        if (this.store.schedules().some((s) => s.name === args.name))
          throw Error("Schedule already exists");
        const interval = args.every ? duration(args.every) : null,
          wake = interval ? Date.now() + interval : Date.parse(args.at);
        if (!Number.isFinite(wake)) throw Error("Invalid timestamp");
        return this.store.schedule({
          name: args.name,
          workflow: args.workflow,
          enabled: true,
          interval,
          nextAt: wake,
          model: args.model,
        });
      }
      case "schedules":
        return this.store.schedules();
      case "schedule_disable":
      case "schedule_enable":
      case "schedule_delete": {
        const s = this.store.schedules().find((s) => s.name === args.name);
        if (!s) throw Error("Schedule not found");
        s.enabled = method === "schedule_enable";
        if (method === "schedule_delete") s.deleted = true;
        return this.store.schedule(s);
      }
      case "artifact_export": {
        const record = this.store.getRecord(args.id);
        if (record.kind !== "artifact") throw Error("Not an artifact");
        const file = this.workspace.extract(record.body.path, args.revision);
        const dest = path.resolve(args.destination);
        if (fs.existsSync(dest)) throw Error("Destination exists");
        mkdir(path.dirname(dest));
        fs.copyFileSync(file, dest, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(dest, 0o600);
        return { file: dest };
      }
      case "export":
      case "sync":
      case "reindex": {
        if (this.active)
          throw Error(
            "Wait for the active run or pause it before workspace export/sync",
          );
        if (method === "export") return this.workspace.export(args.destination);
        if (method === "sync") return this.workspace.sync(args.remote);
        this.store.rebuild(this.p.checkout);
        return { rebuilt: true };
      }
      case "flush":
        return this.workspace.flush();
      case "stop":
        this.stopping = true;
        this.active?.controller.abort();
        return { stopping: true };
      default:
        throw Error(`Unknown worker operation: ${method}`);
    }
  }
  async deliverSteering(runId, turn) {
    for (const input of this.store.run(runId).inputs) {
      if (!input.steering || input.discarded || input.applied !== false || this.deliveredSteering.has(input.id)) continue;
      this.deliveredSteering.add(input.id);
      try { await turn.steer(input.modelText || input.steering); }
      catch (error) {
        this.deliveredSteering.delete(input.id);
        if (error.code !== "FX_TURN_SETTLED" && !/no prompt is running/i.test(error.message)) throw error;
      }
    }
  }
  async tick() {
    if (this.stopping || this.active) return;
    try {
      this.workspace.flush();
      this.publicationError = undefined;
    } catch (e) {
      this.publicationError = e.message;
    }
    for (const run of this.store.runs())
      if (run.state === "waiting" && run.wakeAt <= Date.now()) {
        run.state = "queued";
        delete run.wakeAt;
        this.store.saveRun(run);
      }
    for (const s of this.store.schedules())
      if (s.enabled && !s.deleted && s.nextAt <= Date.now()) {
        if (s.activeRun && !TERMINAL.has(this.store.run(s.activeRun).state))
          continue;
        const w = this.store.latest("workflow", s.workflow);
        const run = this.store.createRun(
          w.body.description || `Run ${s.workflow}`,
          { steps: w.body.steps, workflowRevision: w.id, model: s.model },
        );
        s.activeRun = run.id;
        if (s.interval) s.nextAt = Date.now() + s.interval;
        else s.enabled = false;
        this.store.schedule(s);
      }
    const run = this.store
      .runs()
      .reverse()
      .find((r) => r.state === "queued" && !r.historical);
    if (!run) return;
    const step = run.steps[run.step];
    if (!step) {
      run.state = "completed";
      this.store.saveRun(run);
      this.store.portableRun(run.id);
      return;
    }
    if (step.type === "wait") {
      run.step++;
      run.state = "waiting";
      run.wakeAt = Date.now() + duration(step.duration);
      this.store.saveRun(run);
      this.store.event(run.id, "waiting", { wakeAt: run.wakeAt });
      this.store.portableRun(run.id);
      return;
    }
    if (step.type === "input") {
      run.step++;
      run.state = "waiting";
      run.question = step.question;
      this.store.saveRun(run);
      this.store.event(run.id, "input_required", { question: run.question });
      this.store.portableRun(run.id);
      return;
    }
    const controller = new AbortController();
    this.active = { id: run.id, controller };
    this.deliveredSteering.clear();
    run.state = "running";
    this.store.saveRun(run);
    this.store.event(run.id, "running", { step: run.step });
    try {
      const outcome = await this.agent({
        p: this.p,
        store: this.store,
        workspace: this.workspace,
        run,
        signal: controller.signal,
        onTurn: async (t) => {
          this.turn = t;
          if (t && !run.recoveryNeeded) await this.deliverSteering(run.id, t);
        },
      });
      const current = this.store.run(run.id);
      run.inputs = current.inputs;
      run.attachments = current.attachments;
      run.contract = current.contract;
      if (current.state !== "running") return;
      run.answer = outcome.answer;
      run.usage = outcome.result?.usage;
      run.retryCount = 0;
      delete run.error;
      delete run.question;
      delete run.questionOptions;
      if (outcome.unresolved?.length) run.recoveryNeeded = true;
      if (!outcome.recovery && outcome.unresolved?.length && !["input", "wait"].includes(outcome.control?.type)) {
        run.state = "queued";
        this.store.event(run.id, "recovery", { reason: "Checking an uncertain browser outcome" });
      } else if (outcome.control?.type === "input") {
        run.state = "waiting";
        run.question = outcome.control.question;
        run.questionOptions = outcome.control.options;
      } else if (outcome.control?.type === "wait") {
        run.state = "waiting";
        run.wakeAt = Date.now() + outcome.control.milliseconds;
      } else if (outcome.recovery) {
        run.recoveryNeeded = this.store.actions(run.id).some((action) => action.effectful && action.state === "dispatched");
        run.state = "queued";
      } else {
        const pendingSteering = run.inputs.some((input) => input.steering && !input.discarded && input.applied === false);
        const progress = contractProgress(run.contract);
        if ((progress && !progress.complete) || pendingSteering) {
          run.state = "queued";
          run.slices = (run.slices || 0) + 1;
          this.store.event(run.id, "continuing", { reason: pendingSteering ? "Applying your follow-up" : "Completion criteria remain", progress });
        } else {
          run.step++;
          run.state = run.step >= run.steps.length ? "completed" : "queued";
        }
      }
      this.store.saveRun(run);
      this.store.event(run.id, run.state, {
        answer: run.answer,
        question: run.question,
        questionOptions: run.questionOptions,
        wakeAt: run.wakeAt,
      });
      if (run.state === "completed")
        this.store.record(
          "outcome",
          {
            runId: run.id,
            task: run.task,
            answer: run.answer,
            assessment: run.contract ? "contract_evidence_recorded" : "agent_reported",
            actionIds: this.store.actions(run.id).map((a) => a.id),
          },
          {
            links: [
              { relation: "outcome_for", to: run.id },
              ...run.skillRevisions.map((to) => ({
                relation: "used_skill",
                to,
              })),
            ],
            source: "agent",
          },
        );
    } catch (e) {
      const current = this.store.run(run.id);
      if (current.state === "running") {
        const uncertain = this.store
          .actions(run.id)
          .some((a) => a.state === "dispatched" && a.effectful);
        const transient = Boolean(e.transient) || /timeout|timed out|network|fetch failed|HTTP (429|500|502|503|504)|Provider request failed \((429|500|502|503|504)\)/i.test(e.message);
        const retry = !controller.signal.aborted && transient;
        current.recoveryNeeded = uncertain;
        current.state = controller.signal.aborted ? "paused" : retry ? "waiting" : uncertain ? "waiting" : "failed";
        current.error = e.message;
        if (retry) {
          current.retryCount = (current.retryCount || 0) + 1;
          current.wakeAt = Date.now() + Math.min(60000, this.retryDelayMs * 2 ** Math.min(current.retryCount - 1, 16));
          delete current.question;
          this.store.event(run.id, "retrying", { reason: e.message, wakeAt: current.wakeAt, attempt: current.retryCount });
        } else if (uncertain)
          current.question =
            "A browser action may have executed before interruption. Describe what you see; Browse will inspect before continuing.";
        this.store.saveRun(current);
        this.store.event(run.id, current.state, {
          error: e.message,
          question: current.question,
        });
      }
    } finally {
      this.active = null;
      this.turn = null;
      this.store.portableRun(run.id);
      try {
        this.workspace.flush();
        this.publicationError = undefined;
      } catch (e) {
        this.publicationError = e.message;
      }
    }
  }
}

export async function serve(p = paths()) {
  mkdir(p.root);
  if (fs.existsSync(p.lock)) {
    const lock = JSON.parse(fs.readFileSync(p.lock, "utf8"));
    try {
      process.kill(lock.pid, 0);
      throw Error("Worker already running");
    } catch (e) {
      if (e.code !== "ESRCH") throw e;
      fs.unlinkSync(p.lock);
    }
  }
  const fd = fs.openSync(p.lock, "wx", 0o600);
  fs.writeSync(fd, JSON.stringify({ pid: process.pid, token: id() }));
  fs.closeSync(fd);
  let worker, server;
  try {
    fs.rmSync(p.socket, { force: true });
    worker = new Worker(p);
    worker.initialize();
    server = net.createServer((socket) => {
      let buffer = "",
        handled = false;
      socket.on("error", () => {});
      socket.on("data", async (chunk) => {
        if (handled) return;
        buffer += chunk;
        if (buffer.length > 1024 * 1024) {
          socket.destroy();
          return;
        }
        if (!buffer.includes("\n")) return;
        handled = true;
        try {
          const { method, params } = JSON.parse(buffer.split("\n")[0]);
          const value = await worker.dispatch(method, params);
          socket.end(JSON.stringify({ value }) + "\n");
        } catch (e) {
          socket.end(JSON.stringify({ error: e.message }) + "\n");
        }
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(p.socket, resolve);
    });
    fs.chmodSync(p.socket, 0o600);
    const stop = () => {
      worker.stopping = true;
      worker.active?.controller.abort();
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    while (!worker.stopping) {
      await worker.tick();
      await new Promise((r) => setTimeout(r, 250));
    }
  } finally {
    if (worker?.active) worker.active.controller.abort();
    if (server) await new Promise((r) => server.close(r));
    try {
      worker?.workspace.flush();
    } catch {}
    worker?.store.close();
    fs.rmSync(p.socket, { force: true });
    fs.rmSync(p.lock, { force: true });
  }
}
