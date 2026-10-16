import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";

const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const ESC = "\x1b[", RESET = `${ESC}0m`;

// Model and website text must never issue terminal commands, including OSC.
export function safeText(text) {
  return stripVTControlCharacters(String(text)).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

export function cellWidth(text) {
  let width = 0;
  for (const { segment } of segments.segment(stripVTControlCharacters(text))) {
    const cp = segment.codePointAt(0);
    if (/^[\p{Mark}\u200d\ufe0f]+$/u.test(segment)) continue;
    width += /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(segment) ||
      cp >= 0x1100 && (cp <= 0x115f || cp >= 0x2e80 && cp <= 0xa4cf ||
        cp >= 0xac00 && cp <= 0xd7a3 || cp >= 0xf900 && cp <= 0xfaff ||
        cp >= 0xfe10 && cp <= 0xfe6f || cp >= 0xff01 && cp <= 0xff60 || cp >= 0x20000) ? 2 : 1;
  }
  return width;
}

export function wrapText(text, columns) {
  const lines = [""];
  let width = 0;
  for (const { segment } of segments.segment(safeText(text))) {
    const size = cellWidth(segment);
    if (segment === "\n" || width + size > columns) { lines.push(""); width = 0; }
    if (segment !== "\n") { lines[lines.length - 1] += segment; width += size; }
  }
  return lines;
}

function clipped(text, columns) {
  let result = "", used = 0;
  for (const { segment } of segments.segment(safeText(text).replace(/\n/g, " "))) {
    const width = cellWidth(segment);
    if (used + width > columns) break;
    result += segment; used += width;
  }
  return result;
}

export const CHAT_COMMANDS = ["/help", "/status", "/stop", "/new", "/reconnect", "/exit",
  "/conversations", "/switch", "/history", "/search", "/attach", "/detach", "/attachments", "/details", "/contract"];

export function createChatInput(options = {}) { return new ChatInput(options); }

// The composer owns its screen rows; transcript output goes through writeAbove.
export class ChatInput extends EventEmitter {
  constructor({ input = process.stdin, output = process.stdout, history = [], commands = CHAT_COMMANDS, terminal = true } = {}) {
    super();
    Object.assign(this, { input, output, history: [...history], commands, line: "", cursor: 0,
      status: "", hint: "Enter send · Alt+Enter / Ctrl+J newline · Tab commands", rows: 0,
      cursorRow: 0, shown: false, closed: false, historyIndex: -1, draft: "", buffer: "", paste: null });
    this.terminal = Boolean(terminal && input.isTTY && output.isTTY);
    this.decoder = new StringDecoder("utf8");
    if (!this.terminal) {
      this.rl = createInterface({ input, output, prompt: "browse › ", terminal: false });
      this.rl.on("line", (line) => this.emit("line", line));
      this.rl.once("close", () => this.close());
      return;
    }
    this.wasRaw = Boolean(input.isRaw);
    input.setRawMode?.(true);
    output.write(`${ESC}?2004h`);
    this.onData = (bytes) => this.receive(this.decoder.write(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)));
    this.onEnd = () => this.close();
    this.onResize = () => {
      // Existing hard lines can wrap again when a terminal narrows. Account
      // for that reflow before moving back to the composer's first row.
      const columns = Math.max(1, this.output.columns || 80);
      if (this.painted) this.cursorRow = this.painted.slice(0, this.cursorRow)
        .reduce((rows, line) => rows + Math.max(1, Math.ceil(cellWidth(line) / columns)), 0) +
        Math.floor((this.caretColumn || 0) / columns);
      this.clear(); this.draw();
    };
    input.on("data", this.onData);
    input.once("end", this.onEnd);
    output.on("resize", this.onResize);
    input.resume();
  }
  prompt() {
    if (this.closed) return;
    if (!this.terminal) { this.rl.prompt(); return; }
    this.shown = true; this.clear(); this.draw();
  }
  setStatus(status = "") {
    if (status === this.status) return;
    this.clear(); this.status = status; this.draw();
  }
  setPreview(preview = "") {
    this.clear(); this.preview = preview; this.draw();
  }
  setChoices(choices = []) { this.clear(); this.choices = choices; this.choiceIndex = 0; this.draw(); }
  clear() {
    if (!this.rows) return;
    this.output.write(`\r${this.cursorRow ? `${ESC}${this.cursorRow}A` : ""}${ESC}0J`);
    this.rows = 0; this.cursorRow = 0;
  }
  draw() {
    if (!this.shown || this.closed || !this.terminal) return;
    const width = Math.max(4, (this.output.columns || 80) - 1);
    const lines = [clipped("browse › ", Math.min(width - 1, 9))];
    let row = 0, column = cellWidth(lines[0]), caret = { row: 0, column };
    for (const { segment, index } of segments.segment(this.line)) {
      if (index === this.cursor) caret = { row, column };
      if (segment === "\n") { lines.push("  "); row++; column = 2; continue; }
      const w = cellWidth(segment);
      if (column + w > width) { lines.push("  "); row++; column = 2; if (index === this.cursor) caret = { row, column }; }
      lines[row] += segment; column += w;
    }
    if (this.cursor === this.line.length) caret = { row, column };
    const available = Math.max(1, Math.min(10, (this.output.rows || 24) - 4));
    const start = Math.max(0, caret.row - available + 1);
    const visible = lines.slice(start, start + available);
    if (start && visible.length) visible[0] = `↑ ${visible[0].slice(2)}`;
    const preview = this.preview ? wrapText(this.preview, width).slice(-3) : [];
    const choices = this.choices?.length && !this.line
      ? [`Choose: ${this.choices.map((choice, index) => `${index === this.choiceIndex ? "›" : ""}${index + 1}. ${choice}`).join("  ")}`]
      : [];
    const footer = clipped(choices[0] || this.status || this.hint, width);
    this.output.write([...preview, ...visible].join("\r\n") + `\r\n${ESC}2m${footer}${RESET}`);
    this.rows = preview.length + visible.length + 1;
    this.cursorRow = preview.length + caret.row - start;
    this.painted = [...preview, ...visible, footer]; this.caretColumn = caret.column;
    const up = this.rows - 1 - this.cursorRow;
    this.output.write(`\r${up ? `${ESC}${up}A` : ""}${caret.column ? `${ESC}${caret.column}C` : ""}`);
  }
  writeAbove(text) {
    if (this.closed) return;
    if (!this.terminal) { this.output.write(safeText(text)); return; }
    this.clear(); this.output.write(text.replace(/\r?\n/g, "\r\n")); this.draw();
  }
  replace(text) {
    this.clear(); this.line = safeText(text.replace(/\r\n?/g, "\n"));
    this.cursor = this.line.length; this.draw();
  }
  edit(fn) { this.clear(); fn(); this.draw(); }
  insert(text) {
    const value = safeText(text.replace(/\r\n?/g, "\n")).replace(/\t/g, "  ");
    if (this.line.length + value.length > 64000) {
      this.emit("notice", "Message limit is 64,000 characters. Attach a file for longer content."); return;
    }
    this.edit(() => { this.line = this.line.slice(0, this.cursor) + value + this.line.slice(this.cursor); this.cursor += value.length; });
  }
  boundaries() { return [...segments.segment(this.line)].map((item) => item.index).concat(this.line.length); }
  move(direction) {
    const boundaries = this.boundaries();
    this.cursor = direction < 0 ? boundaries.filter((index) => index < this.cursor).at(-1) ?? 0
      : boundaries.find((index) => index > this.cursor) ?? this.line.length;
  }
  recall(direction) {
    if (this.historyIndex === -1) this.draft = this.line;
    this.historyIndex = Math.max(-1, Math.min(this.history.length - 1, this.historyIndex + direction));
    this.line = this.historyIndex < 0 ? this.draft : this.history[this.historyIndex];
    this.cursor = this.line.length;
  }
  vertical(direction) {
    const starts = [0, ...this.line.matchAll(/\n/g)].map((match) => typeof match === "number" ? match : match.index + 1);
    const index = starts.findLastIndex((start) => start <= this.cursor), next = index + direction;
    if (next < 0 || next >= starts.length) { this.recall(direction < 0 ? 1 : -1); return; }
    const column = cellWidth(this.line.slice(starts[index], this.cursor));
    const text = this.line.slice(starts[next], starts[next + 1] === undefined ? this.line.length : starts[next + 1] - 1);
    let width = 0, offset = 0;
    for (const { segment } of segments.segment(text)) {
      const size = cellWidth(segment);
      if (width + size > column) break;
      width += size; offset += segment.length;
    }
    this.cursor = starts[next] + offset;
  }
  submit() {
    if (!this.line.trim() && this.choices?.length) {
      this.line = this.choices[this.choiceIndex]; this.cursor = this.line.length;
    }
    if (!this.line.trim()) return;
    const line = this.line;
    this.emit("beforeSubmit", line);
    this.clear(); this.output.write(`You › ${line.replace(/\n/g, "\r\n  ")}\r\n`);
    if (!line.startsWith("/")) this.history = [line, ...this.history.filter((item) => item !== line)].slice(0, 500);
    this.line = ""; this.cursor = 0; this.historyIndex = -1; this.draft = "";
    this.draw(); this.emit("line", line);
  }
  key(key) {
    if (key === "\r") {
      if (this.line[this.cursor - 1] === "\\") {
        this.edit(() => { this.line = this.line.slice(0, this.cursor - 1) + this.line.slice(this.cursor); this.cursor--; });
        this.insert("\n");
      } else this.submit();
      return;
    }
    if (["\n", "\x1b\r", "\x1b\n", `${ESC}13;2u`, `${ESC}13;3u`, `${ESC}27;2;13~`].includes(key)) { this.insert("\n"); return; }
    if (key === "\x03") { this.emit("SIGINT"); return; }
    if (key === "\x04" && !this.line) { this.close(); return; }
    if (key === "\x1b") { this.emit("escape"); return; }
    if (key === "\t") {
      const matches = this.commands.filter((command) => command.startsWith(this.line));
      if (matches.length === 1) this.replace(matches[0] + " ");
      else if (matches.length) this.emit("notice", matches.join("  "));
      return;
    }
    if (this.choices?.length && !this.line && [`${ESC}A`, `${ESC}B`].includes(key)) {
      this.edit(() => { this.choiceIndex = (this.choiceIndex + (key === `${ESC}A` ? -1 : 1) + this.choices.length) % this.choices.length; });
      return;
    }
    this.edit(() => {
      if ([`${ESC}A`, "\x1bOA"].includes(key)) this.vertical(-1);
      else if ([`${ESC}B`, "\x1bOB"].includes(key)) this.vertical(1);
      else if ([`${ESC}D`, "\x02"].includes(key)) this.move(-1);
      else if ([`${ESC}C`, "\x06"].includes(key)) this.move(1);
      else if ([`${ESC}H`, `${ESC}1~`, "\x01"].includes(key)) this.cursor = this.cursor ? this.line.lastIndexOf("\n", this.cursor - 1) + 1 : 0;
      else if ([`${ESC}F`, `${ESC}4~`, "\x05"].includes(key)) { const end = this.line.indexOf("\n", this.cursor); this.cursor = end < 0 ? this.line.length : end; }
      else if ([`${ESC}1;5D`, `${ESC}1;3D`, "\x1bb"].includes(key)) this.cursor = this.line.slice(0, this.cursor).replace(/\s*\S+\s*$/, "").length;
      else if ([`${ESC}1;5C`, `${ESC}1;3C`, "\x1bf"].includes(key)) this.cursor += /^\s*\S+\s*/.exec(this.line.slice(this.cursor))?.[0].length || 0;
      else if (key === "\x7f" || key === "\b") { const end = this.cursor; this.move(-1); this.line = this.line.slice(0, this.cursor) + this.line.slice(end); }
      else if (key === `${ESC}3~` || key === "\x04") { const start = this.cursor; this.move(1); this.line = this.line.slice(0, start) + this.line.slice(this.cursor); this.cursor = start; }
      else if (key === "\x15") { this.line = this.line.slice(this.cursor); this.cursor = 0; }
      else if (key === "\x0b") this.line = this.line.slice(0, this.cursor);
      else if (key === "\x17") { const end = this.cursor; this.cursor = this.line.slice(0, end).replace(/\s*\S+\s*$/, "").length; this.line = this.line.slice(0, this.cursor) + this.line.slice(end); }
    });
  }
  receive(text) {
    clearTimeout(this.escapeTimer);
    // A batch containing line breaks is an editable paste even on terminals
    // without bracketed-paste support, never a sequence of submissions.
    if (this.paste === null && !this.buffer && !text.includes("\x1b") && text.length > 1 && /[\r\n]/.test(text)) {
      this.insert(text); return;
    }
    this.buffer += text;
    while (this.buffer) {
      if (this.paste !== null) {
        const end = this.buffer.indexOf(`${ESC}201~`);
        if (end < 0) {
          const keep = Math.min(5, this.buffer.length);
          this.paste += this.buffer.slice(0, -keep);
          this.buffer = this.buffer.slice(-keep);
          if (this.paste.length > 64000) this.paste = this.paste.slice(0, 64001);
          return;
        }
        const pasted = this.paste + this.buffer.slice(0, end);
        this.paste = null; this.buffer = this.buffer.slice(end + 6); this.insert(pasted); continue;
      }
      if (this.buffer.startsWith(`${ESC}200~`)) { this.paste = ""; this.buffer = this.buffer.slice(6); continue; }
      if (this.buffer[0] === "\x1b") {
        const match = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|O[A-Za-z]|[^\[O])/.exec(this.buffer);
        if (!match) {
          this.escapeTimer = setTimeout(() => { const value = this.buffer; this.buffer = ""; if (value === "\x1b") this.key(value); }, 40);
          return;
        }
        this.buffer = this.buffer.slice(match[0].length); this.key(match[0]); continue;
      }
      const printable = /^[^\x00-\x1f\x7f]+/.exec(this.buffer)?.[0];
      if (printable) { this.buffer = this.buffer.slice(printable.length); this.insert(printable); }
      else { const key = this.buffer[0]; this.buffer = this.buffer.slice(1); this.key(key); }
    }
  }
  close() {
    if (this.closed) return;
    this.clear(); this.closed = true;
    clearTimeout(this.escapeTimer);
    if (this.terminal) {
      this.input.off("data", this.onData); this.input.off("end", this.onEnd);
      this.output.off("resize", this.onResize);
      this.output.write(`${ESC}?2004l${RESET}`);
      this.input.setRawMode?.(this.wasRaw);
      this.input.pause();
    } else this.rl.close();
    this.emit("close");
  }
}
