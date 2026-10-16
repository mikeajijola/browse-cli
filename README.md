# Browse

`browse` executes natural-language browser instructions through **libfx** and
**BrowserOS Neo**. A local worker makes runs durable. SQLite tracks execution;
Fossil carries the workspace's skills, learned context, workflows, and artifacts.

## Install

Requires **Node.js 24+**, **Zig 0.17.0** to build the frontend, the **Fossil CLI**,
and a running **BrowserOS Neo**.

```sh
npm ci
npm run build:frontend             # Set ZIG=/path/to/zig if it is not on PATH
npm link
browse
```

Browse uses the actual native terminal frontend from
[vercel-labs/fx](https://github.com/vercel-labs/fx), pinned to
`f1ab492975df66b360acc7773ba2479a4a397272` (fx 0.0.14). The welcome screen,
pickers, model selection, composer, shortcuts, themes,
and Markdown renderer come from that source, rebranded for Browse.
The frontend calls Browse's durable browser worker for execution.

First launch offers token setup for **Vercel AI Gateway**, **OpenAI**,
**Anthropic**, **Google Gemini**, **xAI**, **OpenRouter**, and a
**custom OpenAI-compatible endpoint**. Choose a provider, paste its token into
the hidden input, and select a model in the native picker. Custom endpoints
ask for an API base URL first, such as `https://example.com/v1`; HTTP is allowed
for localhost. Setup checks model access without generating a chat completion.
Use `browse setup` or `/setup` to add or replace a connection and `/model` to
switch between models from saved providers. Provider tokens are saved in the
owner-only `~/.browse-fx/browse-tokens.json` file. Treat this file as a secret;
it is outside the portable Browse workspace.

Frontend settings, connections and sessions live under `~/.browse-fx`, separately
from an existing fx installation. Native macOS Keychain entries use Browse's own
service names. Automatic fx upgrades are disabled because the frontend must keep
its Browse execution bridge. Rebuild from the pinned source to update it.

The original direct Google, OpenAI and Anthropic provider setup and existing
ChatGPT connections remain accessible through the `durable` namespace:

```sh
browse durable setup --provider google --model YOUR_MODEL_ID
browse durable login --list
```

The Neo MCP endpoint defaults to `http://127.0.0.1:9010/mcp`.
Set `BROWSE_NEO_URL` to override it. Browse never silently switches browsers.

## Run browser tasks

```sh
browse                                      # Open Browse's native terminal
browse "Search the website and write report.md"
browse --continue                           # Continue the remembered native session
browse --resume last                        # Resume the latest native session
browse runs list
browse runs show RUN_ID
browse runs logs RUN_ID
browse runs pause RUN_ID
browse runs resume RUN_ID
browse runs cancel RUN_ID
browse respond RUN_ID "Use my personal account"
```

Use `/help` for the native command and keyboard reference. `/setup` opens connections,
`/model` opens model selection, `/new` creates a fresh session, and `/resume`
opens saved sessions. The native editor handles multiline input, paste, history,
and editing while responses stream. Ctrl+O toggles full tool detail. Double
Escape interrupts the current task. Closing the terminal detaches durable work;
cancellation does not undo browser actions.

Native session IDs map to separate Browse conversations. Prompts, steering,
question answers, text deltas, tool outcomes and explicit interrupts cross a
private JSONL pipe. Credentials stay in owner-only private storage and do not
enter portable run records or command arguments. Browse's worker retains
contracts, evidence, artifacts, retry and recovery behavior.

The terminal is an fx frontend over Browse's browser-only execution engine.
Native fx shell tools, coding permissions, MCP and skill registries, and context
compaction do not control Browse's worker. Use Browse's durable commands for its
skills, memory, and run management. Native title generation and billing requests
are disabled; provider tokens are used by Browse's inference adapters.

Browse's durable management commands continue to work. `browse durable` explicitly
selects the previous command interface when a command or flag overlaps fx:

```sh
browse durable "Upload the report to this form" --attach ./report.pdf
browse durable "Download my invoices" --detach
browse durable --resume RUN_ID
browse durable --help
```

The full conversation transcript is stored as **`checkout/history.sqlite`**, a
self-contained SQLite artifact versioned in Fossil. It contains conversations and
user/assistant messages, including steering, answers to questions, and errors.
Consistent snapshots are committed at run milestones and while idle; failed
publication is retried without rerunning browser actions. The live transcript is
also durable in the runtime database between snapshots.

Private libfx checkpoints keep model context across local restarts. If a checkpoint
is unavailable or too large, Browse uses a bounded selection of recent messages;
the agent can search older messages through `conversation_search`. The full
transcript remains in SQLite even when it exceeds the model's context window.
Importing a Fossil workspace restores the same conversation history. A new request
continues that narrative with a fresh execution run; imported browser actions
remain non-executable history.

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

There is no exactly-once guarantee for external websites. Recovery inspects an
uncertain outcome before further action; the agent requests input when that
inspection cannot resolve it. Transient transport and provider failures retry
with exponential backoff capped at 60 seconds. Permanent configuration and
authentication errors are reported. Schedules catch up once, rather than replaying
all missed intervals.

## Execution contracts

For multi-step or batch browser tasks, the agent records an objective and explicit
completion criteria with `contract_revise`. Each immutable revision references a
saved user instruction. Follow-up requests can extend or revise the objective;
unchanged criteria retain their evidence. Questions do not authorize scope changes.

`contract_record` attaches completed read-only browser observations or saved
artifacts to a criterion. Browse checks observation ownership and completion,
artifact provenance and actual file hashes. The agent remains responsible for
deciding whether that evidence satisfies the requested result. This is a general
evidence ledger, rather than a domain-specific submission receipt validator.

Unfinished contracts continue across normal model replies and worker restarts.
A reply alone does not complete the task. Completed contracts block additional
browser mutations until the objective is revised for newly requested work.
`require_input` saves a genuine blocker and `workflow_wait` saves a durable delay.
There is no host-imposed turn duration, tool-count or no-progress cutoff; individual
network requests still have transport timeouts, and `/stop` remains effective.
Simple questions do not need a contract.

Contract revisions and progress are versioned in Fossil under
`contracts/<run-id>/v<version>.json` and `contracts/<run-id>/progress.json`.
`/contract` shows criteria and evidence; `/status` and the activity row show counts.

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
  history.sqlite
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
- Native frontend: `~/.browse-fx` (isolated test profiles may set `BROWSE_PROFILE_HOME`).
- Native worker credential leases: `private/frontend-credentials` (never exported).
- Legacy credentials: `$XDG_CONFIG_HOME/browse/auth.json`
  (default `~/.config/browse/auth.json`); ChatGPT connections and the installation
  ID are in `chatgpt.json` and `chatgpt-host.json` alongside it.
  Credentials are shared across local workspaces.
- Runtime: `runtime.sqlite`, `private/checkpoints`, worker socket, lock and log.
- Portable repository: `workspace.fossil` and its `checkout`.

Directories and private files use owner-only permissions. The npm package includes the frontend binary built for its target platform; your Fossil workspace travels separately. Personal
transcripts and artifacts are included in workspace exports and explicit syncs.

## Verification

```sh
npm run build:frontend
npm test
npm run test:browser
```

The default suite tests provider adapters through real libfx with deterministic
provider responses, worker state transitions, crash recovery, publication failures,
binary/history round trips, CLI processes and index reconstruction. The explicit
browser test needs running Neo and exercises a local fixture through real libfx,
with uploads, form submission, downloads, screenshots and Fossil verification.
It uses a deterministic model response fixture, so no paid AI credentials are needed.
