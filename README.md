# Browse

`browse` executes natural-language browser instructions through **libfx** and
**BrowserOS Neo**. A local worker makes runs durable. SQLite tracks execution;
Fossil carries the workspace's skills, learned context, workflows, and artifacts.

## Install

Requires **Node.js 24+**, the **Fossil CLI**, and a running **BrowserOS Neo**.

```sh
npm ci
npm link
browse --help
browse                                  # Opens ChatGPT sign-in on first launch
browse "Find and download my latest invoice"
```

On first launch, Browse automatically opens **Continue with ChatGPT** in
BrowserOS Neo. Sign in, allow Browse to use your ChatGPT plan, then choose a
vision and tool-capable model from your account's current model list in the
terminal. Browser tasks go at the `browse ›` prompt. Eligible ChatGPT accounts
can use their plan through this official sign-in flow without an API key.
If Neo cannot open the page, Browse prints a link to open on the same machine
running the CLI. Remote browser loopback callbacks must reach that machine.

```sh
browse login                            # Sign in again
browse login --new-account              # Add another account/workspace
browse login --list                     # Show saved accounts
browse login --account ACCOUNT_ID       # Reconnect an existing account
browse login --model MODEL_ID            # Choose an available model explicitly
browse setup --provider google --model YOUR_MODEL_ID  # API-key setup
```

ChatGPT credentials and a stable installation ID are saved under the Browse
configuration directory with owner-only permissions, outside the portable
workspace. Connections remain separate by issued client ID and verified account
identity; login reuses the selected connection unless `--new-account` is supplied.
Expired access tokens refresh automatically. OAuth consent and plan/model
availability are determined by OpenAI. Browse uses the public Responses API with
streaming enabled and response storage disabled for ChatGPT plan requests.

Choose an existing vision and tool-capable model from Google, OpenAI, or Anthropic.
Browse does not silently choose a model or route requests through AI Gateway.
API keys are entered with hidden input. Noninteractive setup uses
`GEMINI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY`, `OPENAI_API_KEY`, or
`ANTHROPIC_API_KEY`, and requires `--provider` and `--model`.

If your default Node is older, install Node 24 or run commands with:

```sh
npx --yes --package=node@24 node bin/browse.mjs --help
```

The Neo MCP endpoint defaults to `http://127.0.0.1:9010/mcp`.
Set `BROWSE_NEO_URL` to override it. Browse never silently switches browsers.

## Run browser tasks

```sh
browse                                      # Interactive chat
browse "Search the website and write report.md"
browse "Upload the report to this form" --attach ./report.pdf
browse "Download my invoices" --detach
browse --resume RUN_ID
browse runs list
browse runs show RUN_ID
browse runs logs RUN_ID
browse runs pause RUN_ID
browse runs resume RUN_ID
browse runs cancel RUN_ID
browse respond RUN_ID "Use my personal account"
```

Type while an interactive turn is running to steer it. `/stop` cancels the current
task; `/new` starts a separate conversation. `/help`, `/status`, `/reconnect`, and
`/exit` are also available. Answer a pending question by typing a message.

Closing the terminal detaches work. Ctrl+C during attached execution cancels the
active task. Cancellation does not undo browser actions. Browser tabs are retained.
`--quiet` suppresses routine progress; `--verbose` shows event types without raw
tool arguments. `--json` emits machine-readable output, with JSONL events for
attached runs. Stored transcripts and tool results may contain personal data.

Browse acts within your instruction. Missing details, login challenges and
uncertain outcomes cause it to request input. Local file access is limited to
explicit attachments and the workspace; no shell tool is exposed to the agent.
Native browser scripts remain powerful browser tools and operate under these
instructions; file restrictions are enforced on Browse's own file tools and
direct upload calls, not a sandbox around every Neo script.

## Durable worker and recovery

The CLI automatically starts a background worker. It communicates through a
user-owned Unix socket and serializes browser runs.

```sh
browse worker status
browse worker start
browse worker stop
```

Runs survive terminal exits and worker restarts. A stopped worker must be restarted
with `browse worker start` or another Browse command; this release does not install
an operating-system service. A machine that is off cannot execute browser actions.

Browser intent is saved before dispatch, and results are saved afterward. Libfx
checkpoints are saved between turns. Recovery uses the checkpoint, recorded actions,
and fresh observations. Uncertain submissions, clicks, uploads, and scripts are not
blindly retried. Recovery initially permits read-only browser observations; an
action can be reconciled only with recorded observation IDs and evidence.

There is no exactly-once guarantee for external websites. When evidence is
insufficient, the run waits for you. A turn is bounded to 120 browser calls and
15 minutes; workflows provide longer-lived execution through multiple steps and
durable waits. Schedules catch up once, rather than replaying all missed intervals.

## Workflows and schedules

```sh
browse workflow create invoices "Download my invoices and write a report"
browse workflow create invoices --file examples/invoices.workflow.json
browse workflow show invoices
browse workflow list
browse workflow run invoices --detach
browse schedule create monthly --workflow invoices --every 30d
browse schedule create one-off --workflow invoices --at 2026-12-01T09:00:00Z
browse schedule list
browse schedule disable monthly
browse schedule enable monthly
browse schedule delete monthly
```

Natural-language creation uses libfx to produce a validated definition and displays
the saved version. File-based creation needs no AI credentials. Definitions use
`browse.workflow/v1` with ordered `browser`, `wait`, and `input` steps. Browser
steps can make decisions within their task; waits use durations such as `30s`,
`2h`, or `30d`. Input steps persist their questions until answered. The browser
agent can also request a durable wait or input during a task.

