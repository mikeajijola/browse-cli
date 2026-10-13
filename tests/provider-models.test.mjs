import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { providerModels, setup } from "../src/provider.mjs";

test("Google model discovery uses the key header, follows pagination, and excludes non-chat models", async () => {
  let calls = 0;
  const models = await providerModels("google", "fixture-key", async (url, init) => {
    assert.equal(init.headers["x-goog-api-key"], "fixture-key");
    assert.ok(!url.includes("fixture-key"));
    assert.equal(init.redirect, "error");
    calls++;
    if (calls === 1) return Response.json({ models: [
      { name: "models/embed-test", supportedGenerationMethods: ["embedContent"] },
      { name: "models/gemini-test-image", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-test-chat", displayName: "Test Chat", supportedGenerationMethods: ["generateContent"] },
    ], nextPageToken: "page-2" });
    assert.equal(new URL(url).searchParams.get("pageToken"), "page-2");
    return Response.json({ models: [
      { name: "models/gemini-test-other", supportedGenerationMethods: ["generateContent"] },
    ] });
  });
  assert.deepEqual(models, [{ id: "gemini-test-chat", name: "Test Chat" }, { id: "gemini-test-other", name: "gemini-test-other" }]);
  assert.equal(calls, 2);
});

test("OpenAI discovery authenticates and omits unrelated endpoints' models", async () => {
  const models = await providerModels("openai", "fixture-key", async (url, init) => {
    assert.equal(url, "https://api.openai.com/v1/models");
    assert.equal(init.headers.Authorization, "Bearer fixture-key");
    return Response.json({ data: [{ id: "gpt-test-chat" }, { id: "text-embedding-test" }, { id: "gpt-test-realtime" }] });
  });
  assert.deepEqual(models, [{ id: "gpt-test-chat", name: "gpt-test-chat" }]);
});

test("Anthropic discovery authenticates and follows the last-ID cursor", async () => {
  let calls = 0;
  const models = await providerModels("anthropic", "fixture-key", async (url, init) => {
    assert.equal(init.headers["x-api-key"], "fixture-key");
    assert.equal(init.headers["anthropic-version"], "2023-06-01");
    if (++calls === 1) return Response.json({ data: [{ id: "claude-test-a", display_name: "Test A" }], has_more: true, last_id: "claude-test-a" });
    assert.equal(new URL(url).searchParams.get("after_id"), "claude-test-a");
    return Response.json({ data: [{ id: "claude-test-b" }], has_more: false });
  });
  assert.deepEqual(models.map((m) => m.id), ["claude-test-a", "claude-test-b"]);
});

test("invalid keys and network failures produce guidance without exposing provider bodies or secrets", async () => {
  await assert.rejects(providerModels("google", "fixture-secret", async () => new Response("fixture-secret", { status: 403 })), (e) => {
    assert.equal(e.code, "INVALID_API_KEY");
    assert.match(e.message, /Check your API key/);
    assert.ok(!e.message.includes("fixture-secret"));
    return true;
  });
  await assert.rejects(providerModels("google", "fixture-secret", async () => { throw Error("fixture-secret"); }), /Check your connection/);
});

test("setup rejects an unavailable model before overwriting a saved configuration", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browse-models-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const p = { auth: path.join(root, "auth.json") };
  const original = JSON.stringify({ model: "google/gemini-test-chat", credentials: { google: "saved-key" } });
  fs.writeFileSync(p.auth, original);
  await assert.rejects(setup(p, {
    provider: "google", model: "hi", apiKey: "fixture-key",
    fetch: async () => Response.json({ models: [{ name: "models/gemini-test-chat", supportedGenerationMethods: ["generateContent"] }] }),
  }), /Model hi is not available/);
  assert.equal(fs.readFileSync(p.auth, "utf8"), original);
});
