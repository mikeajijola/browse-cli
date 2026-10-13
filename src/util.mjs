import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";

export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function paths(
  root = process.env.BROWSE_HOME ||
    path.join(
      process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share"),
      "browse",
    ),
) {
  root = path.resolve(root);
  return {
    root,
    repo: path.join(root, "workspace.fossil"),
    checkout: path.join(root, "checkout"),
    db: path.join(root, "runtime.sqlite"),
    private: path.join(root, "private"),
    socket: path.join(root, "worker.sock"),
    lock: path.join(root, "worker.lock"),
    auth: path.join(
      process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
      "browse",
      "auth.json",
    ),
  };
}
export function mkdir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}
export function atomic(file, data) {
  mkdir(path.dirname(file));
  const tmp = `${file}.${id()}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
export function json(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}
export function inside(root, relative) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative))
    throw Error("Expected a relative workspace path");
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(path.resolve(root) + path.sep))
    throw Error("Path escapes workspace");
  let current = resolved;
  while (!fs.existsSync(current)) current = path.dirname(current);
  const real = fs.realpathSync(current),
    realRoot = fs.realpathSync(root);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep))
    throw Error("Symlink escapes workspace");
  return resolved;
}
export function duration(value) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/.exec(String(value));
  if (!match) throw Error("Use a positive duration such as 30s, 2h, or 30d");
  const n =
    Number(match[1]) *
    { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[
      match[2]
    ];
  if (!Number.isSafeInteger(n) || n <= 0) throw Error("Invalid duration");
  return n;
}
export function name(value) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value || ""))
    throw Error("Name must contain letters, numbers, underscores or hyphens");
  return value;
}
export function workflow(value) {
  if (
    value?.format !== "browse.workflow/v1" ||
    !Array.isArray(value.steps) ||
    !value.steps.length ||
    value.steps.length > 100
  )
    throw Error("Invalid browse.workflow/v1 definition");
  name(value.name);
  const steps = value.steps.map((s, i) => {
    if (s.type === "browser" && typeof s.task === "string" && s.task.trim())
      return { type: "browser", task: s.task.slice(0, 64000) };
    if (s.type === "wait")
      return {
        type: "wait",
        duration: String(s.duration),
        milliseconds: duration(s.duration),
      };
    if (
      s.type === "input" &&
      typeof s.question === "string" &&
      s.question.trim()
    )
      return { type: "input", question: s.question.slice(0, 8000) };
    throw Error(`Invalid workflow step ${i + 1}`);
  });
  return {
    format: "browse.workflow/v1",
    name: value.name,
    description: String(value.description || "").slice(0, 64000),
    steps,
  };
}
export const TERMINAL = new Set(["completed", "failed", "cancelled"]);
