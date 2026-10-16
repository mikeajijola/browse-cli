import os from "node:os";
import path from "node:path";
import { atomic, hash, json } from "./util.mjs";
import { providerOptions } from "./provider.mjs";
import { createSubscriptionAuthorizer } from "./vendor/fx/subscription.js";
import { codexSubscription } from "./vendor/fx/chatgpt.js";
import { grokSubscription } from "./vendor/fx/grok.js";

export function frontendAuth(p, model) {
  const file = path.join(p.private, "frontend-credentials", hash(model) + ".json");
  const credential = json(file, null);
  if (!credential || (!credential.apiKey && credential.configured?.auth?.type !== "none")) throw Error("Open browse and connect a provider with /setup to reconnect this run.");
  return { ...credential, model, frontend: { file, model: credential.model } };
}

export function frontendProviderOptions(options) {
  const network = options.fetch || globalThis.fetch;
  if (options.tokenProvider) {
    const provider = options.tokenProvider;
    if (["openai", "anthropic", "google"].includes(provider)) return providerOptions({ ...options,
      frontend: undefined, provider, model: `${provider}/${options.tokenModel}` });
    if (provider === "vercel") return frontendProviderOptions({ ...options, tokenProvider: undefined,
      provider: "gateway", frontend: { ...options.frontend, model: options.tokenModel } });
    if (["xai", "openrouter", "custom"].includes(provider)) return frontendProviderOptions({ ...options,
      tokenProvider: undefined, frontend: { ...options.frontend, model: options.tokenModel },
      configured: { protocol: "openai-chat-completions", base_url: options.tokenEndpoint,
        auth: { type: "bearer" }, tool_choice_mode: "send" } });
    throw Error("Unsupported Browse token provider");
  }
  if (options.configured) {
    const definition = options.configured;
    if (definition.protocol !== "openai-chat-completions") throw Error("Unsupported configured provider protocol");
    const endpoint = new URL(definition.base_url);
    if (endpoint.username || endpoint.password || (endpoint.protocol !== "https:" &&
        !(endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)))) throw Error("Invalid configured provider URL");
    return providerOptions({ ...options, frontend: undefined, provider: "openai", apiKey: options.apiKey || "no-auth",
      model: `openai/${options.frontend.model}`, baseURL: definition.base_url.replace(/\/$/, ""), chatCompletions: true,
      fetch: (url, init) => {
        const headers = new Headers(init.headers);
        if (definition.auth?.type === "none") headers.delete("authorization");
        const body = JSON.parse(init.body);
        if (definition.tool_choice_mode !== "send") delete body.tool_choice;
        return network(url, { ...init, headers, body: JSON.stringify(body), redirect: "error" });
      },
    });
  }
  const profileHome = options.profileHome || process.env.BROWSE_PROFILE_HOME || os.homedir();
  const gatewaySessionFile = path.join(profileHome, ".browse-fx", "auth.json");
  let refreshing;
  const gatewayKey = async (force = false) => {
    const cached = options.frontend.file ? json(options.frontend.file, options) : options;
    const current = json(gatewaySessionFile, null);
    const previous = cached.oauthSession;
    const sameAccount = previous && current?.issuer === previous.issuer && current?.client_id === previous.client_id && current?.team_id === previous.team_id;
    const session = sameAccount ? current : previous || (current?.access_token === cached.apiKey ? current : null);
    if (!session || session.issuer !== "https://vercel.com") return cached.apiKey;
    if (!force && session.expires_at_ms > Date.now() + 60000) return session.access_token;
    refreshing ||= (async () => {
      const response = await network("https://vercel.com/oauth/token", {
        method: "POST", redirect: "error", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: session.client_id, grant_type: "refresh_token", refresh_token: session.refresh_token }).toString(),
      });
      if (!response.ok) { await response.body?.cancel(); throw Error(`Vercel connection refresh failed (${response.status}); reconnect with /setup.`); }
      const tokens = await response.json();
      if (typeof tokens.access_token !== "string" || !tokens.access_token || !Number.isFinite(tokens.expires_in)) throw Error("Vercel returned an invalid connection refresh.");
      const latest = json(gatewaySessionFile, null);
      const renewed = { ...session, access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || session.refresh_token, expires_at_ms: Date.now() + tokens.expires_in * 1000 };
      if (latest?.access_token === session.access_token) atomic(gatewaySessionFile, JSON.stringify(renewed));
      atomic(options.frontend.file, JSON.stringify({ ...cached, apiKey: tokens.access_token, oauthSession: renewed }));
      return tokens.access_token;
    })().finally(() => { refreshing = undefined; });
    return refreshing;
  };
  if (options.provider === "gateway") return {
    apiKey: options.apiKey,
    model: options.frontend.model,
    effort: options.settings?.effort,
    fast: options.settings?.fast_mode,
    ultrafast: options.settings?.ultrafast_mode,
    fetch: async (url, init) => {
      if (new URL(String(url)).origin !== "https://ai-gateway.vercel.sh") throw Error("Provider destination denied");
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${await gatewayKey()}`);
      if (options.team) headers.set("x-vercel-ai-gateway-team", options.team);
      if (options.disableTools?.() && init?.body) {
        const body = JSON.parse(Buffer.from(init.body).toString());
        body.tools = []; body.toolChoice = { type: "none" };
        init = { ...init, body: JSON.stringify(body) };
      }
      const response = await network(url, { ...init, headers, redirect: "error" });
      if (response.status !== 401) return response;
      const previous = headers.get("authorization");
      const renewed = await gatewayKey(true);
      if (previous === `Bearer ${renewed}`) return response;
      await response.body?.cancel();
      headers.set("authorization", `Bearer ${renewed}`);
      return network(url, { ...init, headers, redirect: "error" });
    },
  };
  const codex = options.provider === "codex";
  const endpoint = codex ? "https://chatgpt.com/backend-api/codex/responses" : "https://cli-chat-proxy.grok.com/v1/responses";
  const sessionFile = path.join(profileHome, ".browse-fx", codex ? "chatgpt-auth.json" : "grok-auth.json");
  const load = () => {
    const session = json(sessionFile, {});
    const cached = json(options.frontend.file, options);
    if (session.account_id === options.accountId && session.access_token) return {
      accessToken: session.access_token, refreshToken: session.refresh_token,
      accountId: session.account_id, expiresAt: session.expires_at_ms,
    };
    return { accessToken: cached.apiKey, refreshToken: cached.refreshToken,
      accountId: cached.accountId, expiresAt: cached.expiresAt };
  };
  const authorizer = createSubscriptionAuthorizer([codex ? codexSubscription : grokSubscription], {
    fetch: network, credentials: load,
    onCredentials: async (next) => {
      atomic(options.frontend.file, JSON.stringify({ ...json(options.frontend.file, options),
        apiKey: next.accessToken, refreshToken: next.refreshToken, expiresAt: next.expiresAt }));
      const current = json(sessionFile, {});
      if (current.account_id === next.accountId) atomic(sessionFile, JSON.stringify({ ...current,
        access_token: next.accessToken, refresh_token: next.refreshToken, expires_at_ms: next.expiresAt }));
    },
  });
  return providerOptions({ ...options, frontend: undefined,
    provider: "openai", apiKey: "frontend-subscription", model: `openai/${options.frontend.model}`,
    fetch: async (url, init) => {
      if (String(url) !== "https://api.openai.com/v1/responses") throw Error("Unexpected subscription request");
      const body = JSON.parse(init.body);
      body.store = false;
      if (codex) {
        body.instructions ||= "You are Browse, a browser assistant.";
        delete body.max_output_tokens; delete body.temperature; delete body.top_p;
      }
      return authorizer.fetch(authorizer.specFor(endpoint), endpoint, network, endpoint, { ...init, body: JSON.stringify(body), redirect: "error" });
    },
  });
}
