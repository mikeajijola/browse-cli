import { setTimeout as delay } from "node:timers/promises";

export function parseRpc(text, id) {
  const messages = text
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const message = messages.length
    ? messages.find((m) => m.id === id)
    : JSON.parse(text);
  if (!message) throw Error("Neo returned no matching RPC response");
  if (message.error) throw Error(message.error.message);
  return message.result;
}
export class Neo {
  constructor(url = process.env.BROWSE_NEO_URL || "http://127.0.0.1:9010/mcp") {
    this.url = url;
    this.sequence = 0;
    this.headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
  }
  async rpc(method, params = {}, signal, notification = false) {
    const id = ++this.sequence;
    const response = await fetch(this.url, {
      method: "POST",
      redirect: "error",
      headers: this.headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method,
        params,
        ...(!notification ? { id } : {}),
      }),
      signal: AbortSignal.any([
        AbortSignal.timeout(45000),
        ...(signal ? [signal] : []),
      ]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Object.assign(Error(`Neo HTTP ${response.status}`), {
        status: response.status,
      });
    }
    const session = response.headers.get("mcp-session-id");
    if (session) this.headers["Mcp-Session-Id"] = session;
    const text = await response.text();
    return text.trim() ? parseRpc(text, id) : {};
  }
  async connect(signal) {
    delete this.headers["Mcp-Session-Id"];
    await this.rpc(
      "initialize",
      {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "browse", version: "0.1.0" },
      },
      signal,
    );
    await this.rpc("notifications/initialized", {}, signal, true);
    const tools = [];
    let cursor;
    do {
      const r = await this.rpc("tools/list", cursor ? { cursor } : {}, signal);
      tools.push(...r.tools);
      cursor = r.nextCursor;
    } while (cursor);
    this.tools = tools;
    return tools;
  }
  async ready(signal) {
    const bounded = AbortSignal.any([
      AbortSignal.timeout(60000),
      ...(signal ? [signal] : []),
    ]);
    for (;;) {
      bounded.throwIfAborted();
      try {
        if (!this.tools) await this.connect(bounded);
        await this.rpc("ping", {}, bounded);
        return;
      } catch {
        this.tools = undefined;
        await delay(1000, undefined, { signal: bounded });
      }
    }
  }
  async call(tool, args, signal) {
    const params = {
      name: tool,
      arguments: {
        ...args,
        ...(this.browserSession && !args.session
          ? { session: this.browserSession }
          : {}),
      },
    };
    let result;
    try {
      result = await this.rpc("tools/call", params, signal);
    } catch (error) {
      if (error.status !== 404 || signal?.aborted) throw error;
      await this.connect(signal);
      result = await this.rpc("tools/call", params, signal);
    }
    if (result?._meta?.["com.browseros.neo/session"])
      this.browserSession = result._meta["com.browseros.neo/session"];
    return result;
  }
}
// Everything else, especially arbitrary run/evaluate scripts, is potentially effectful.
export const harmless = (tool) =>
  [
    "snapshot",
    "read",
    "grep",
    "diff",
    "screenshot",
    "history",
    "name_session",
    "list_helpers",
    "read_helper",
  ].includes(tool);
