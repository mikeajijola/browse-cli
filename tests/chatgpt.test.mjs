import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { loginChatGPT, chatGPTAuth, chatGPTModels, chatGPTAccounts } from "../src/chatgpt.mjs";
import { atomic, json } from "../src/util.mjs";
import { auth } from "../src/provider.mjs";

const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
const granted = "openid email profile offline_access resource.invoke chatgpt.tokens.use.direct";

function fixture(t, changes = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browse-login-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const p = { auth: path.join(root, "auth.json") };
  let authorize;
  const attempts = [], requests = [];
  const client = changes.client || "oaiapp_test";
  const options = {
    timeoutMs: 3000,
    openURL: async (url) => {
      authorize = new URL(url);
      attempts.push(authorize);
      const callback = new URL(authorize.searchParams.get("redirect_uri"));
      callback.search = new URLSearchParams({ state: authorize.searchParams.get("state"), code: "test-code", client_id: client });
      if (changes.invalidStateFirst) {
        const before = requests.length;
        const invalid = new URL(callback);
        invalid.searchParams.set("state", "wrong-state");
        const result = await fetch(invalid);
        assert.equal(result.status, 400);
        await result.text();
        assert.equal(requests.length, before);
      }
      if (changes.denied) callback.searchParams.set("error", "access_denied");
      const result = await fetch(callback);
      await result.text();
    },
    fetch: async (url, init) => {
      requests.push(String(url));
      if (String(url).endsWith("jwks.json")) return Response.json({ keys: [jwk] });
      assert.equal(String(url), "https://auth.openai.com/api/accounts/oauth/token");
      const body = init.body;
      assert.equal(body.get("client_id"), client);
      assert.equal(body.get("resource"), "https://api.openai.com/v1");
      assert.equal(body.get("redirect_uri"), authorize.searchParams.get("redirect_uri"));
      assert.equal(createHash("sha256").update(body.get("code_verifier")).digest("base64url"), authorize.searchParams.get("code_challenge"));
      const id_token = await new SignJWT({ nonce: changes.wrongNonce ? "wrong" : authorize.searchParams.get("nonce"), email: "test@example.invalid" })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer("https://auth.openai.com").setAudience(changes.wrongAudience ? "another-client" : client)
        .setSubject(changes.subject || "test-user").setIssuedAt().setExpirationTime("1h").sign(privateKey);
      return Response.json({ id_token, token_type: "Bearer", access_token: "test-access", refresh_token: "test-refresh", expires_in: 3600, scope: changes.noPlan ? "openid email" : granted });
    },
  };
  return { p, root, options, attempts, requests };
}

