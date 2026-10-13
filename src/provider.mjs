import fs from "node:fs";
import readline from "node:readline";
import { Writable } from "node:stream";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { atomic, json } from "./util.mjs";
import { googleToolSchema } from "./google-tool-schema.mjs";
import { chatGPTAuth } from "./chatgpt.mjs";

const providers = {
  google: {
    origin: "https://generativelanguage.googleapis.com",
    env: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
  },
  openai: { origin: "https://api.openai.com", env: ["OPENAI_API_KEY"] },
  anthropic: {
    origin: "https://api.anthropic.com",
    env: ["ANTHROPIC_API_KEY"],
  },
};

export async function providerModels(provider, apiKey, network = globalThis.fetch) {
  if (!Object.hasOwn(providers, provider)) throw Error("Unsupported provider");
  if (!apiKey || /[\s\x00-\x1f]/.test(apiKey)) throw Error("Invalid or missing API key");
  const url = new URL(provider === "google"
    ? `${providers[provider].origin}/v1beta/models`
    : `${providers[provider].origin}/v1/models`);
  const headers = provider === "google" ? { "x-goog-api-key": apiKey }
    : provider === "anthropic" ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
    : { Authorization: `Bearer ${apiKey}` };
  const models = new Map(), cursors = new Set();
  const signal = AbortSignal.timeout(20000);
  for (;;) {
    let response;
    try { response = await network(url.toString(), { headers, redirect: "error", signal }); }
    catch { throw Error(`Could not load ${provider} models. Check your connection and try again.`); }
    if (!response.ok) {
      await response.body?.cancel();
      const error = Error(`Could not load ${provider} models (${response.status}). ${[400, 401, 403].includes(response.status) ? "Check your API key and account access." : "Try again later."}`);
      if ([400, 401, 403].includes(response.status)) error.code = "INVALID_API_KEY";
      throw error;
    }
    const catalog = await response.json();
    const entries = provider === "google" ? catalog.models : catalog.data;
    if (!Array.isArray(entries)) throw Error(`${provider} returned an invalid model list.`);
    for (const entry of entries) {
      const id = provider === "google" ? entry.name?.replace(/^models\//, "") : entry.id;
      if (!id || !/^[\w.-]+$/.test(id)) continue;
      if (provider === "google" && (!entry.supportedGenerationMethods?.includes("generateContent") ||
          !id.startsWith("gemini-") || /image|tts|audio|live|robotics/i.test(id))) continue;
      if (provider === "openai" && (!/^(gpt-|o[1-9])/.test(id) ||
          /instruct|audio|realtime|transcribe|tts|image|search/i.test(id))) continue;
      if (provider === "anthropic" && entry.capabilities?.image_input?.supported === false) continue;
      models.set(id, { id, name: entry.displayName || entry.display_name || id });
    }
    const cursor = provider === "google" ? catalog.nextPageToken
      : provider === "anthropic" && catalog.has_more ? catalog.last_id : undefined;
    if (!cursor) {
      if (provider === "anthropic" && catalog.has_more) throw Error("Anthropic returned incomplete model pagination.");
      break;
    }
    if (cursors.has(cursor)) throw Error(`${provider} returned repeated model pagination.`);
    cursors.add(cursor);
    url.searchParams.set(provider === "google" ? "pageToken" : "after_id", cursor);
  }
  if (!models.size) throw Error(`No browser-chat models are available for this ${provider} API key.`);
  return [...models.values()];
}

export async function auth(p, model) {
  const saved = json(p.auth, {});
  model ||= saved.model;
  if (!model || !/^([a-z]+)\/[\w.-]+$/.test(model))
    throw Error("Run browse setup to choose a provider and enter its API key, or browse login for ChatGPT.");
  const [provider] = model.split("/"),
    spec = providers[provider];
  if (provider === "chatgpt") return chatGPTAuth(p, model);
  if (!Object.hasOwn(providers, provider))
    throw Error("Supported providers: chatgpt, google, openai, anthropic");
  const apiKey =
    spec.env.map((key) => process.env[key]).find(Boolean) ||
    saved.credentials?.[provider];
  if (!apiKey) throw Error(`Missing ${provider} API key; run browse setup`);
  return { provider, model, apiKey };
}
export async function setup(p, options = {}) {
  let provider = options.provider?.trim().toLowerCase(),
    model = options.model,
    apiKey = options.apiKey;
  const saved = json(p.auth, {});
  const savedKey = () => providers[provider].env.map((k) => process.env[k]).find(Boolean) || saved.credentials?.[provider];
  const unsupported = "Unsupported provider. Choose google, openai, or anthropic.";
  if (provider && !Object.hasOwn(providers, provider)) throw Error(unsupported);
  if (!process.stdin.isTTY) {
    if (!provider || !model)
      throw Error("Noninteractive setup requires --provider and --model");
    apiKey ||= savedKey();
    if (!apiKey) throw Error("Set the provider API key environment variable");
    const models = await providerModels(provider, apiKey, options.fetch);
    const id = model.replace(new RegExp(`^${provider}/`), "");
    if (!models.some((m) => m.id === id)) throw Error(`Model ${model} is not available for ${provider}. Run browse to choose from the available models.`);
  } else {
    let hidden = false;
    const echo = new Writable({
      write(chunk, encoding, cb) {
        if (!hidden) process.stdout.write(chunk, encoding);
        cb();
      },
    });
    echo.isTTY = true;
    echo.columns = process.stdout.columns;
    const rl = readline.createInterface({
      input: process.stdin,
      output: echo,
      terminal: true,
    });
    const ask = (label, secret = false) =>
      new Promise((resolve, reject) => {
        process.stdout.write(label);
        hidden = secret;
        const cancel = () => {
          hidden = false;
          reject(Error("Setup cancelled"));
        };
        rl.once("close", cancel);
        rl.question("", (answer) => {
          rl.off("close", cancel);
          hidden = false;
          if (secret) {
            rl.history = [];
            process.stdout.write("\n");
          }
          resolve(answer.trim());
        });
      });
    try {
      const choices = Object.keys(providers);
      if (!provider) {
        process.stdout.write("Choose your AI provider:\n  1. Google / Gemini\n  2. OpenAI\n  3. Anthropic / Claude\n");
      }
      while (!provider) {
        const answer = (
          await ask("Provider number or name (google/openai/anthropic): ")
        ).toLowerCase();
        if (Object.hasOwn(providers, answer)) provider = answer;
        else if (/^[1-3]$/.test(answer)) provider = choices[Number(answer) - 1];
        else if (answer === "gemini") provider = "google";
        else if (answer === "claude") provider = "anthropic";
        else process.stdout.write(`${unsupported}\n`);
      }
      if (!apiKey) apiKey = await ask(
        `${provider} API key (hidden, Enter uses environment/saved key): `, true,
      );
      apiKey ||= savedKey();
      process.stdout.write("Loading available models…\n");
      const models = options.models || await providerModels(provider, apiKey, options.fetch);
      process.stdout.write("Choose a model for browser chat:\n");
      models.forEach((m, i) => process.stdout.write(`  ${i + 1}. ${m.name} (${m.id})\n`));
      let selected = model && models.find((m) => m.id === model.replace(new RegExp(`^${provider}/`), ""));
      while (!selected) {
        const answer = await ask("Model number or ID: ");
        selected = models.find((m) => m.id === answer || `${provider}/${m.id}` === answer) ||
          (/^\d+$/.test(answer) ? models[Number(answer) - 1] : undefined);
        if (!selected) process.stdout.write("Choose a model from the list above. Browser tasks go at browse › after setup.\n");
      }
      model = selected.id;
    } finally {
      rl.close();
    }
  }
  if (!Object.hasOwn(providers, provider)) throw Error(unsupported);
  if (!model.includes("/")) model = `${provider}/${model}`;
  if (!model.startsWith(provider + "/") || !/^\w+\/[\w.-]+$/.test(model))
    throw Error("Provider/model mismatch");
  apiKey ||=
    providers[provider].env.map((k) => process.env[k]).find(Boolean) ||
    saved.credentials?.[provider];
  if (!apiKey || /[\s\x00-\x1f]/.test(apiKey))
    throw Error("Invalid or missing API key");
  atomic(
    p.auth,
    JSON.stringify(
      { model, credentials: { ...saved.credentials, [provider]: apiKey } },
      null,
      2,
    ),
  );
  return { configured: true, model };
}
export function providerOptions(options) {
  const { provider, apiKey } = options,
    modelId = options.model.split("/")[1],
    spec = providers[provider];
  const network = options.fetch || globalThis.fetch;
  const guardedFetch = (url, init) => {
    if (new URL(String(url)).origin !== spec.origin)
      throw Error("Provider destination denied");
    return network(url, { ...init, redirect: "error" });
  };
  const model =
    provider === "google"
      ? createGoogleGenerativeAI({ apiKey, fetch: guardedFetch })(modelId)
      : provider === "openai"
        ? createOpenAI({ apiKey, fetch: guardedFetch }).responses(modelId)
        : createAnthropic({ apiKey, fetch: guardedFetch })(modelId);
  return {
    apiKey: "direct-provider-transport",
    model: options.model,
    fetch: async (url, init) => {
      if (String(url) === "https://ai-gateway.vercel.sh/coding-agent/v1/models")
        return Response.json({
          data: [
            {
              id: options.model,
              type: "language",
              tags: ["vision", "tool-use"],
              modalities: { input: ["text", "image"], output: ["text"] },
            },
          ],
        });
      if (
        String(url) !== "https://ai-gateway.vercel.sh/v4/ai/language-model" ||
        init?.method !== "POST"
      )
        throw Error("Unexpected libfx transport request");
      const body = JSON.parse(Buffer.from(init.body).toString());
      if (options.disableTools?.()) {
        body.tools = [];
        body.toolChoice = { type: "none" };
      }
      try {
        const { stream } = await model.doStream({
          ...body,
          ...(options.chatgpt ? {
            providerOptions: {
              ...body.providerOptions,
              openai: { ...body.providerOptions?.openai, store: false },
            },
          } : {}),
          ...(provider === "google" && body.tools
            ? {
                tools: body.tools.map((t) =>
                  t.type === "function"
                    ? { ...t, inputSchema: googleToolSchema(t.inputSchema) }
                    : t,
                ),
              }
            : {}),
          abortSignal: init.signal,
          maxOutputTokens: 16000,
        });
        return new Response(
          stream.pipeThrough(
            new TransformStream({
              transform(part, controller) {
                if (part.type === "error")
                  throw Error("Provider stream failed");
                if (options.chatgpt && part.type === "finish" &&
                    !["stop", "tool-calls"].includes(part.finishReason?.unified)) {
                  const error = Error("ChatGPT inference did not complete; try again or run browse login.");
                  options.onError?.(error);
                  throw error;
                }
                controller.enqueue(
                  new TextEncoder().encode(`data: ${JSON.stringify(part)}\n\n`),
                );
              },
            }),
          ),
          { headers: { "content-type": "text/event-stream" } },
        );
      } catch (e) {
        if (init.signal?.aborted) throw init.signal.reason;
        options.onError?.(
          new Error(
            `Provider request failed (${e.statusCode || 400}): ${String(
              e.message || "unknown error",
            )
              .replaceAll(apiKey, "[redacted]")
              .slice(0, 500)}`,
          ),
        );
        return new Response(
          `Provider request failed (${e.statusCode || 400}); check credentials and model.`,
          {
            status:
              e.statusCode >= 400 && e.statusCode <= 599 ? e.statusCode : 400,
          },
        );
      }
    },
  };
}
