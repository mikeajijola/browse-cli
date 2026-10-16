import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveToken, tokenCatalog, tokenFile, resolveToken, endpointURL } from "../src/frontend-tokens.mjs";
import { frontendProviderOptions } from "../src/fx-provider.mjs";

function profile(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-tokens-test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test("every onboarding provider checks its own API and preserves saved connections", async (t) => {
  const profileHome = profile(t), calls = [];
  const network = async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.redirect, "error");
    if (url.endsWith("/key")) return Response.json({ data: {} });
    if (url.includes("googleapis")) {
      assert.equal(init.headers["x-goog-api-key"], "private-token-google");
      return Response.json({ models: [{ name: "models/gemini-fixture", supportedGenerationMethods: ["generateContent"] }] });
    }
    if (url.includes("anthropic")) assert.equal(init.headers["x-api-key"], "private-token-anthropic");
    const id = url.includes("api.openai") ? "gpt-fixture" : url.includes("anthropic") ? "claude-fixture" : "vendor/model";
    return Response.json({ data: [{ id, type: "language", supported_parameters: ["tools"] },
      ...(!url.includes("api.openai") && !url.includes("anthropic") ? [{ id: "image-generation", type: "image" }] : [])] });
  };
  for (const provider of ["vercel", "openai", "anthropic", "google", "xai", "openrouter", "custom"])
    await saveToken({ provider, apiKey: `private-token-${provider}`, endpoint: "https://custom.example/v1/", profileHome, network });
  assert.equal(fs.statSync(tokenFile(profileHome)).mode & 0o777, 0o600);
  const catalog = tokenCatalog(profileHome);
  assert.equal(catalog.data.length, 7);
  assert.ok(!JSON.stringify(catalog).includes("private-token"));
  assert.equal(resolveToken("openai/gpt-fixture", profileHome).apiKey, "private-token-openai");
  assert.equal(resolveToken("custom/vendor/model", profileHome).endpoint, "https://custom.example/v1");
  assert.equal(resolveToken("openai/vendor/model", profileHome), null);
  assert.ok(calls.some(({ url }) => url === "https://openrouter.ai/api/v1/key"));
  assert.ok(calls.some(({ url }) => url === "https://api.x.ai/v1/models"));
  assert.ok(calls.every(({ init }) => !init.method || init.method === "GET"));
});

test("invalid tokens, redirects and empty model lists cannot replace a working connection", async (t) => {
  const profileHome = profile(t);
  await saveToken({ provider: "openai", apiKey: "valid-token", profileHome, network: async () => Response.json({ data: [{ id: "gpt-fixture" }] }) });
  const before = fs.readFileSync(tokenFile(profileHome), "utf8");
  for (const provider of ["vercel", "openai", "anthropic", "google", "xai", "openrouter", "custom"]) {
    await assert.rejects(saveToken({ provider, apiKey: "bad-token", endpoint: "https://custom.example/v1", profileHome,
      network: async () => new Response("secret response", { status: 401 }) }), { code: "INVALID_API_KEY" });
  }
  await assert.rejects(saveToken({ provider: "custom", apiKey: "bad-token", endpoint: "https://custom.example/v1", profileHome,
    network: async () => Response.json({ data: [] }) }), /No chat models/);
  assert.equal(fs.readFileSync(tokenFile(profileHome), "utf8"), before);
});

test("custom endpoints reject credentials, query secrets, and nonlocal plain HTTP", () => {
  for (const value of ["http://remote.example/v1", "https://user:password@host/v1", "https://host/v1?key=secret", "https://host/v1#secret", "file:///tmp/models"])
    assert.throws(() => endpointURL(value));
  assert.equal(endpointURL("http://127.0.0.1:1234/v1/"), "http://127.0.0.1:1234/v1");
});

test("token inference routes model namespaces and credentials to the selected endpoint", async () => {
  for (const [tokenProvider, tokenEndpoint, tokenModel] of [
    ["custom", "https://custom.example/v1", "vendor/model"],
    ["openrouter", "https://openrouter.ai/api/v1", "vendor/model"],
    ["xai", "https://api.x.ai/v1", "grok-fixture"],
  ]) {
    let observed;
    const options = frontendProviderOptions({ tokenProvider, tokenEndpoint, tokenModel, apiKey: "private-token", frontend: {},
      fetch: async (url, init) => { observed = { url, init }; return new Response('data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }); } });
    const result = await options.fetch("https://ai-gateway.vercel.sh/v4/ai/language-model", { method: "POST",
      body: JSON.stringify({ prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] }) });
    await result.text();
    assert.equal(observed.url, `${tokenEndpoint}/chat/completions`);
    assert.equal(new Headers(observed.init.headers).get("authorization"), "Bearer private-token");
    assert.equal(JSON.parse(observed.init.body).model, tokenModel);
  }
});
