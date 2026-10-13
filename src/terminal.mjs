import { createInterface } from "node:readline/promises";

export function createChatInput({ input = process.stdin, output = process.stdout, history = [] } = {}) {
  // The promises interface keeps terminal editing enabled when TERM is "dumb".
  return createInterface({
    input,
    output,
    prompt: "browse › ",
    terminal: Boolean(input.isTTY),
    history,
    historySize: 500,
    removeHistoryDuplicates: true,
  });
}
