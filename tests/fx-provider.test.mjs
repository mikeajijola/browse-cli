import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { atomic } from "../src/util.mjs";
import assert from "node:assert/strict";
import { frontendProviderOptions } from "../src/fx-provider.mjs";

async function payload(response) { return response.text(); }
const stream = (parts) => new Response(parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

test("fx gateway preserves model, tenant and streaming while yielding removes tools", async () => {
  let captured;
  const options = frontendProviderOptions({ provider: "gateway", apiKey: "fixture", team: "team-fixture", frontend: { model: "anthropic/claude" }, disableTools: () => true,
    fetch: async (url, init) => { captured = { url, init }; return stream([{ type: "text-delta", delta: "Hello" }]); } });
  const response = await options.fetch("https://ai-gateway.vercel.sh/v4/ai/language-model", { method: "POST", headers: { Authorization: "Bearer fixture" }, body: JSON.stringify({ tools: [{ name: "act" }] }) });
  assert.equal(options.model, "anthropic/claude");
  assert.equal(captured.init.headers.get("x-vercel-ai-gateway-team"), "team-fixture");
  assert.deepEqual(JSON.parse(captured.init.body).tools, []);
  assert.match(await payload(response), /Hello/);
  await assert.rejects(options.fetch("https://other.test/models"), /destination denied/);
});

test("Codex subscription uses its own Responses endpoint and account header without an OpenAI API key", async () => {
  let captured;
  const options = frontendProviderOptions({ provider: "codex", apiKey: "fixture-access", accountId: "fixture-account", frontend: { model: "gpt-5", file: "/nonexistent/browse-credentials.json" },
    fetch: async (url, init) => {
      captured = { url, init };
      return stream([{ type: "response.created", response: { id: "response-fixture", model: "gpt-5", created_at: 1 } },
        { type: "response.output_text.delta", delta: "Hello", item_id: "item", output_index: 0, content_index: 0 },
        { type: "response.completed", response: { id: "response-fixture", model: "gpt-5", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]);
    } });
  const response = await options.fetch("https://ai-gateway.vercel.sh/v4/ai/language-model", { method: "POST", body: Buffer.from(JSON.stringify({ prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }] })) });
  await response.text();
  assert.equal(captured.url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(captured.init.headers.get("authorization"), "Bearer fixture-access");
  assert.equal(captured.init.headers.get("chatgpt-account-id"), "fixture-account");
  const body = JSON.parse(captured.init.body);
  assert.equal(body.store, false); assert.equal(body.stream, true);
  assert.ok(body.instructions);
});


test("Vercel sign-in refreshes expired private credentials before forwarding a gateway request", async (t) => {
  const profileHome = fs.mkdtempSync(path.join(os.tmpdir(), "browse-fx-refresh-"));
  t.after(() => fs.rmSync(profileHome, { recursive: true, force: true }));
  const file = path.join(profileHome, "private.json"), sessionFile = path.join(profileHome, ".browse-fx/auth.json");
  atomic(file, JSON.stringify({ apiKey: "expired-access" }));
  atomic(sessionFile, JSON.stringify({ version: 1, issuer: "https://vercel.com", client_id: "fixture-client", access_token: "expired-access", refresh_token: "fixture-refresh", expires_at_ms: 1 }));
  let refreshes = 0, authorization;
  const transport = frontendProviderOptions({ provider: "gateway", apiKey: "expired-access", profileHome, frontend: { model: "anthropic/claude", file },
    fetch: async (url, init) => {
      if (url === "https://vercel.com/oauth/token") {
        refreshes++; assert.equal(new URLSearchParams(init.body).get("grant_type"), "refresh_token");
        return Response.json({ access_token: "renewed-access", refresh_token: "rotated-refresh", expires_in: 3600 });
      }
      authorization = init.headers.get("authorization"); return Response.json({ data: [] });
    } });
  await transport.fetch("https://ai-gateway.vercel.sh/coding-agent/v1/models");
  assert.equal(refreshes, 1); assert.equal(authorization, "Bearer renewed-access");
  assert.equal(JSON.parse(fs.readFileSync(file)).apiKey, "renewed-access");
  assert.equal(JSON.parse(fs.readFileSync(sessionFile)).refresh_token, "rotated-refresh");
});

test("configured fx providers retain model namespaces, base URL and anonymous authentication", async () => {
  let captured;
  const transport = frontendProviderOptions({ provider: "local", apiKey: "", configured: { protocol: "openai-chat-completions", base_url: "http://localhost:11434/v1", auth: { type: "none" } }, frontend: { model: "vendor/model" },
    fetch: async (url, init) => { captured = { url, init }; return stream([{ id: "chat", choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }] }, { id: "chat", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]); } });
  const response = await transport.fetch("https://ai-gateway.vercel.sh/v4/ai/language-model", { method: "POST", body: JSON.stringify({ prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }] }) });
  await response.text();
  assert.equal(captured.url, "http://localhost:11434/v1/chat/completions");
  assert.equal(captured.init.headers.has("authorization"), false);
  assert.equal(JSON.parse(captured.init.body).model, "vendor/model");
  assert.equal(JSON.parse(captured.init.body).tool_choice, undefined);
});
