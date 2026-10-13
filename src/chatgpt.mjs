import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { atomic, json, mkdir } from "./util.mjs";
import { Neo } from "./neo.mjs";

const issuer = "https://auth.openai.com";
const resource = "https://api.openai.com/v1";
const scopes = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const files = (p) => ({
  accounts: path.join(path.dirname(p.auth), "chatgpt.json"),
  host: path.join(path.dirname(p.auth), "chatgpt-host.json"),
  lock: path.join(path.dirname(p.auth), "chatgpt.lock"),
});

export function chatGPTAccounts(p) {
  const saved = json(files(p).accounts, { accounts: [] });
  return saved.accounts.map((a) => ({
    id: a.client_id, account: a.email || a.subject, active: a.client_id === saved.active,
  }));
}

async function locked(p, operation) {
  const { lock } = files(p);
  mkdir(path.dirname(lock));
  const deadline = Date.now() + 30000;
  let fd;
  for (;;) {
    try {
      fd = fs.openSync(lock, "wx", 0o600);
      fs.writeFileSync(fd, String(process.pid));
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        const pid = Number(fs.readFileSync(lock, "utf8"));
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); }
          catch (error) {
            if (error.code === "ESRCH") fs.rmSync(lock, { force: true });
          }
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (Date.now() >= deadline) throw Error("Another Browse process is updating the ChatGPT connection; try again.");
      await delay(100);
    }
  }
  try { return await operation(); }
  finally { fs.closeSync(fd); fs.rmSync(lock, { force: true }); }
}

async function providerJson(url, init, network) {
  let response;
  try {
    response = await network(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([AbortSignal.timeout(20000), ...(init?.signal ? [init.signal] : [])]),
    });
  } catch {
    throw Error("Could not reach ChatGPT; check your connection and try browse login.");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw Error(`ChatGPT request failed (${response.status}); run browse login to reconnect.`);
  }
  return response.json();
}

function tokenRecord(tokens, previous = {}) {
  const granted = tokens.scope === undefined && previous.scopes
    ? previous.scopes : String(tokens.scope || "").split(/\s+/);
  if (!granted.includes("chatgpt.tokens.use.direct") || !granted.includes("resource.invoke"))
    throw Error("ChatGPT plan usage was not authorized. Run browse login and allow plan usage, or use browse setup with an API key.");
  if (tokens.token_type?.toLowerCase() !== "bearer" || !tokens.access_token ||
      !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0)
    throw Error("ChatGPT returned an invalid token response; run browse login again.");
  const refresh = tokens.refresh_token || previous.refresh_token;
  if (!refresh) throw Error("ChatGPT did not return renewable access; run browse login again.");
  return {
    ...previous,
    access_token: tokens.access_token,
    refresh_token: refresh,
    id_token: tokens.id_token || previous.id_token,
    scopes: granted,
    expires_at: Date.now() + tokens.expires_in * 1000,
  };
}

export async function openLoginPage(url) {
  const neo = new Neo();
  const signal = AbortSignal.timeout(15000);
  await neo.connect(signal);
  const named = await neo.call("name_session", {
    name: "browse login", category: "dev-tools", summary: "Sign Browse into the model provider",
  }, signal);
  if (named.isError) throw Error("Neo could not start the login session.");
  const result = await neo.call("run", {
    code: `await browser.pages.list(); await browser.open(${JSON.stringify(url)}); return "Login page opened";`,
  }, signal);
  if (result.isError || result.structuredContent?.ok === false)
    throw Error("Neo could not open the login page.");
}

