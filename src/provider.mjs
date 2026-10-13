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
    apiKey;
  const unsupported = "Unsupported provider. Choose google, openai, or anthropic.";
  if (provider && !Object.hasOwn(providers, provider)) throw Error(unsupported);
  if (!process.stdin.isTTY) {
    if (!provider || !model)
      throw Error("Noninteractive setup requires --provider and --model");
    apiKey = providers[provider]?.env.map((k) => process.env[k]).find(Boolean);
    if (!apiKey) throw Error("Set the provider API key environment variable");
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
      apiKey = await ask(
        `${provider} API key (hidden, Enter uses environment/saved key): `,
        true,
      );
      model ||= await ask(
        "Model ID (no default; choose a vision/tool-capable model): ",
      );
    } finally {
      rl.close();
    }
  }
  if (!Object.hasOwn(providers, provider)) throw Error(unsupported);
  if (!model.includes("/")) model = `${provider}/${model}`;
  if (!model.startsWith(provider + "/") || !/^\w+\/[\w.-]+$/.test(model))
    throw Error("Provider/model mismatch");
  const saved = json(p.auth, {});
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
