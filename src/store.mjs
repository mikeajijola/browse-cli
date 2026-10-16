import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { id, now, mkdir, workflow } from "./util.mjs";
import { importHistory } from "./history.mjs";

export class Store {
  constructor(p) {
    this.p = p;
    mkdir(p.root);
    mkdir(p.private);
    this.db = new DatabaseSync(p.db);
    fs.chmodSync(p.db, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_by_run ON events(run_id,seq);
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, run_id TEXT);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, run_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, ordinal INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages(conversation_id,ordinal);
      CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(id UNINDEXED, text);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, path TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schedules(name TEXT PRIMARY KEY, data TEXT NOT NULL);`);
    if (!this.meta("machine")) this.setMeta("machine", id());
  }
  meta(key) {
    return this.db.prepare("SELECT value FROM meta WHERE key=?").get(key)
      ?.value;
  }
  setMeta(key, value) {
    this.db.prepare("INSERT OR REPLACE INTO meta VALUES(?,?)").run(key, value);
  }
  tx(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  queue(relative, value) {
    const operation = id();
    this.db
      .prepare("INSERT INTO outbox VALUES(?,?,?)")
      .run(operation, relative, JSON.stringify(value));
    return operation;
  }
  pending() {
    return this.db.prepare("SELECT * FROM outbox ORDER BY rowid").all();
  }
  acknowledge(ids) {
    this.tx(() => {
      for (const operation of ids) {
        const row = this.db.prepare("SELECT path,data FROM outbox WHERE id=?").get(operation);
        if (row?.path === "history.sqlite") {
          const snapshot = JSON.parse(row.data);
          this.setMeta("historyPublished", String(snapshot.revision));
        }
        this.db.prepare("DELETE FROM outbox WHERE id=?").run(operation);
      }
    });
  }
  event(runId, type, detail = {}) {
    const data = { at: now(), type, ...detail };
    const result = this.db
      .prepare("INSERT INTO events(run_id,data) VALUES(?,?)")
      .run(runId, JSON.stringify(data));
    const seq = Number(result.lastInsertRowid);
    this.historyEvent(runId, data, seq);
    return { ...data, seq };
  }
  historyChanged() {
    this.setMeta("historyRevision", String(Number(this.meta("historyRevision") || 0) + 1));
  }
  conversation() {
    const active = this.meta("activeConversation");
    return active ? this.db.prepare("SELECT * FROM conversations WHERE id=?").get(active) || null : null;
  }
  conversations() {
    return this.db.prepare(`SELECT c.*,
      (SELECT content FROM messages WHERE conversation_id=c.id AND role='user' ORDER BY ordinal LIMIT 1) AS title,
      (SELECT count(*) FROM messages WHERE conversation_id=c.id) AS message_count
      FROM conversations c ORDER BY updated_at DESC,id`).all()
      .map((row) => ({ ...row, title: (row.title || "New conversation").replace(/\s+/g, " ").slice(0, 100) }));
  }
  selectConversation(id) {
    if (!this.db.prepare("SELECT id FROM conversations WHERE id=?").get(id)) throw Error("Conversation not found");
    this.setMeta("activeConversation", id);
    this.historyChanged();
    return this.conversation();
  }
  conversationPage(conversationId, { before = Number.MAX_SAFE_INTEGER, limit = 20 } = {}) {
    if (!Number.isSafeInteger(before) || before < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw Error("Invalid history page");
    const messages = this.db.prepare("SELECT * FROM messages WHERE conversation_id=? AND ordinal<? ORDER BY ordinal DESC LIMIT ?")
      .all(conversationId, before, limit + 1);
    const more = messages.length > limit;
    if (more) messages.pop();
    messages.reverse();
    return { messages, before: more ? messages[0].ordinal : null };
  }
  newConversation() {
    const conversation = { id: id(), created_at: now(), updated_at: now(), run_id: null };
    this.tx(() => {
      this.db.prepare("INSERT INTO conversations VALUES(?,?,?,?)")
        .run(conversation.id, conversation.created_at, conversation.updated_at, null);
      this.setMeta("activeConversation", conversation.id);
      this.historyChanged();
    });
    return conversation;
  }
  linkConversation(conversationId, runId) {
    this.db.prepare("UPDATE conversations SET run_id=?,updated_at=? WHERE id=?").run(runId, now(), conversationId);
    this.historyChanged();
  }
  historyEvent(runId, event, seq) {
    const row = this.db.prepare("SELECT data FROM runs WHERE id=?").get(runId);
    const run = row && JSON.parse(row.data);
    if (!run?.conversationId) return;
    if (event.type === "running") {
      this.setMeta(`historyTurn:${runId}`, String(seq));
      this.setMeta(`historyStreamed:${runId}`, "0");
    }
    if (event.type === "steering_applied") this.setMeta(`historyTurn:${runId}`, String(seq));
    if (event.type === "text_delta") this.setMeta(`historyStreamed:${runId}`, "1");
    let role, content, messageId;
    if (["queued", "user_message", "response", "steering"].includes(event.type)) {
      role = "user";
      content = event.task ?? event.text ?? event.answer;
      messageId = `${runId}:user:${seq}`;
    } else if (event.type === "text_delta" || event.answer || event.question || event.error) {
      if (event.answer && !event.question && !event.error && this.meta(`historyStreamed:${runId}`) === "1") return;
      role = event.error ? "system" : "assistant";
      content = event.delta ?? event.question ?? event.answer ?? event.error;
      messageId = event.error ? `${runId}:error:${seq}`
        : event.question ? `${runId}:question:${seq}`
        : `${runId}:assistant:${this.meta(`historyTurn:${runId}`) || seq}`;
    }
    if (typeof content !== "string" || !content) return;
    const order = Number(this.meta("historyOrder") || 0) + 1;
    this.setMeta("historyOrder", String(order));
    if (event.type === "text_delta") {
      this.db.prepare(`INSERT INTO messages VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=content || excluded.content`)
        .run(messageId, run.conversationId, runId, role, content, event.at, order);
    } else {
      this.db.prepare("INSERT OR IGNORE INTO messages VALUES(?,?,?,?,?,?,?)")
        .run(messageId, run.conversationId, runId, role, content, event.at, order);
    }
    this.db.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(event.at, run.conversationId);
    this.historyChanged();
  }
  conversationMessages(conversationId, limit = 50) {
    return this.db.prepare("SELECT * FROM messages WHERE conversation_id=? ORDER BY ordinal DESC,created_at DESC LIMIT ?")
      .all(conversationId, Math.max(1, Math.min(500, limit))).reverse();
  }
  conversationInputHistory(conversationId) {
    if (!conversationId) return [];
    const messages = this.db.prepare("SELECT content FROM messages WHERE conversation_id=? AND role='user' ORDER BY ordinal DESC LIMIT 500")
      .all(conversationId);
    return [...new Set(messages.map((m) => m.content).filter((text) => text.trim() && !text.startsWith("/")))];
  }
  conversationContext(conversationId, budget = 48000) {
    if (!conversationId) return [];
    const messages = this.conversationMessages(conversationId, 100);
    const selected = [];
    for (const message of messages.reverse()) {
      if (budget <= 0) break;
      const content = message.content.slice(-Math.min(budget, 16000));
      selected.unshift({ role: message.role, content, at: message.created_at });
      budget -= content.length;
    }
    return selected;
  }
  conversationSearch(conversationId, query) {
    if (typeof query !== "string" || !query.trim()) throw Error("History search needs a query");
    const escaped = query.trim().replace(/[\\%_]/g, "\\$&");
    return this.db.prepare("SELECT role,content,created_at FROM messages WHERE conversation_id=? AND content LIKE ? ESCAPE '\\' ORDER BY ordinal DESC LIMIT 10")
      .all(conversationId, `%${escaped}%`).map((m) => {
        const start = Math.max(0, m.content.toLowerCase().indexOf(query.trim().toLowerCase()) - 2000);
        return { ...m, content: m.content.slice(start, start + 8000) };
      });
  }
  events(runId, after = 0) {
    return this.db
      .prepare(
        "SELECT seq,data FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT 1000",
      )
      .all(runId, after)
      .map((r) => ({ ...JSON.parse(r.data), seq: r.seq }));
  }
  eventCursor(runId) {
    return this.db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE run_id=?").get(runId).seq;
  }
  run(runId) {
    const row = this.db.prepare("SELECT data FROM runs WHERE id=?").get(runId);
    if (!row) throw Error("Run not found");
    return JSON.parse(row.data);
  }
  runs() {
    return this.db
      .prepare("SELECT data FROM runs ORDER BY rowid DESC")
      .all()
      .map((r) => JSON.parse(r.data));
  }
  saveRun(run) {
    run.updatedAt = now();
    this.db
      .prepare("INSERT OR REPLACE INTO runs VALUES(?,?,?)")
      .run(run.id, run.state, JSON.stringify(run));
    return run;
  }
  createRun(task, options = {}) {
    if (typeof task !== "string" || !task.trim() || task.length > 64000)
      throw Error("Instruction must be nonempty and at most 64000 characters");
    const run = {
      format: "browse.run/v1",
      id: id(),
      machine: this.meta("machine"),
      createdAt: now(),
      state: "queued",
      task,
      model: options.model,
      step: 0,
      steps: options.steps || [{ type: "browser", task }],
      workflowRevision: options.workflowRevision,
      skillRevisions: [],
      inputs: [],
      attachments: options.attachments || [],
      conversationId: options.conversationId,
      checkpointSeq: 0,
    };
    this.tx(() => {
      this.saveRun(run);
      if (run.conversationId) this.linkConversation(run.conversationId, run.id);
      this.event(run.id, "queued", { task });
      this.queue(`runs/${run.id}.json`, run);
    });
    return run;
  }
  actionStart(runId, tool, input, effectful = true) {
    const action = {
      id: id(),
      runId,
      tool,
      input,
      effectful,
      startedAt: now(),
      state: "dispatched",
    };
    this.db
      .prepare("INSERT INTO actions VALUES(?,?,?,?)")
      .run(action.id, runId, action.state, JSON.stringify(action));
    return action;
  }
  actionEnd(action, result, state = "completed") {
    Object.assign(action, { result, state, endedAt: now() });
    this.db
      .prepare("UPDATE actions SET state=?,data=? WHERE id=?")
      .run(state, JSON.stringify(action), action.id);
  }
  actions(runId) {
    return this.db
      .prepare("SELECT data FROM actions WHERE run_id=? ORDER BY rowid")
      .all(runId)
      .map((r) => JSON.parse(r.data));
  }
  portableRun(runId) {
    const run = this.run(runId);
    const { attachments, ...portable } = run;
    this.queue(`runs/${run.id}.json`, {
      ...portable,
      actions: this.actions(runId),
      events: this.db
        .prepare(
          "SELECT data FROM events WHERE run_id=? AND json_extract(data,'$.type') != 'text_delta' ORDER BY seq",
        )
        .all(runId)
        .map((r) => JSON.parse(r.data)),
    });
  }
  record(kind, body, { logicalId, links = [], source = "user" } = {}) {
    const timestamp = Math.max(
      Date.now(),
      Number(this.meta("lastRecordTime") || 0) + 1,
    );
    const record = {
      format: "browse.record/v1",
      id: id(),
      kind,
      logicalId: logicalId || body.name || id(),
      createdAt: new Date(timestamp).toISOString(),
      source,
      links,
      body,
    };
    if (!/^[\w-]{1,80}$/.test(record.logicalId))
      throw Error("Invalid record name");
    this.tx(() => {
      this.index(record);
      this.queue(`context/records/${record.id}.json`, record);
      this.setMeta("lastRecordTime", String(timestamp));
      if (["skill", "workflow", "memory"].includes(kind))
        this.queue(
          `${kind === "memory" ? "memory" : kind + "s"}/${record.logicalId}.json`,
          record,
        );
    });
    return record;
  }
  index(record) {
    if (
      record?.format !== "browse.record/v1" ||
      typeof record.id !== "string" ||
      ![
        "skill",
        "workflow",
        "memory",
        "feedback",
        "artifact",
        "outcome",
      ].includes(record.kind)
    )
      throw Error("Invalid portable record");
    this.db
      .prepare("INSERT OR REPLACE INTO records VALUES(?,?,?)")
      .run(record.id, record.kind, JSON.stringify(record));
    this.db.prepare("DELETE FROM search WHERE id=?").run(record.id);
    this.db
      .prepare("INSERT INTO search(id,text) VALUES(?,?)")
      .run(record.id, JSON.stringify(record.body));
  }
  records(kind) {
    return this.db
      .prepare(
        "SELECT data FROM records WHERE kind=? ORDER BY json_extract(data,'$.createdAt') DESC, rowid DESC",
      )
      .all(kind)
      .map((r) => JSON.parse(r.data));
  }
  getRecord(recordId) {
    const r = this.db
      .prepare("SELECT data FROM records WHERE id=?")
      .get(recordId);
    if (!r) throw Error("Record not found");
    return JSON.parse(r.data);
  }
  latest(kind, logicalId) {
    const row = this.records(kind).find((r) => r.logicalId === logicalId);
    if (!row) throw Error(`${kind} not found: ${logicalId}`);
    return row;
  }
  search(query, limit = 12) {
    const tokens =
      String(query)
        .match(/[\p{L}\p{N}_-]+/gu)
        ?.slice(0, 25) || [];
    if (!tokens.length) return [];
    const match = tokens.map((t) => '"' + t + '"').join(" OR ");
    return this.db
      .prepare(
        "SELECT records.data FROM search JOIN records ON records.id=search.id WHERE search MATCH ? ORDER BY bm25(search) LIMIT ?",
      )
      .all(match, limit)
      .map((r) => JSON.parse(r.data));
  }
  context(task) {
    const found = this.search(task, 30).filter((r) =>
      ["skill", "memory", "outcome"].includes(r.kind),
    );
    const latest = new Map();
    for (const r of found) {
      const key = r.kind + ":" + r.logicalId;
      const old = latest.get(key);
      if (!old || r.createdAt > old.createdAt) latest.set(key, r);
    }
    const score = (r) =>
      this.records("feedback")
        .filter((f) =>
          f.links.some((l) => l.to === r.id && l.relation === "used_skill"),
        )
        .reduce(
          (n, f) =>
            n +
            (f.body.rating === "positive"
              ? 1
              : f.body.rating === "negative"
                ? -1
                : 0),
          0,
        );
    return [...latest.values()]
      .map((r) => this.latest(r.kind, r.logicalId))
      .sort((a, b) => score(b) - score(a))
      .slice(0, 10);
  }
  feedback(runId, rating, comment) {
    if (!["positive", "negative", "neutral"].includes(rating))
      throw Error("Rating must be positive, negative, or neutral");
    const run = this.run(runId),
      artifacts = this.records("artifact").filter(
        (a) => a.body.runId === runId,
      );
    return this.record(
      "feedback",
      { runId, rating, comment: String(comment || ""), explicit: true },
      {
        links: [
          { relation: "feedback_for", to: runId },
          ...run.skillRevisions.map((to) => ({ relation: "used_skill", to })),
          ...artifacts.map((a) => ({
            relation: "produced_artifact",
            to: a.id,
          })),
        ],
      },
    );
  }
  schedule(value) {
    this.db
      .prepare("INSERT OR REPLACE INTO schedules VALUES(?,?)")
      .run(value.name, JSON.stringify(value));
    this.queue(`context/schedules/${value.name}.json`, {
      ...value,
      enabled: false,
    });
    return value;
  }
  schedules() {
    return this.db
      .prepare("SELECT data FROM schedules")
      .all()
      .map((r) => JSON.parse(r.data));
  }
  rebuild(checkout) {
    const directory = path.join(checkout, "context/records");
    this.tx(() => {
      this.db.exec("DELETE FROM records; DELETE FROM search;");
      if (fs.existsSync(directory))
        for (const file of fs.readdirSync(directory).sort()) {
          if (file.endsWith(".json"))
            this.index(
              JSON.parse(fs.readFileSync(path.join(directory, file), "utf8")),
            );
        }
    });
  }
  importedHistory(checkout) {
    const directory = path.join(checkout, "runs");
    if (!fs.existsSync(directory)) return;
    for (const file of fs.readdirSync(directory)) {
      if (!file.endsWith(".json")) continue;
      const run = JSON.parse(
        fs.readFileSync(path.join(directory, file), "utf8"),
      );
      if (run.format !== "browse.run/v1") throw Error("Invalid run record");
      if (!this.db.prepare("SELECT id FROM runs WHERE id=?").get(run.id))
        this.saveRun({
          ...run,
          state: "completed",
          historical: true,
          originalState: run.state,
          attachments: [],
        });
    }
    const schedules = path.join(checkout, "context/schedules");
    if (fs.existsSync(schedules))
      for (const file of fs.readdirSync(schedules)) {
        if (file.endsWith(".json")) {
          const s = JSON.parse(
            fs.readFileSync(path.join(schedules, file), "utf8"),
          );
          if (!this.schedules().some((x) => x.name === s.name))
            this.db
              .prepare("INSERT INTO schedules VALUES(?,?)")
              .run(s.name, JSON.stringify({ ...s, enabled: false }));
        }
      }
    importHistory(this, checkout);
  }
  saveWorkflow(value) {
    return this.record("workflow", workflow(value), { logicalId: value.name });
  }
  close() {
    this.db.close();
  }
}
