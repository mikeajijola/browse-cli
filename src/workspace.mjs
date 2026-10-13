import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { id, now, mkdir, atomic, inside, hash, json } from "./util.mjs";
import { prepareHistory } from "./history.mjs";

export class Workspace {
  constructor(p, store) {
    this.p = p;
    this.store = store;
  }
  fossil(args, { cwd = this.p.checkout } = {}) {
    const r = spawnSync("fossil", args, {
      cwd,
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.error) throw r.error;
    if (r.status !== 0) throw Error(`Fossil: ${(r.stderr || r.stdout).trim()}`);
    return r.stdout;
  }
  init() {
    mkdir(this.p.root);
    mkdir(this.p.checkout);
    if (!fs.existsSync(this.p.repo))
      this.fossil(["init", this.p.repo, "--admin-user", "browse"], {
        cwd: this.p.root,
      });
    fs.chmodSync(this.p.repo, 0o600);
    if (
      !fs.existsSync(path.join(this.p.checkout, ".fslckout")) &&
      !fs.existsSync(path.join(this.p.checkout, "_FOSSIL_"))
    )
      this.fossil(["open", this.p.repo]);
    this.fossil(["settings", "autosync", "off"]);
    const file = path.join(this.p.checkout, "workspace.json");
    if (!fs.existsSync(file)) {
      atomic(
        file,
        JSON.stringify(
          { format: "browse.workspace/v1", id: id(), createdAt: now() },
          null,
          2,
        ),
      );
      this.fossil(["add", "workspace.json"]);
      this.fossil([
        "commit",
        "--no-prompt",
        "--user",
        "browse",
        "-m",
        "Initialize Browse workspace",
      ]);
    }
    const meta = json(file);
    if (meta.format !== "browse.workspace/v1")
      throw Error("Unsupported workspace format");
    this.store.setMeta("workspace", meta.id);
    for (const dir of [
      "skills",
      "workflows",
      "memory",
      "context/records",
      "context/schedules",
      "runs",
      "artifacts",
    ])
      mkdir(path.join(this.p.checkout, dir));
  }
  flush() {
    let pending = this.store.pending();
    if (!pending.length) {
      prepareHistory(this.store);
      pending = this.store.pending();
      if (!pending.length) return { committed: 0 };
    }
    // A prior commit may have succeeded immediately before an acknowledgement crash.
    const timeline = this.fossil([
      "timeline",
      "-n",
      "0",
      "-t",
      "ci",
      "--format",
      "%c",
      "-W",
      "0",
    ]);
    const acknowledged = pending
      .filter((row) => timeline.includes(row.id))
      .map((row) => row.id);
    if (acknowledged.length) {
      this.store.acknowledge(acknowledged);
      for (const row of pending)
        if (acknowledged.includes(row.id) && row.path === "history.sqlite")
          fs.rmSync(JSON.parse(row.data).file, { force: true });
      pending = pending.filter((row) => !acknowledged.includes(row.id));
    }
    prepareHistory(this.store);
    pending = this.store.pending();
    if (!pending.length) return { committed: acknowledged.length };
    const ids = pending.map((r) => r.id),
      marker = `browse-outbox:${ids.join(",")}`;
    if (!timeline.includes(marker)) {
      for (const row of pending) {
        if (row.path === "history.sqlite") {
          const snapshot = JSON.parse(row.data);
          if (snapshot.format !== "browse.history-snapshot/v1" ||
              path.dirname(snapshot.file) !== path.join(this.p.private, "history-snapshots"))
            throw Error("Invalid conversation snapshot publication");
          const bytes = fs.readFileSync(snapshot.file);
          if (hash(bytes) !== snapshot.hash) throw Error("Altered conversation snapshot");
          atomic(inside(this.p.checkout, row.path), bytes);
        } else atomic(inside(this.p.checkout, row.path), row.data + "\n");
      }
      const changed = [...new Set(pending.map((r) => r.path))];
      this.fossil(["add", ...changed]);
      if (this.fossil(["changes", "--hash"]).trim())
        this.fossil([
          "commit",
          "--hash",
          "--no-prompt",
          "--no-warnings",
          "--nosign",
          "--nosync",
          "--user",
          "browse",
          "-m",
          marker,
        ]);
    }
    this.store.acknowledge(ids);
    for (const row of pending)
      if (row.path === "history.sqlite") fs.rmSync(JSON.parse(row.data).file, { force: true });
    if (Number(this.store.meta("historyRevision") || 0) > Number(this.store.meta("historyPublished") || 0))
      return { committed: pending.length + this.flush().committed };
    return { committed: pending.length };
  }
  verify() {
    if (this.fossil(["changes", "--hash"]).trim())
      throw Error(
        "Checkout has uncommitted changes; export requires a clean checkout",
      );
    const records = [
      "skill",
      "workflow",
      "memory",
      "feedback",
      "artifact",
      "outcome",
    ].flatMap((kind) => this.store.records(kind));
    const known = new Set(records.map((r) => r.id));
    for (const file of fs.readdirSync(path.join(this.p.checkout, "runs"))) {
      if (!file.endsWith(".json")) continue;
      const run = json(path.join(this.p.checkout, "runs", file));
      known.add(run.id);
      for (const action of run.actions || []) known.add(action.id);
      for (const revision of [
        ...(run.skillRevisions || []),
        ...(run.workflowRevision ? [run.workflowRevision] : []),
      ])
        if (!known.has(revision))
          throw Error(`Missing skill/workflow revision: ${revision}`);
    }
    for (const r of this.store.records("artifact")) {
      const file = inside(this.p.checkout, r.body.path);
      if (!fs.existsSync(file) || hash(fs.readFileSync(file)) !== r.body.hash)
        throw Error(`Missing or altered artifact: ${r.body.path}`);
    }
    for (const record of records)
      for (const link of record.links || [])
        if (!known.has(link.to))
          throw Error(`Broken context reference: ${record.id} -> ${link.to}`);
    return { verified: true, workspace: this.store.meta("workspace") };
  }
  artifact(
    runId,
    filename,
    bytes,
    { source = "", actionId, mediaType = "application/octet-stream" } = {},
  ) {
    const basename = path.basename(filename || "artifact");
    if (basename !== filename || basename.startsWith("."))
      throw Error("Artifact filename must be a visible basename");
    const artifactId = id(),
      relative = `artifacts/${runId}/${artifactId}/${basename}`;
    const file = inside(this.p.checkout, relative);
    atomic(file, bytes);
    if (mediaType === "application/octet-stream")
      mediaType =
        {
          ".pdf": "application/pdf",
          ".md": "text/markdown",
          ".html": "text/html",
          ".json": "application/json",
          ".csv": "text/csv",
          ".txt": "text/plain",
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".webp": "image/webp",
          ".zip": "application/zip",
        }[path.extname(basename).toLowerCase()] || mediaType;
    const body = {
      runId,
      path: relative,
      filename: basename,
      hash: hash(bytes),
      bytes: bytes.length,
      source,
      actionId,
      mediaType,
    };
    this.fossil(["add", relative]);
    const record = this.store.record("artifact", body, {
      links: [
        { relation: "produced_by", to: runId },
        ...(actionId ? [{ relation: "observed_in", to: actionId }] : []),
      ],
    });
    const artifacts = this.store
      .records("artifact")
      .filter((a) => a.body.runId === runId)
      .map((a) => ({ id: a.id, ...a.body }));
    this.store.queue(`artifacts/${runId}/manifest.json`, {
      format: "browse.artifacts/v1",
      runId,
      artifacts,
    });
    return record;
  }
  extract(relative, revision) {
    inside(this.p.checkout, relative);
    if (!revision) return inside(this.p.checkout, relative);
    if (!/^[a-zA-Z0-9_-]+$/.test(revision))
      throw Error("Invalid Fossil revision");
    const dest = path.join(
      this.p.private,
      "staging",
      id(),
      path.basename(relative),
    );
    mkdir(path.dirname(dest));
    this.fossil(["cat", relative, "-r", revision, "-o", dest]);
    return dest;
  }
  export(destination) {
    destination = path.resolve(destination);
    if (fs.existsSync(destination))
      throw Error("Export destination already exists");
    this.flush();
    this.verify();
    mkdir(path.dirname(destination));
    this.fossil(["backup", "-R", this.p.repo, destination]);
    this.fossil(["remote", "scrub", "-R", destination], { cwd: this.p.root });
    this.fossil(["remote", "off", "-R", destination], { cwd: this.p.root });
    fs.chmodSync(destination, 0o600);
    return { file: destination, workspace: this.store.meta("workspace") };
  }
  sync(remote) {
    this.flush();
    this.verify();
    if (remote) {
      const url = new URL(remote);
      if (!["https:", "ssh:"].includes(url.protocol) || url.password)
        throw Error("Use an HTTPS/SSH remote without an embedded password");
      this.fossil(["remote", remote]);
    }
    const configured = this.fossil(["remote"]).trim();
    if (!configured || configured === "off")
      throw Error("Configure a remote with browse sync --remote URL");
    this.fossil(["sync"]);
    const output = this.fossil(["update"]);
    if (/CONFLICT|cannot merge/i.test(output))
      throw Error(
        "Fossil merge conflict: resolve the checkout before continuing",
      );
    this.store.rebuild(this.p.checkout);
    this.store.importedHistory(this.p.checkout);
    return { synced: true };
  }
}
