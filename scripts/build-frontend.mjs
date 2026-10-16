import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "native/fx/upstream.json")));
const source = process.env.BROWSE_FX_CACHE_DIR || path.join(root, "native/.cache/fx");
const run = (command, args, cwd = source) => execFileSync(command, args, { cwd, stdio: "inherit" });
const read = (command, args) => execFileSync(command, args, { cwd: source, encoding: "utf8" }).trim();
fs.mkdirSync(path.dirname(source), { recursive: true });
if (!fs.existsSync(path.join(source, ".git"))) {
  run("git", ["init", source], root);
  run("git", ["remote", "add", "origin", manifest.repository]);
  run("git", ["fetch", "--depth=1", "origin", manifest.commit]);
  run("git", ["checkout", "--detach", "FETCH_HEAD"]);
}
if (read("git", ["rev-parse", "HEAD"]) !== manifest.commit) throw Error("Frontend source revision does not match upstream.json");
const patch = path.join(root, "native/fx/upstream.patch");
try { execFileSync("git", ["apply", "--reverse", "--check", patch], { cwd: source, stdio: "ignore" }); }
catch { run("git", ["apply", "--check", patch]); run("git", ["apply", patch]); }
const actualPatch = read("git", ["diff", "--no-ext-diff", "--no-color"]);
if (actualPatch !== fs.readFileSync(patch, "utf8").trim()) throw Error("Cached fx source has changes outside the pinned Browse patch");
fs.copyFileSync(path.join(root, "native/fx/browse_bridge.zig"), path.join(source, "src/core/app/browse_bridge.zig"));
fs.copyFileSync(path.join(root, "native/fx/browse_tokens.zig"), path.join(source, "src/core/auth/browse_tokens.zig"));
const zig = process.env.ZIG || "zig";
const version = execFileSync(zig, ["version"], { encoding: "utf8" }).trim();
if (!version.startsWith(manifest.zig)) throw Error(`Expected Zig ${manifest.zig}; got ${version}`);
run(zig, ["fmt", "--check", "src/core/app/browse_bridge.zig", "src/core/auth/browse_tokens.zig"]);
const debug = process.argv.includes("--debug");
run(zig, ["build", `-Doptimize=${debug ? "Debug" : "ReleaseFast"}`, ...(debug ? ["-Dllvm=false", "-Dstrip=true"] : []), "-j2"]);
const destination = path.join(root, "native/bin", `${process.platform}-${process.arch}`);
fs.mkdirSync(destination, { recursive: true });
fs.copyFileSync(path.join(source, "zig-out/bin/fx"), path.join(destination, "browse-fx"));
fs.chmodSync(path.join(destination, "browse-fx"), 0o755);
console.log(`Built fx ${manifest.version} (${manifest.commit.slice(0, 12)}) frontend for Browse.`);
