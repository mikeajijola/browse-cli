import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const maintenance = new Set(["runs", "respond", "worker", "workflow", "schedule", "artifacts", "feedback", "memory", "skills", "context", "export", "import", "sync"]);
export function frontendRoute(argv) {
  // The explicit namespace also disambiguates old flags such as --resume RUN_ID.
  if (argv[0] === "durable") return { native: false, args: argv.slice(1) };
  const args = [...argv];
  const homeIndex = args.indexOf("--home");
  let home;
  if (homeIndex !== -1) {
    home = args[homeIndex + 1];
    if (!home || home.startsWith("--")) throw Error("--home requires a directory");
    args.splice(homeIndex, 2);
  }
  const valueFlags = new Set(["--model", "--provider", "--effort", "--context-limit", "--add-dir", "--resume", "--resume-id", "--image", "--system", "--file", "--attach"]);
  let command;
  for (let index = 0; index < args.length; index++) {
    if (valueFlags.has(args[index])) { index++; continue; }
    if (args[index].startsWith("-")) continue;
    command = args[index]; break;
  }
  const legacy = maintenance.has(command) ||
    (command === "setup" && args.includes("--provider")) ||
    args.includes("--detach") || args.includes("--attach") ||
    (["setup", "login"].includes(command) && args.some((arg) => ["--new-account", "--account", "--list"].includes(arg)));
  if (legacy) return { native: false, args: argv };
  return { native: true, args, ...(home ? { home: path.resolve(home) } : {}) };
}

export async function runFrontend(argv, { home, binary = fileURLToPath(new URL(`../native/bin/${process.platform}-${process.arch}/browse-fx`, import.meta.url)), launch = spawn } = {}) {
  if (!fs.existsSync(binary)) throw Error("The Browse frontend has not been built. Run npm run build:frontend (requires Zig 0.17), then reopen browse.");
  const setup = argv.length === 1 && argv[0] === "setup";
  const child = launch(binary, setup ? [] : argv, {
    stdio: "inherit",
    env: { ...process.env, ...(home ? { BROWSE_HOME: home } : {}),
      BROWSE_NODE: process.execPath,
      BROWSE_FRONTEND_BRIDGE: fileURLToPath(new URL("./fx-bridge.mjs", import.meta.url)),
      BROWSE_TOKEN_HELPER: fileURLToPath(new URL("./frontend-tokens.mjs", import.meta.url)),
      ...(setup ? { BROWSE_OPEN_SETUP: "1" } : {}),
      FX_AUTO_UPGRADE: "0",
    },
  });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const handlers = new Map(signals.map((signal) => [signal, () => { if (!child.killed) child.kill(signal); }]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
        resolve();
      });
    });
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}
