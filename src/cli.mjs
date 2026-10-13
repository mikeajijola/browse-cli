import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { parseArgs } from "node:util";
import { paths, mkdir, atomic, workflow, TERMINAL } from "./util.mjs";
import { setup, auth, providerModels } from "./provider.mjs";
import { loginChatGPT, chatGPTModels, chatGPTAccounts } from "./chatgpt.mjs";
import { ensureWorker, request, serve } from "./worker.mjs";
import { Store } from "./store.mjs";
import { Workspace } from "./workspace.mjs";

const HELP = `browse — durable browser execution with libfx, Neo, and Fossil

  browse                                  Interactive browser chat
  browse "instruction" [--detach]          Execute a durable run
  browse --resume RUN_ID                   Attach to or resume a run
  browse login                            Sign in with ChatGPT in your browser
  browse login --new-account               Add another ChatGPT account
  browse login --list                      List saved ChatGPT accounts
  browse login --account ID                Reconnect a saved ChatGPT account
  browse setup --provider NAME --model ID  Configure direct provider access
  browse runs list|show|logs|pause|resume|cancel [RUN_ID]
  browse respond RUN_ID "answer"
  browse worker start|stop|status
  browse workflow create NAME "description" [--file definition.json]
  browse workflow show|run NAME
  browse schedule create NAME --workflow NAME (--at UTC | --every 30d)
  browse schedule list|enable|disable|delete [NAME]
  browse artifacts list|show|export [ARTIFACT_ID] [DESTINATION]
  browse feedback RUN_ID --rating positive|negative|neutral [--comment TEXT]
  browse memory search QUERY | add NAME CONTENT | reindex
  browse skills list|show NAME | save NAME --file FILE | restore REVISION_ID
  browse context links RECORD_OR_RUN_ID
  browse export FILE.fossil
  browse import FILE.fossil --home NEW_DIRECTORY
  browse sync [--remote HTTPS_OR_SSH_URL]

Options: --home PATH, --model provider/model, --attach FILE (repeatable),
         --quiet, --verbose, --json, --detach, --help

Requires Node 24+, Fossil, and BrowserOS Neo (BROWSE_NEO_URL overrides its URL).
Credentials and live execution state never enter the portable Fossil repository.
`;

export async function monitor(p, runId, options = {}, signal) {
  let cursor = 0,
    seenQuestion;
  while (!signal?.aborted) {
    const events = await request(p, "events", { id: runId, after: cursor });
    for (const event of events) {
      cursor = event.seq;
      if (options.json) console.log(JSON.stringify({ runId, ...event }));
      else if (event.type === "text_delta") process.stdout.write(event.delta);
      else if (
        !options.quiet &&
        ["tool_start", "waiting", "recovery", "tool_error"].includes(event.type)
      )
        process.stderr.write(
          `\n• ${event.name || event.type}${event.error ? ": " + event.error : ""}\n`,
        );
      else if (options.verbose && !options.quiet)
        process.stderr.write(`\n[${event.type}]\n`);
    }
    const run = await request(p, "run", { id: runId });
    if (events.length === 1000) continue;
    if (
      TERMINAL.has(run.state) ||
      run.state === "paused" ||
      (run.state === "waiting" && run.question)
    ) {
      if (!options.json) process.stdout.write("\n");
      if (run.question && seenQuestion !== run.question) {
        if (!options.json)
          process.stderr.write(
            `${run.question}\nAnswer: browse respond ${run.id} "answer"\n`,
          );
        seenQuestion = run.question;
      }
      if (run.error && !options.json) process.stderr.write(`${run.error}\n`);
      if (options.json)
        console.log(JSON.stringify({ type: "run_result", run }));
      else if (!options.quiet)
        process.stderr.write(`Run ${run.id}: ${run.state}\n`);
      return run;
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 300);
      if (signal) {
        const abort = () => {
          clearTimeout(timer);
          resolve();
        };
        signal.addEventListener("abort", abort, { once: true });
        setTimeout(
          () => signal.removeEventListener("abort", abort),
          310,
        ).unref();
      }
    });
  }
}

async function attach(p, run, options) {
  if (options.detach) {
    print({ id: run.id, state: run.state }, options);
    return;
  }
  const cancel = () => {
    request(p, "cancel", { id: run.id }).catch(() => {});
  };
  process.once("SIGINT", cancel);
  try {
    const result = await monitor(p, run.id, options);
    if (result?.state === "failed") process.exitCode = 1;
  } finally {
    process.off("SIGINT", cancel);
  }
}
function print(value, options) {
  if (options.json || typeof value === "object")
    console.log(JSON.stringify(value, null, options.json ? undefined : 2));
  else console.log(value);
}

