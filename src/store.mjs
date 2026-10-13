import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { id, now, mkdir, workflow } from "./util.mjs";

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
      for (const operation of ids)
        this.db.prepare("DELETE FROM outbox WHERE id=?").run(operation);
    });
  }
  event(runId, type, detail = {}) {
    const data = { at: now(), type, ...detail };
    const result = this.db
      .prepare("INSERT INTO events(run_id,data) VALUES(?,?)")
      .run(runId, JSON.stringify(data));
    return { ...data, seq: Number(result.lastInsertRowid) };
  }
  events(runId, after = 0) {
    return this.db
      .prepare(
        "SELECT seq,data FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT 1000",
      )
      .all(runId, after)
      .map((r) => ({ ...JSON.parse(r.data), seq: r.seq }));
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
      checkpointSeq: 0,
    };
    this.tx(() => {
      this.saveRun(run);
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
  }
  saveWorkflow(value) {
    return this.record("workflow", workflow(value), { logicalId: value.name });
  }
  close() {
    this.db.close();
  }
}
