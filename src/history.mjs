import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { id, mkdir, hash } from "./util.mjs";

// Build a closed, self-contained SQLite file containing only portable conversation data.
export function prepareHistory(store) {
  const revision = Number(store.meta("historyRevision") || 0);
  if (revision <= Number(store.meta("historyPublished") || 0) ||
      store.pending().some((row) => row.path === "history.sqlite")) return;
  const directory = path.join(store.p.private, "history-snapshots");
  mkdir(directory);
  const file = path.join(directory, `${id()}.sqlite`);
  const db = new DatabaseSync(file);
  fs.chmodSync(file, 0o600);
  try {
    db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE conversations(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,run_id TEXT);
      CREATE TABLE messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,run_id TEXT NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL,ordinal INTEGER NOT NULL);
      CREATE INDEX messages_by_conversation ON messages(conversation_id,ordinal);
      BEGIN IMMEDIATE;`);
    const meta = db.prepare("INSERT INTO metadata VALUES(?,?)");
    meta.run("format", "browse.history/v1");
    meta.run("activeConversation", store.meta("activeConversation") || "");
    const conversation = db.prepare("INSERT INTO conversations VALUES(?,?,?,?)");
    for (const c of store.db.prepare("SELECT * FROM conversations ORDER BY created_at,id").all())
      conversation.run(c.id, c.created_at, c.updated_at, c.run_id);
    const message = db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)");
    for (const m of store.db.prepare("SELECT * FROM messages ORDER BY ordinal,id").all())
      message.run(m.id, m.conversation_id, m.run_id, m.role, m.content, m.created_at, m.ordinal);
    db.exec("COMMIT");
  } catch (e) {
    db.close();
    fs.rmSync(file, { force: true });
    throw e;
  }
  db.close();
  store.queue("history.sqlite", { format: "browse.history-snapshot/v1", file, revision, hash: hash(fs.readFileSync(file)) });
}

export function importHistory(store, checkout) {
  const file = path.join(checkout, "history.sqlite");
  if (!fs.existsSync(file)) return;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    for (const name of ["metadata", "conversations", "messages"])
      if (db.prepare("SELECT type FROM sqlite_schema WHERE name=?").get(name)?.type !== "table")
        throw Error("Invalid conversation history database");
    if (db.prepare("SELECT value FROM metadata WHERE key='format'").get()?.value !== "browse.history/v1")
      throw Error("Unsupported conversation history format");
    if (db.prepare("PRAGMA quick_check").get().quick_check !== "ok")
      throw Error("Conversation history database failed integrity verification");
    const conversations = db.prepare("SELECT * FROM conversations").all();
    const messages = db.prepare("SELECT * FROM messages ORDER BY ordinal").all();
    const ids = new Set(conversations.map((c) => c.id));
    for (const m of messages)
      if (!ids.has(m.conversation_id) || !["user", "assistant", "system"].includes(m.role) ||
          typeof m.content !== "string" || !Number.isSafeInteger(m.ordinal))
        throw Error("Invalid conversation history message");
    const active = db.prepare("SELECT value FROM metadata WHERE key='activeConversation'").get()?.value;
    store.tx(() => {
      const conversation = store.db.prepare("INSERT OR IGNORE INTO conversations VALUES(?,?,?,?)");
      for (const c of conversations) conversation.run(c.id, c.created_at, c.updated_at, c.run_id);
      const message = store.db.prepare(`INSERT INTO messages VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET content=excluded.content
        WHERE length(excluded.content)>length(messages.content)
          AND substr(excluded.content,1,length(messages.content))=messages.content`);
      let changed = false, order = Number(store.meta("historyOrder") || 0);
      for (const m of messages) {
        const result = message.run(m.id, m.conversation_id, m.run_id, m.role, m.content, m.created_at, m.ordinal);
        changed = Boolean(result.changes) || changed;
        order = Math.max(order, m.ordinal);
      }
      store.setMeta("historyOrder", String(order));
      if (!store.meta("activeConversation") && ids.has(active)) {
        store.setMeta("activeConversation", active);
        changed = true;
      }
      if (changed) store.historyChanged();
    });
  } finally { db.close(); }
}
