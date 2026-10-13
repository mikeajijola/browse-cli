import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { paths } from "../src/util.mjs";
import { request } from "../src/worker.mjs";
const exec = promisify(execFile),
  bin = new URL("../bin/browse.mjs", import.meta.url).pathname;

test("installed CLI worker, portable memory, export/import and historical schedules", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browse-cli-")),
    home = path.join(root, "home"),
    other = path.join(root, "other");
  const cli = async (args = [], target = home) => {
    const { stdout } = await exec(
      process.execPath,
      [bin, "--home", target, "--json", ...args],
      { timeout: 20000 },
    );
    return JSON.parse(stdout);
  };
  t.after(async () => {
    for (const target of [home, other]) {
      try {
        await request(paths(target), "stop", {}, 1000);
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 500));
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.equal((await cli(["worker", "status"])).running, false);
  const memory = await cli([
    "memory",
    "add",
    "invoice-preference",
    "Use PDF invoices",
  ]);
  assert.equal(memory.kind, "memory");
  assert.equal((await cli(["memory", "search", "invoices"])).length, 1);
  const instruction = path.join(root, "skill.md");
  fs.writeFileSync(instruction, "Download PDF invoices.");
  const skill = await cli(["skills", "save", "invoice", "--file", instruction]);
  assert.equal(skill.logicalId, "invoice");
  const definition = path.join(root, "workflow.json");
  fs.writeFileSync(
    definition,
    JSON.stringify({
      format: "browse.workflow/v1",
      name: "invoice",
      steps: [{ type: "wait", duration: "1h" }],
    }),
  );
  await cli(["workflow", "create", "invoice", "--file", definition]);
  await cli([
    "schedule",
    "create",
    "monthly",
    "--workflow",
    "invoice",
    "--every",
    "30d",
  ]);
  const run = await cli(["workflow", "run", "invoice", "--detach"]);
  assert.ok(run.id);
  const exported = path.join(root, "export.fossil");
  assert.equal((await cli(["export", exported])).file, exported);
  const imported = await cli(["import", exported], other);
  assert.equal(imported.imported, true);
  assert.equal((await cli(["memory", "search", "invoices"], other)).length, 2);
  assert.equal((await cli(["schedule", "list"], other))[0].enabled, false);
  const old = (await cli(["runs", "list"], other))[0];
  assert.equal(old.historical, true);
  await assert.rejects(
    cli(["runs", "resume", old.id], other),
    /Imported history/,
  );
  assert.equal((await cli(["worker", "status"])).running, true);
});
