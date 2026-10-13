import test from "node:test";
import assert from "node:assert/strict";
import { createFxAgent } from "libfx";
import { providerOptions } from "../src/provider.mjs";

test("ChatGPT transport rejects a stream that ends without completed inference", async () => {
  let failure;
  const transport = providerOptions({
    provider: "openai", model: "chatgpt/test-model", apiKey: "fixture-access", chatgpt: true,
    onError: (error) => { failure = error; },
    fetch: async () => new Response(
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_partial","created_at":1,"model":"test-model"}}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    ),
  });
  const response = await transport.fetch("https://ai-gateway.vercel.sh/v4/ai/language-model", {
    method: "POST",
    body: JSON.stringify({ prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }] }),
  });
  await assert.rejects(response.text(), /inference did not complete/);
  assert.match(failure.message, /inference did not complete/);
});

for (const [provider, chatgpt] of [["google", false], ["openai", false], ["anthropic", false], ["openai", true]])
  test(`real libfx streams and restores through the ${chatgpt ? "ChatGPT OAuth" : provider} adapter`, async () => {
    let requests = 0;
    const transport = providerOptions({
      provider,
      chatgpt,
      apiKey: "private-test-key",
      model: `${chatgpt ? "chatgpt" : provider}/test-model`,
      fetch: async (url, init) => {
        requests++;
        if (chatgpt) {
          const body = JSON.parse(init.body);
          assert.equal(body.store, false);
          assert.equal(body.stream, true);
          assert.equal(new Headers(init.headers).get("authorization"), "Bearer private-test-key");
        }
        assert.equal(
          new URL(String(url)).hostname,
          {
            google: "generativelanguage.googleapis.com",
            openai: "api.openai.com",
            anthropic: "api.anthropic.com",
          }[provider],
        );
        if (provider === "google")
          return new Response(
            "data: " +
              JSON.stringify({
                candidates: [
                  {
                    content: { role: "model", parts: [{ text: "Hello" }] },
                    finishReason: "STOP",
                  },
                ],
                usageMetadata: {
                  promptTokenCount: 1,
                  candidatesTokenCount: 1,
                  totalTokenCount: 2,
                },
                modelVersion: "test-model",
              }) +
              "\n\n",
            { headers: { "content-type": "text/event-stream" } },
          );
        const events =
          provider === "openai"
            ? [
                {
                  type: "response.created",
                  response: {
                    id: "resp_1",
                    created_at: 1,
                    model: "test-model",
                  },
                },
                {
                  type: "response.output_item.added",
                  output_index: 0,
                  item: {
                    type: "message",
                    id: "msg_1",
                    role: "assistant",
                    content: [],
                  },
                },
                {
                  type: "response.output_text.delta",
                  item_id: "msg_1",
                  output_index: 0,
                  content_index: 0,
                  delta: "Hello",
                },
                {
                  type: "response.output_item.done",
                  output_index: 0,
                  item: {
                    type: "message",
                    id: "msg_1",
                    role: "assistant",
                    content: [
                      { type: "output_text", text: "Hello", annotations: [] },
                    ],
                  },
                },
                {
                  type: "response.completed",
                  response: {
                    id: "resp_1",
                    model: "test-model",
                    usage: { input_tokens: 1, output_tokens: 1 },
                    status: "completed",
                  },
                },
              ]
            : [
                {
                  type: "message_start",
                  message: {
                    id: "msg_1",
                    model: "test-model",
                    role: "assistant",
                    type: "message",
                    content: [],
                    usage: { input_tokens: 1, output_tokens: 0 },
                  },
                },
                {
                  type: "content_block_start",
                  index: 0,
                  content_block: { type: "text", text: "" },
                },
                {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: "Hello" },
                },
                { type: "content_block_stop", index: 0 },
                {
                  type: "message_delta",
                  delta: { stop_reason: "end_turn", stop_sequence: null },
                  usage: { output_tokens: 1 },
                },
                { type: "message_stop" },
              ];
        return new Response(
          events
            .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    let agent = await createFxAgent({
      ...transport,
      instructions: "Respond briefly.",
    });
    try {
      let answer = "";
      const turn = agent.prompt("Hi");
      for await (const e of turn)
        if (e.type === "text_delta") answer += e.delta;
      await turn.result;
      assert.equal(answer, "Hello");
      const checkpoint = await agent.checkpoint();
      assert.ok(checkpoint.length);
      await agent.close();
      agent = await createFxAgent({ ...transport, checkpoint });
      const next = agent.prompt("Again");
      let restored = "";
      for await (const e of next)
        if (e.type === "text_delta") restored += e.delta;
      await next.result;
      assert.equal(restored, "Hello");
      assert.equal(requests, 2);
      await assert.rejects(
        transport.fetch("https://example.com", { method: "POST" }),
        /Unexpected/,
      );
    } finally {
      await agent.close();
    }
  });