async function login(p, options) {
  process.stderr.write("Continue with ChatGPT — opening the browser. Allow Browse to use your ChatGPT plan.\n");
  await loginChatGPT(p, {
    newAccount: options["new-account"],
    account: options.account,
    onURL: (url) => process.stderr.write(`If the page does not open, open this URL on the machine running Browse:\n${url}\n`),
    onBrowserError: () => process.stderr.write("Could not open BrowserOS Neo. Start Neo or open the URL above manually.\n"),
  });
  const models = await chatGPTModels(p);
  let selected;
  if (options.model) {
    selected = models.find((m) => m.id === options.model.replace(/^chatgpt\//, ""));
    if (!selected) throw Error("The requested model is not available to this ChatGPT account.");
  } else {
    if (!process.stdin.isTTY) throw Error("Signed in. Run browse login --model MODEL_ID to select an available model.");
    process.stdout.write("Connected to ChatGPT. Choose a vision/tool-capable model:\n");
    models.forEach((m, i) => process.stdout.write(`  ${i + 1}. ${m.name} (${m.id})\n`));
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      while (!selected) {
        const answer = await new Promise((resolve, reject) => {
          const cancel = () => reject(Error("Model selection cancelled; run browse login to finish setup."));
          rl.once("close", cancel);
          rl.question("Model number or ID: ", (line) => {
            rl.off("close", cancel); resolve(line.trim());
          });
        });
        selected = models.find((m) => m.id === answer) || (/^\d+$/.test(answer) ? models[Number(answer) - 1] : undefined);
        if (!selected) process.stdout.write("Choose a model from the list above.\n");
      }
    } finally { rl.close(); }
  }
  const saved = JSON.parse(fs.existsSync(p.auth) ? fs.readFileSync(p.auth, "utf8") : "{}");
  const model = `chatgpt/${selected.id}`;
  atomic(p.auth, JSON.stringify({ ...saved, model }, null, 2));
  return { configured: true, provider: "chatgpt", model };
}

async function ensureAuth(p, options) {
  let credential;
  try {
    credential = await auth(p, options.model);
  } catch (e) {
    if (!process.stdin.isTTY) throw e;
    process.stderr.write(`${e.message}\n`);
    const configured = options.provider === "chatgpt"
      ? await login(p, options) : await setup(p, options);
    options.model = configured.model;
    return;
  }
  if (credential.chatgpt) return;
  let models;
  try { models = await providerModels(credential.provider, credential.apiKey); }
  catch (e) {
    if (e.code !== "INVALID_API_KEY" || !process.stdin.isTTY) throw e;
    process.stderr.write(`${e.message}\n`);
    options.model = (await setup(p, { ...options, provider: credential.provider })).model;
    return;
  }
  if (!models.some((m) => `${credential.provider}/${m.id}` === credential.model)) {
    const message = `Saved model ${credential.model} is unavailable. Choose a model from your provider's current list.`;
    if (!process.stdin.isTTY) throw Error(message);
    process.stderr.write(`${message}\n`);
    options.model = (await setup(p, {
      provider: credential.provider, apiKey: credential.apiKey, models,
    })).model;
  }
}

async function chat(p, options, initial) {
  await ensureAuth(p, options);
  await ensureWorker(p);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "browse › ",
    terminal: Boolean(process.stdin.isTTY),
  });
  let current = initial,
    active = false,
    closed = false,
    attachmentController;
  async function execute(task) {
    if (active) {
      await request(p, "steer", { id: current.id, text: task });
      return;
    }
    const latest = current ? await request(p, "run", { id: current.id }) : null;
    if (latest?.question)
      current = await request(p, "respond", { id: current.id, answer: task });
    else if (latest && TERMINAL.has(latest.state) && !latest.historical)
      current = await request(p, "continue", { id: current.id, task });
    else
      current = await request(p, "submit", {
        task,
        model: options.model,
        attachments: options.attach,
      });
    active = true;
    attachmentController = new AbortController();
    try {
      current =
        (await monitor(p, current.id, options, attachmentController.signal)) ||
        current;
    } finally {
      active = false;
      if (!closed) rl.prompt();
    }
  }
  const handle = async (line) => {
    line = line.trim();
    if (!line) return;
    if (line === "/exit") {
      rl.close();
      return;
    }
    if (line === "/help") {
      console.log(
        "/help /status /stop /new /reconnect /exit\nType during execution to steer; answer pending questions with a message.",
      );
      return;
    }
    if (line === "/status") {
      print(await request(p, "status"), options);
      return;
    }
    if (line === "/stop") {
      if (current) await request(p, "cancel", { id: current.id });
      return;
    }
    if (line === "/new") {
      if (active) throw Error("Stop the current turn first");
      current = null;
      return;
    }
    if (line === "/reconnect") {
      console.log("Start BrowserOS Neo, then resume the failed or paused run.");
      if (current && !active)
        current = await request(p, "resume", { id: current.id });
      if (current && !active) {
        active = true;
        try {
          await monitor(p, current.id, options);
        } finally {
          active = false;
        }
      }
      return;
    }
    await execute(line);
  };
  rl.on("line", (line) => {
    handle(line)
      .catch((e) => console.error(e.message))
      .finally(() => {
        if (!active && !closed) rl.prompt();
      });
  });
  rl.on("SIGINT", () => {
    if (active && current)
      request(p, "cancel", { id: current.id }).catch((e) =>
        console.error(e.message),
      );
    else rl.close();
  });
  rl.prompt();
  await new Promise((resolve) =>
    rl.once("close", () => {
      closed = true;
      attachmentController?.abort();
      resolve();
    }),
  );
}