test("browser callback validates PKCE and identity, rejects wrong state, and saves private renewable access", async (t) => {
  const f = fixture(t, { invalidStateFirst: true });
  const result = await loginChatGPT(f.p, f.options);
  assert.equal(result.connected, true);
  const request = f.attempts[0].searchParams;
  assert.equal(request.get("client_id"), "dynamic_agent_client");
  assert.equal(request.get("agent_name_hint"), "Browse");
  assert.match(request.get("ext_agent_host_id"), /^urn:uuid:/);
  assert.equal(new URL(request.get("redirect_uri")).hostname, "127.0.0.1");
  const file = path.join(f.root, "chatgpt.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const saved = json(file);
  assert.equal(saved.active, "oaiapp_test");
  assert.equal(saved.accounts[0].subject, "test-user");
  assert.equal(saved.accounts[0].refresh_token, "test-refresh");
  atomic(f.p.auth, JSON.stringify({ model: "chatgpt/test-model" }));
  const credential = await auth(f.p);
  assert.equal(credential.provider, "openai");
  assert.equal(credential.chatgpt, true);
  assert.equal(credential.apiKey, "test-access");
  await loginChatGPT(f.p, f.options);
  assert.equal(f.attempts[1].searchParams.get("client_id"), "oaiapp_test");
  assert.equal(f.attempts[1].searchParams.get("agent_name_hint"), null);
  assert.equal(f.attempts[1].searchParams.get("ext_agent_host_id"), request.get("ext_agent_host_id"));
  assert.equal(f.attempts[1].searchParams.get("id_token_hint"), null);
});

test("new registrations stay separate and returning sign-in verifies the selected account", async (t) => {
  const f = fixture(t);
  await loginChatGPT(f.p, f.options);
  const other = fixture(t, { client: "oaiapp_other", subject: "other-user" });
  await loginChatGPT(f.p, { ...other.options, newAccount: true });
  const accounts = chatGPTAccounts(f.p);
  assert.equal(accounts.length, 2);
  assert.equal(accounts.find((a) => a.id === "oaiapp_other").active, true);
  assert.ok(accounts.every((a) => !Object.hasOwn(a, "access_token")));
  await loginChatGPT(f.p, { ...f.options, account: "oaiapp_test" });
  assert.equal(chatGPTAccounts(f.p).find((a) => a.id === "oaiapp_test").active, true);
  const switched = fixture(t, { subject: "unexpected-user" });
  const before = fs.readFileSync(path.join(f.root, "chatgpt.json"), "utf8");
  await assert.rejects(loginChatGPT(f.p, switched.options), /identity did not match/);
  assert.equal(fs.readFileSync(path.join(f.root, "chatgpt.json"), "utf8"), before);
});

for (const [label, changes, message] of [
  ["declined consent", { denied: true }, /declined or cancelled/],
  ["identity nonce mismatch", { wrongNonce: true }, /identity did not match/],
  ["wrong audience", { wrongAudience: true }, /identity verification failed/],
  ["identity without plan permission", { noPlan: true }, /plan usage was not authorized/],
]) test(`login rejects ${label} without saving access`, async (t) => {
  const f = fixture(t, changes);
  await assert.rejects(loginChatGPT(f.p, f.options), message);
  assert.equal(fs.existsSync(path.join(f.root, "chatgpt.json")), false);
});

test("login times out, closes its listener, and preserves existing credentials", async (t) => {
  const f = fixture(t);
  const file = path.join(f.root, "chatgpt.json");
  atomic(file, JSON.stringify({ accounts: [], active: null }));
  const before = fs.readFileSync(file, "utf8");
  let callback;
  await assert.rejects(loginChatGPT(f.p, {
    timeoutMs: 25,
    openURL: async (url) => { callback = new URL(url).searchParams.get("redirect_uri"); },
  }), /timed out/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  await assert.rejects(fetch(callback));
});

test("concurrent token refresh rotates once and model discovery uses the renewed account token", async (t) => {
  const f = fixture(t);
  await loginChatGPT(f.p, f.options);
  const file = path.join(f.root, "chatgpt.json");
  const saved = json(file);
  saved.accounts[0].expires_at = 0;
  atomic(file, JSON.stringify(saved));
  let refreshes = 0;
  const network = async (url, init) => {
    if (String(url).endsWith("/models")) {
      assert.equal(init.headers.Authorization, "Bearer renewed-access");
      return Response.json({ models: [
        { slug: "hidden", visibility: "hide" },
        { slug: "available-model", display_name: "Available Model", visibility: "list" },
      ] });
    }
    refreshes++;
    assert.equal(init.body.get("grant_type"), "refresh_token");
    assert.equal(init.body.get("client_id"), "oaiapp_test");
    assert.equal(init.body.get("refresh_token"), "test-refresh");
    assert.equal(init.body.get("resource"), "https://api.openai.com/v1");
    return Response.json({ token_type: "Bearer", access_token: "renewed-access", refresh_token: "rotated-refresh", expires_in: 3600 });
  };
  const credentials = await Promise.all(Array.from({ length: 3 }, () => chatGPTAuth(f.p, "chatgpt/test-model", network)));
  assert.equal(refreshes, 1);
  assert.ok(credentials.every((a) => a.apiKey === "renewed-access"));
  assert.equal(json(file).accounts[0].refresh_token, "rotated-refresh");
  assert.deepEqual(await chatGPTModels(f.p, network), [{ id: "available-model", name: "Available Model" }]);
});