// Official public-client flow: loopback callback, PKCE, and verified OIDC identity.
export async function loginChatGPT(p, options = {}) {
  const network = options.fetch || globalThis.fetch;
  const store = files(p);
  const hostId = await locked(p, () => {
    const saved = json(store.host, {});
    if (saved.host_id) return saved.host_id;
    const host_id = `urn:uuid:${randomUUID()}`;
    atomic(store.host, JSON.stringify({ host_id }));
    return host_id;
  });
  const saved = json(store.accounts, { accounts: [] });
  const previous = options.newAccount ? undefined
    : saved.accounts.find((a) => a.client_id === (options.account || saved.active));
  if (options.account && !previous) throw Error("Unknown ChatGPT account; use browse login --list or browse login --new-account.");
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const attempt = new AbortController();
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), {
    [customFetch]: (url, init) => network(url, {
      ...init, redirect: "error", signal: AbortSignal.any([init.signal, attempt.signal]),
    }),
  });
  let accept, reject, handled = false;
  const completed = new Promise((resolve, fail) => { accept = resolve; reject = fail; });
  // Attach a handler before opening the browser so cancellation cannot be unhandled.
  completed.catch(() => {});
  let redirect;
  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    let callback;
    try { callback = new URL(req.url, "http://127.0.0.1"); }
    catch { res.writeHead(400); res.end("Invalid callback URL."); return; }
    if (req.method !== "GET" || callback.pathname !== "/auth/callback") {
      res.writeHead(404); res.end("Not found"); return;
    }
    if (handled || callback.searchParams.get("state") !== state) {
      res.writeHead(400); res.end("Invalid or expired login callback."); return;
    }
    handled = true;
    try {
      if (callback.searchParams.has("error")) throw Error("ChatGPT sign-in was declined or cancelled. Run browse login to try again.");
      const code = callback.searchParams.get("code");
      const clientId = callback.searchParams.get("client_id") || previous?.client_id;
      if (!code || !clientId || clientId === "dynamic_agent_client" ||
          (previous && clientId !== previous.client_id))
        throw Error("ChatGPT registration was incomplete or changed account; run browse login --new-account.");
      const tokens = await providerJson(`${issuer}/api/accounts/oauth/token`, {
        method: "POST", signal: attempt.signal,
        body: new URLSearchParams({
          grant_type: "authorization_code", client_id: clientId,
          code, code_verifier: verifier, redirect_uri: redirect, resource,
        }),
      }, network);
      if (!tokens.id_token) throw Error("ChatGPT did not return a verified identity.");
      let identity;
      try {
        ({ payload: identity } = await jwtVerify(tokens.id_token, jwks, {
          issuer, audience: clientId, algorithms: ["RS256"],
          requiredClaims: ["sub", "exp", "iat", "nonce"], clockTolerance: 5,
        }));
      } catch { throw Error("ChatGPT identity verification failed; run browse login again."); }
      if (identity.nonce !== nonce || (previous && identity.sub !== previous.subject))
        throw Error("ChatGPT identity did not match this sign-in attempt.");
      const account = tokenRecord(tokens, {
        client_id: clientId, subject: identity.sub, email: identity.email,
        issuer, ext_agent_host_id: hostId,
      });
      await locked(p, () => {
        attempt.signal.throwIfAborted();
        const latest = json(store.accounts, { accounts: [] });
        latest.accounts = latest.accounts.filter((a) => a.client_id !== clientId);
        latest.accounts.push(account);
        latest.active = clientId;
        atomic(store.accounts, JSON.stringify(latest, null, 2));
      });
      res.end("Browse is connected to ChatGPT. Return to your terminal to choose a model.");
      accept({ connected: true, account: account.email || account.subject });
    } catch (e) {
      res.writeHead(400);
      res.end("Browse could not complete sign-in. Return to the terminal for details.");
      reject(e);
    }
  });
  await new Promise((resolve, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", resolve);
  });
  redirect = `http://127.0.0.1:${server.address().port}/auth/callback`;
  const authorize = new URL(`${issuer}/api/accounts/authorize`);
  authorize.search = new URLSearchParams({
    client_id: previous?.client_id || "dynamic_agent_client",
    // Omit ID-token hints so browser-tool audit logs and the manual link contain no tokens.
    ...(!previous ? { agent_name_hint: "Browse" } : {}),
    ext_agent_host_id: hostId, response_type: "code", redirect_uri: redirect,
    scope: scopes, resource, state, nonce,
    code_challenge_method: "S256", code_challenge: challenge,
  }).toString();
  const stop = (error) => { attempt.abort(error); reject(error); };
  const cancel = () => stop(Error("ChatGPT sign-in cancelled."));
  process.once("SIGINT", cancel);
  const timer = setTimeout(() => stop(Error("ChatGPT sign-in timed out; run browse login to try again.")), options.timeoutMs || 300000);
  try {
    const url = authorize.toString();
    options.onURL?.(url);
    try { await (options.openURL || openLoginPage)(url); }
    catch {
      if (!options.onURL) throw Error("Could not open BrowserOS Neo. Start Neo, then run browse login.");
      options.onBrowserError?.();
    }
    return await completed;
  } finally {
    clearTimeout(timer);
    attempt.abort();
    process.off("SIGINT", cancel);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

export async function chatGPTAuth(p, model, network = globalThis.fetch) {
  return locked(p, async () => {
    const { accounts: file } = files(p);
    const saved = json(file, { accounts: [] });
    let account = saved.accounts.find((a) => a.client_id === saved.active);
    if (!account?.access_token) throw Error("Run browse login to connect your ChatGPT account.");
    if (!account.scopes?.includes("chatgpt.tokens.use.direct"))
      throw Error("Run browse login and authorize ChatGPT plan usage.");
    if (!Number.isFinite(account.expires_at) || account.expires_at < Date.now() + 60000) {
      const tokens = await providerJson(`${issuer}/api/accounts/oauth/token`, {
        method: "POST", body: new URLSearchParams({
          grant_type: "refresh_token", client_id: account.client_id,
          refresh_token: account.refresh_token, resource,
        }),
      }, network);
      account = tokenRecord(tokens, account);
      saved.accounts = saved.accounts.map((a) => a.client_id === account.client_id ? account : a);
      atomic(file, JSON.stringify(saved, null, 2));
    }
    return { provider: "openai", model, apiKey: account.access_token, chatgpt: true };
  });
}

export async function chatGPTModels(p, network = globalThis.fetch) {
  const { apiKey } = await chatGPTAuth(p, undefined, network);
  const catalog = await providerJson(`${resource}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  }, network);
  const models = (catalog.models || []).filter((m) => m.visibility === "list" && /^[\w.-]+$/.test(m.slug));
  if (!models.length) throw Error("ChatGPT returned no available models for this account.");
  return models.map((m) => ({ id: m.slug, name: m.display_name || m.slug }));
}