async function importWorkspace(p, source) {
  source = path.resolve(source);
  if (!fs.existsSync(source)) throw Error("Import source not found");
  if (fs.existsSync(p.repo) || fs.existsSync(p.db))
    throw Error("Import needs a fresh --home directory");
  if (fs.existsSync(p.root) && fs.readdirSync(p.root).length)
    throw Error("Import destination must be empty");
  mkdir(p.root);
  const store = new Store(p),
    workspace = new Workspace(p, store);
  try {
    workspace.fossil(["backup", "-R", source, p.repo], { cwd: p.root });
    fs.chmodSync(p.repo, 0o600);
    workspace.fossil(["test-integrity", "--parse", "-R", p.repo], {
      cwd: p.root,
    });
    workspace.init();
    workspace.fossil(["remote", "scrub"]);
    workspace.fossil(["remote", "off"]);
    store.rebuild(p.checkout);
    store.importedHistory(p.checkout);
    workspace.verify();
    return {
      imported: true,
      workspace: store.meta("workspace"),
      home: p.root,
      schedules: "disabled",
      history: "non-executable",
    };
  } catch (e) {
    store.close();
    fs.rmSync(p.root, { recursive: true, force: true });
    throw e;
  } finally {
    try {
      store.close();
    } catch {}
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { values: o, positionals: a } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      home: { type: "string" },
      model: { type: "string" },
      provider: { type: "string" },
      "new-account": { type: "boolean" },
      account: { type: "string" },
      list: { type: "boolean" },
      json: { type: "boolean" },
      quiet: { type: "boolean", short: "q" },
      verbose: { type: "boolean", short: "v" },
      detach: { type: "boolean" },
      resume: { type: "string" },
      attach: { type: "string", multiple: true },
      file: { type: "string" },
      workflow: { type: "string" },
      at: { type: "string" },
      every: { type: "string" },
      rating: { type: "string" },
      comment: { type: "string" },
      remote: { type: "string" },
      revision: { type: "string" },
      once: { type: "boolean" },
    },
  });
  if (o.help) {
    console.log(HELP);
    return;
  }
  const p = paths(o.home);
  const [group, command, ...rest] = a;
  o.attach = (o.attach || []).map((file) => {
    const real = fs.realpathSync(file);
    if (!fs.statSync(real).isFile()) throw Error("Attachment must be a file");
    return real;
  });
  if (group === "login" || (group === "setup" && o.provider === "chatgpt")) {
    if (o.list) { print(chatGPTAccounts(p), o); return; }
    if (o.account && o["new-account"]) throw Error("Choose --account or --new-account.");
    print(await login(p, o), o);
    return;
  }
  if (group === "setup") {
    print(await setup(p, o), o);
    return;
  }
  if (group === "import") {
    if (!command) throw Error("Specify a Fossil file");
    print(await importWorkspace(p, command), o);
    return;
  }
  if (group === "worker") {
    if (command === "serve") return serve(p);
    if (command === "start") {
      print(await ensureWorker(p), o);
      return;
    }
    if (command === "status") {
      try {
        print(await request(p, "status", {}, 1000), o);
      } catch {
        print({ running: false }, o);
      }
      return;
    }
    if (command === "stop") {
      try {
        print(await request(p, "stop"), o);
      } catch (e) {
        if (e.code !== "ENOENT" && e.code !== "ECONNREFUSED") throw e;
        print({ running: false }, o);
      }
      return;
    }
    throw Error("Use worker start|stop|status");
  }
  if (!a.length && !o.resume) {
    await chat(p, o);
    return;
  }
  await ensureWorker(p);
  const call = (method, args) => request(p, method, args);
  if (group === "runs") {
    if (command === "list") print(await call("runs"), o);
    else if (command === "show") print(await call("run", { id: rest[0] }), o);
    else if (command === "logs") {
      let after = 0;
      for (;;) {
        const events = await call("events", { id: rest[0], after });
        for (const e of events) print(e, o);
        if (events.length < 1000) break;
        after = events.at(-1).seq;
      }
    } else if (["pause", "cancel"].includes(command))
      print(await call(command, { id: rest[0] }), o);
    else if (command === "resume")
      await attach(p, await call("resume", { id: rest[0] }), o);
    else throw Error("Use runs list|show|logs|pause|resume|cancel");
    return;
  }
  if (group === "respond") {
    await attach(
      p,
      await call("respond", { id: command, answer: rest.join(" ") }),
      o,
    );
    return;
  }
  if (group === "feedback") {
    print(
      await call("feedback", {
        id: command,
        rating: o.rating,
        comment: o.comment,
      }),
      o,
    );
    return;
  }
  if (group === "workflow") {
    if (command === "create")
      print(
        await call("workflow_create", {
          name: rest[0],
          description: rest.slice(1).join(" "),
          model: o.model,
          definition: o.file
            ? workflow(JSON.parse(fs.readFileSync(o.file, "utf8")))
            : undefined,
        }),
        o,
      );
    else if (command === "show")
      print(await call("record", { kind: "workflow", id: rest[0] }), o);
    else if (command === "list")
      print(await call("records", { kind: "workflow" }), o);
    else if (command === "run")
      await attach(
        p,
        await call("workflow_run", {
          name: rest[0],
          model: o.model,
          attachments: o.attach,
        }),
        o,
      );
    else throw Error("Use workflow create|show|list|run");
    return;
  }
  if (group === "schedule") {
    if (command === "create")
      print(
        await call("schedule_create", {
          name: rest[0],
          workflow: o.workflow,
          at: o.at,
          every: o.every,
          model: o.model,
        }),
        o,
      );
    else if (command === "list") print(await call("schedules"), o);
    else if (["enable", "disable", "delete"].includes(command))
      print(await call(`schedule_${command}`, { name: rest[0] }), o);
    else throw Error("Use schedule create|list|enable|disable|delete");
    return;
  }
  if (group === "memory") {
    if (command === "search")
      print(await call("memory_search", { query: rest.join(" ") }), o);
    else if (command === "add")
      print(
        await call("memory_add", {
          name: rest[0],
          content: rest.slice(1).join(" "),
        }),
        o,
      );
    else if (command === "reindex") print(await call("reindex"), o);
    else throw Error("Use memory search|add|reindex");
    return;
  }
  if (group === "skills") {
    if (command === "list") print(await call("records", { kind: "skill" }), o);
    else if (command === "show")
      print(await call("record", { kind: "skill", id: rest[0] }), o);
    else if (command === "save") {
      if (!o.file) throw Error("Use --file for skill instructions");
      print(
        await call("skill_save", {
          name: rest[0],
          instructions: fs.readFileSync(o.file, "utf8"),
        }),
        o,
      );
    } else if (command === "restore")
      print(await call("skill_restore", { revision: rest[0] }), o);
    else throw Error("Use skills list|show|save|restore");
    return;
  }
  if (group === "artifacts") {
    if (command === "list")
      print(await call("records", { kind: "artifact" }), o);
    else if (command === "show")
      print(await call("record", { id: rest[0] }), o);
    else if (command === "export")
      print(
        await call("artifact_export", {
          id: rest[0],
          destination: rest[1],
          revision: o.revision,
        }),
        o,
      );
    else throw Error("Use artifacts list|show|export");
    return;
  }
  if (group === "context") {
    if (command !== "links") throw Error("Use context links ID");
    print(await call("links", { id: rest[0] }), o);
    return;
  }
  if (group === "export") {
    print(await call("export", { destination: command }), o);
    return;
  }
  if (group === "sync") {
    print(await call("sync", { remote: o.remote }), o);
    return;
  }
  if (o.resume) {
    let run = await call("run", { id: o.resume });
    if (["paused", "failed"].includes(run.state))
      run = await call("resume", { id: o.resume });
    await attach(p, run, o);
    return;
  }
  await ensureAuth(p, o);
  await attach(
    p,
    await call("submit", {
      task: a.join(" "),
      model: o.model,
      attachments: o.attach,
    }),
    o,
  );
}
