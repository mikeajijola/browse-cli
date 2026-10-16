import { safeText, cellWidth, wrapText } from "./terminal.mjs";

const style = (text, code, color) => color ? `\x1b[${code}m${text}\x1b[0m` : text;

function inline(text, color) {
  return text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)")
    .replace(/\*\*([^*]+)\*\*/g, (_, value) => style(value, "1", color))
    .replace(/`([^`]+)`/g, (_, value) => style(value, "36", color));
}

// Streaming Markdown keeps incomplete lines out of terminal scrollback. Tables
// are buffered as a unit so widths can be chosen before any row is committed.
export class Markdown {
  constructor({ columns = 80, color = false } = {}) {
    this.columns = columns; this.color = color; this.code = false; this.table = [];
  }
  tableRows() {
    const table = this.table.splice(0);
    if (!table.length) return "";
    if (table.length < 2 || !/^\s*\|?\s*:?-{3}/.test(table[1])) return table.map((row) => inline(row, this.color)).join("\n") + "\n";
    const rows = table.filter((_, index) => index !== 1).map((row) => row.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()));
    const count = Math.max(...rows.map((row) => row.length));
    const widths = Array.from({ length: count }, (_, index) => Math.max(...rows.map((row) => cellWidth(row[index] || ""))));
    if (widths.reduce((sum, width) => sum + width, 0) + count * 3 + 1 > this.columns) {
      return rows.slice(1).map((row) => row.map((cell, index) => `${rows[0][index] || index + 1}: ${cell}`).join("\n")).join("\n\n") + "\n";
    }
    const separator = "+" + widths.map((width) => "-".repeat(width + 2)).join("+") + "+\n";
    return separator + rows.map((row, index) => "| " + widths.map((width, column) => {
      const cell = row[column] || "";
      return cell + " ".repeat(width - cellWidth(cell));
    }).join(" | ") + " |\n" + (index === 0 ? separator : "")).join("") + separator;
  }
  line(value) {
    const text = safeText(value);
    if (!this.code && /^\s*\|.*\|\s*$/.test(text)) {
      this.table.push(text);
      if (this.table.length < 100) return "";
      return this.tableRows();
    }
    const prefix = this.tableRows();
    if (/^\s*(```|~~~)/.test(text)) {
      this.code = !this.code;
      return prefix + style(this.code ? `┌ ${text.replace(/^\s*(```|~~~)/, "").trim() || "code"}` : "└", "2", this.color) + "\n";
    }
    if (this.code) return prefix + style(`│ ${text}`, "36", this.color) + "\n";
    const heading = /^(#{1,6})\s+(.+)$/.exec(text);
    const rendered = heading ? style(heading[2], "1", this.color) : inline(text, this.color);
    return prefix + rendered + "\n";
  }
  finish() { return this.tableRows(); }
}

const toolLabels = { tabs: "Inspect browser tabs", navigate: "Open page", read: "Read page", snapshot: "Inspect page",
  act: "Interact with page", run: "Work in browser", screenshot: "Capture screenshot", download: "Download file",
  upload: "Upload file", evaluate: "Inspect page", name_session: "Name browser session", wait: "Wait for page" };

export class ChatPresentation {
  constructor({ composer, output = process.stdout, quiet = false, verbose = false, now = Date.now } = {}) {
    Object.assign(this, { composer, output, quiet, verbose, now, pending: "", assistant: false, tools: [],
      progress: null, state: "Ready", started: null, sequence: null, detailMode: verbose });
    this.color = Boolean(output.isTTY && !process.env.NO_COLOR);
    this.markdown = new Markdown({ columns: output.columns || 80, color: this.color });
  }
  write(text) {
    if (!text) return;
    if (this.composer) this.composer.writeAbove(text);
    else this.output.write(text);
  }
  notice(text) { this.flush(); this.write(safeText(text) + "\n"); }
  start(run) {
    this.state = run?.state === "queued" ? "Queued" : "Working";
    this.started = this.now(); this.progress = run?.contract ? {
      completed: run.contract.criteria.filter((item) => item.status === "completed").length,
      total: run.contract.criteria.length, version: run.contract.version,
    } : null;
    this.timer ??= setInterval(() => this.status(), 1000);
    this.timer.unref(); this.status();
  }
  status() {
    if (!this.composer) return;
    const seconds = this.started === null ? "" : ` · ${Math.floor((this.now() - this.started) / 1000)}s`;
    const progress = this.progress ? ` · ${this.progress.completed}/${this.progress.total} criteria · v${this.progress.version}` : "";
    this.composer.setStatus(`${this.state}${seconds}${progress}${this.attachmentCount ? ` · ${this.attachmentCount} attached` : ""}`);
  }
  text(delta) {
    if (!this.assistant) { this.write(style("Browse ›", "1", this.color) + "\n"); this.assistant = true; }
    this.pending += delta;
    let newline;
    while ((newline = this.pending.indexOf("\n")) >= 0) {
      const line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      this.composer?.setPreview("");
      this.markdown.columns = this.output.columns || 80;
      this.write(this.markdown.line(line));
    }
    if (this.pending.length > 16000) {
      this.composer?.setPreview("");
      this.write(this.markdown.line(this.pending.slice(0, 16000))); this.pending = this.pending.slice(16000);
    }
    if (this.composer?.terminal) {
      this.previewTimer ??= setTimeout(() => { this.previewTimer = null; this.composer.setPreview(safeText(this.pending)); }, 40);
    } else if (this.pending) {
      // Pipes receive deltas immediately, with no ANSI or redraw protocol.
      this.write(safeText(this.pending)); this.pending = "";
    }
  }
  flush() {
    clearTimeout(this.previewTimer); this.previewTimer = null;
    this.composer?.setPreview("");
    if (this.pending) { this.write(this.markdown.line(this.pending)); this.pending = ""; }
    this.write(this.markdown.finish());
    this.assistant = false;
  }
  event(event) {
    if (event.seq && event.seq === this.sequence) return;
    this.sequence = event.seq;
    if (event.type === "text_delta") { this.text(event.delta); return; }
    if (event.type === "running") { this.state = "Thinking"; this.status(); return; }
    if (event.type === "tool_start") {
      this.flush();
      this.state = toolLabels[event.name] || event.name || "Working";
      this.tools.push({ ...event, started: this.now() }); this.tools = this.tools.slice(-200);
      if (!this.quiet) this.write(style(`  › ${this.state}`, "2", this.color) + "\n");
    } else if (event.type === "tool_end" || event.type === "tool_error") {
      const tool = this.tools.findLast((item) => item.actionId === event.actionId);
      if (tool) { tool.finished = this.now(); tool.failed = Boolean(event.isError || event.error); }
      this.state = "Thinking";
      if (!this.quiet) this.notice(`  ${event.isError || event.error ? "×" : "✓"} ${toolLabels[event.name || tool?.name] || event.name || tool?.name || "Browser action"}${event.error ? `: ${event.error}` : ""}`);
    } else if (event.type === "steering") this.notice("Follow-up queued.");
    else if (event.type === "steering_applied") this.notice("Follow-up applied.");
    else if (event.type === "contract_revised" || event.type === "contract_progress") {
      this.progress = event;
      this.notice(`Objective v${event.version}: ${event.completed}/${event.total} criteria complete${event.description ? ` · ${event.description}` : ""}`);
    } else if (event.type === "retrying") {
      this.state = `Retrying at ${new Date(event.wakeAt).toISOString().slice(11, 19)} UTC`;
      if (!this.quiet) this.notice(`Connection interrupted; retry ${event.attempt} scheduled. ${event.reason}`);
    } else if (event.type === "continuing") {
      this.state = "Continuing";
      if (!this.quiet) this.notice(event.reason || "Continuing unfinished work.");
    } else if (event.type === "recovery") {
      this.state = "Checking interrupted work";
      if (!this.quiet) this.notice("Checking interrupted work before taking further action.");
    } else if (event.type === "waiting") this.state = event.question ? "Needs your answer" : "Waiting";
    else if (this.verbose && !this.quiet && !["queued", "completed", "steering_applied"].includes(event.type)) this.notice(`[${event.type}]`);
    this.status();
  }
  finish(run) {
    this.flush();
    clearInterval(this.timer); this.timer = null;
    this.state = run.question ? "Needs your answer" : run.state === "completed" ? "Complete" : run.state;
    if (run.question) this.notice(`Question › ${run.question}${run.questionOptions?.length ? "\n" + run.questionOptions.map((option, index) => `  ${index + 1}. ${option}`).join("\n") + "\nUse Up/Down and Enter, a number, or type your own answer." : "\nReply here to continue."}`);
    if (run.error) this.notice(`Error: ${run.error}`);
    if (!this.quiet) this.write(style(`${this.state}${this.progress ? ` · ${this.progress.completed}/${this.progress.total} criteria` : ""}`, "2", this.color) + "\n");
    this.started = null; this.status();
  }
  details(actions = []) {
    this.flush();
    if (!actions.length) { this.notice("No browser actions recorded for this turn."); return; }
    for (const action of actions.slice(-50)) {
      const result = safeText(JSON.stringify(action.result ?? {}));
      this.write(`${toolLabels[action.tool] || action.tool} · ${action.state} · ${action.id}\n`);
      this.write(wrapText(result.slice(0, 4000), Math.max(20, (this.output.columns || 80) - 2)).map((line) => `  ${line}`).join("\n") + (result.length > 4000 ? "\n  … (full output: browse runs show RUN_ID)" : "") + "\n");
    }
  }
  close() {
    clearInterval(this.timer); clearTimeout(this.previewTimer);
    this.timer = null; this.previewTimer = null;
  }
}
