import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { atomic, json } from "./util.mjs";
import { providerModels } from "./provider.mjs";

export const tokenProviders = ["vercel", "openai", "anthropic", "google", "xai", "openrouter", "custom"];
const endpoints = {
  vercel: "https://ai-gateway.vercel.sh/v1",
  xai: "https://api.x.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
};
export function tokenFile(profileHome = process.env.BROWSE_PROFILE_HOME || os.homedir()) {
  return path.join(profileHome, ".browse-fx", "browse-tokens.json");
}
export function endpointURL(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))))
    throw Error("Use an HTTPS API base URL, or HTTP on localhost.");
  return url.href.replace(/\/$/, "");
}
export async function saveToken({ provider, apiKey, endpoint, profileHome, network = globalThis.fetch }) {
  if (!tokenProviders.includes(provider) || !apiKey || /[\s\x00-\x1f]/.test(apiKey)) throw Error("Invalid provider or token.");
  let models;
  if (["openai", "anthropic", "google"].includes(provider)) models = await providerModels(provider, apiKey, network);
  else {
    endpoint = provider === "custom" ? endpointURL(endpoint) : endpoints[provider];
    const request = { headers: { authorization: `Bearer ${apiKey}` }, redirect: "error", signal: AbortSignal.timeout(20000) };
    if (provider === "openrouter") {
      const check = await network(`${endpoint}/key`, request);
      await check.body?.cancel();
      if (!check.ok) {
        const error = Error(`Provider token check failed (${check.status}).`);
        if ([400, 401, 403].includes(check.status)) error.code = "INVALID_API_KEY";
        throw error;
      }
    }
    const response = await network(provider === "vercel"
      ? "https://ai-gateway.vercel.sh/coding-agent/v1/models" : `${endpoint}/models`, request);
    if (!response.ok) {
      await response.body?.cancel();
      const error = Error(`Provider model check failed (${response.status}).`);
      if ([400, 401, 403].includes(response.status)) error.code = "INVALID_API_KEY";
      throw error;
    }
    const catalog = await response.json();
    if (!Array.isArray(catalog.data)) throw Error("Provider returned an invalid model list.");
    models = catalog.data.filter((model) => typeof model.id === "string" && /^[\w./:@+-]+$/.test(model.id) &&
      (!model.type || model.type === "language") &&
      (!model.supported_parameters || model.supported_parameters.includes("tools")) &&
      !/embedding|\btts\b|whisper|dall-e|image-generation|grok-imagine|video/i.test(model.id))
      .map((model) => ({ id: model.id, name: model.name || model.id,
        context_window: model.context_window || model.context_length,
        vision: model.tags?.includes("vision") || model.architecture?.input_modalities?.includes("image") }));
    if (!models.length) throw Error("No chat models with tools are available for this token.");
  }
  const file = tokenFile(profileHome), previous = json(file, {});
  const profile = { provider, apiKey, ...(endpoint ? { endpoint } : {}), models };
  atomic(file, JSON.stringify({ version: 1, active: provider, profiles: { ...previous.profiles, [provider]: profile } }));
  return profile;
}
export function tokenCatalog(profileHome) {
  const saved = json(tokenFile(profileHome), {});
  return { data: Object.values(saved.profiles || {}).flatMap((profile) => profile.models.map((model) => ({
    id: `${profile.provider}/${model.id}`, name: model.name, type: "language", owned_by: profile.provider,
    tags: ["tool-use", ...((model.vision || ["openai", "anthropic", "google"].includes(profile.provider)) ? ["vision"] : [])],
    context_window: model.context_window,
  }))) };
}
export function resolveToken(model, profileHome) {
  const split = model.indexOf("/"), provider = model.slice(0, split), id = model.slice(split + 1);
  const profile = json(tokenFile(profileHome), {}).profiles?.[provider];
  if (!profile || !profile.models.some((model) => model.id === id)) return null;
  return { ...profile, model: id, models: undefined };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > 16384) throw Error("Input too large");
    }
    const input = JSON.parse(Buffer.concat(chunks).toString());
    if (input.op === "save") {
      await saveToken(input);
      process.stdout.write("accepted");
    } else if (input.op === "catalog") process.stdout.write(JSON.stringify(tokenCatalog()));
    else if (input.op === "endpoint") process.stdout.write(endpointURL(input.endpoint));
    else throw Error("Unknown operation");
  } catch (error) {
    // Provider responses and tokens never enter the terminal or process arguments.
    process.stdout.write(error.code === "INVALID_API_KEY" ? "refused" : "unavailable");
    process.exitCode = 1;
  }
}