Schedules use UTC. A schedule cannot overlap its own unfinished run. `30d` is an
elapsed interval, not a calendar-month rule. Deleted schedules remain as disabled
historical records. Imported schedules are disabled until explicitly enabled.

## Files and artifacts in Fossil

```text
checkout/
  workspace.json
  skills/
  workflows/
  memory/
  context/records/
  context/schedules/
  runs/
  artifacts/<run-id>/<artifact-id>/<filename>
  artifacts/<run-id>/manifest.json
```

Browse saves generated Markdown, HTML, JSON and text using its artifact tool.
Screenshots preserve the actual image bytes. Neo download and PDF results reporting
files on the same host are copied into the workspace, with a 64 MiB import limit.
Automatic import accepts files under `~/Downloads` and `~/.browseros/downloads`;
set `BROWSE_DOWNLOAD_ROOT` for a different browser download directory. Arbitrary
local paths appearing in page content are not imported.
Full observations saved by Neo under `~/.browseros/tool-output` are also retained.
A Neo instance on another machine must make its downloaded files available locally
before Browse can import those bytes; remote filesystem paths alone are insufficient.

Artifacts record their hash, source, media type, producing run and action. New
artifacts get unique paths, so existing files are not overwritten. Browse can upload
checkout files and extract a historical Fossil revision into private staging.

```sh
browse "Upload artifacts/RUN/ARTIFACT/report.pdf to the requested form"
browse artifacts list
browse artifacts show ARTIFACT_ID
browse artifacts export ARTIFACT_ID ./invoice.pdf
browse artifacts export ARTIFACT_ID ./old-invoice.pdf --revision CHECKIN_HASH
```

SQLite's durable outbox publishes portable records through Fossil's supported CLI.
Local commits happen at run milestones and while idle. A failed commit leaves the
outbox pending; publication can be retried without repeating browser execution.
Status exposes pending publications and the latest publication error. Restoring
files never executes their contents or replays browser actions.

## Memory, skills, feedback and context

```sh
browse memory add invoice-format "Prefer PDF invoices"
browse memory search invoices
browse memory reindex
browse skills save invoices --file ./invoice-skill.md
browse skills list
browse skills show invoices
browse skills restore SKILL_REVISION_ID
browse feedback RUN_ID --rating positive --comment "Exactly the right invoices"
browse feedback RUN_ID --rating negative --comment "Wrong date range"
browse context links RUN_OR_RECORD_ID
```

Browse retrieves a bounded selection of related memory and skills using SQLite
full-text search and recorded relationships. The agent can save supported lessons
and procedural improvements. Skills have immutable revision records; restoring
one creates a new revision. Current skill files are maintained by Browse commands,
not by treating arbitrary checkout edits as learned records.

Records link runs to the exact skill revisions used, artifacts, outcomes and
feedback. Outcome records are labelled `agent_reported`; their action IDs provide
the supporting browser evidence. User satisfaction comes from explicit ratings;
this release does not infer satisfaction from silence or conversational sentiment.
Positive and negative feedback help rank relevant skills. Shared run feedback
indicates contribution, not proof that one skill alone caused success.

Fossil contains canonical records and their history. SQLite's search indexes and
skill statistics can be rebuilt. Memories include timestamps and provenance and
are treated as fallible context, never authority to expand the requested task.

## Portability

```sh
browse export ./browse-memory.fossil
browse import ./browse-memory.fossil --home ~/.local/share/browse-imported
browse --home ~/.local/share/browse-imported setup --provider google --model YOUR_MODEL
browse --home ~/.local/share/browse-imported memory search invoices
browse sync --remote https://YOUR_FOSSIL_SERVER/repository
browse sync
```

Export flushes pending portable records, checks committed artifacts and references,
then uses Fossil's consistent backup operation. Export requires no active browser
turn; pause it or wait for completion first. Files with missing bytes, altered
hashes, or uncommitted changes cause export to fail. Saved Fossil remote passwords
are scrubbed from exports.

Import requires an empty destination, validates the workspace, opens a checkout,
and rebuilds memory indexes. Imported runs are non-executable history and imported
schedules are disabled. Bring fresh model credentials and a connected Neo browser.
Private checkpoints, browser cookies, credentials, sockets and locks do not travel.

Sync exchanges committed history with an explicitly configured HTTPS or SSH
Fossil remote. Autosync is disabled. Fossil merge conflicts must be resolved in the
checkout before normal publication/export continues. You can use standard Fossil
history, diff and merge tools in the checkout. Remote publishing is never automatic.

## Storage and configuration

- Workspace: `$BROWSE_HOME`, `--home`, or `$XDG_DATA_HOME/browse`
  (default `~/.local/share/browse`).
- Credentials: `$XDG_CONFIG_HOME/browse/auth.json`
  (default `~/.config/browse/auth.json`); ChatGPT connections and the installation
  ID are in `chatgpt.json` and `chatgpt-host.json` alongside it.
  Credentials are shared across local workspaces.
- Runtime: `runtime.sqlite`, `private/checkpoints`, worker socket, lock and log.
- Portable repository: `workspace.fossil` and its `checkout`.

Directories and private files use owner-only permissions. The npm package ships
code and examples only; your Fossil workspace travels separately. Personal
transcripts and artifacts are included in workspace exports and explicit syncs.

## Verification

```sh
npm test
npm run test:browser
```

The default suite tests provider adapters through real libfx with deterministic
provider responses, worker state transitions, crash recovery, publication failures,
binary/history round trips, CLI processes and index reconstruction. The explicit
browser test needs running Neo and exercises a local fixture through real libfx,
with uploads, form submission, downloads, screenshots and Fossil verification.
It uses a deterministic model response fixture, so no paid AI credentials are needed.
