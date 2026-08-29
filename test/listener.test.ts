import assert from "node:assert/strict";
import test from "node:test";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { AgixClient } from "../src/client.js";
import {
  assertChannelRuntime,
  filterPublicAgixReplyPayload,
  listen,
  parseConversationTarget,
  privateAgentPrompt,
} from "../src/listener.js";
import type { Agent, Message } from "../src/types.js";

const message: Message = {
  id: "msg_1",
  conversation_id: "conv_1",
  author: "maria/calendar",
  content: "Can our humans meet?",
  created_at: "2026-08-27T12:00:00.000Z",
  processed: false,
};

const agent: Agent = {
  address: "jp/calendar",
  name: "calendar",
  owner: { handle: "jp", name: "Jay", about: "" },
  about: "Coordinates meetings for Jay.",
  connected: true,
  instructions: "Use Jay's calendar and ask before creating an event.",
};

test("dispatches, delivers, and only then marks a message processed", async () => {
  const controller = new AbortController();
  const events: string[] = [];
  const sessionKeys: string[] = [];
  const systemPrompts: string[] = [];
  const client = {
    inbox: async () => ({ messages: [message], next_cursor: null }),
    agent: async () => agent,
    send: async () => {
      events.push("send");
      return { id: "msg_2", author: agent.address, content: "Yes", created_at: message.created_at };
    },
    conversationAfter: async () => ({
      conversation: { id: message.conversation_id, participants: [agent.address, message.author], created_at: message.created_at, updated_at: message.created_at },
      messages: [{ id: "msg_2", author: agent.address, content: "Yes", created_at: message.created_at }],
      next_cursor: null,
    }),
    process: async () => {
      events.push("process");
      controller.abort();
    },
  } as unknown as AgixClient;
  const runtime = fakeRuntime(events, { sessionKeys, systemPrompts });

  await listen({
    cfg: {} as OpenClawConfig,
    accountId: "calendar",
    agentName: "calendar",
    client,
    runtime,
    signal: controller.signal,
    log: silentLog,
  });

  assert.deepEqual(events, ["dispatch", "send", "process"]);
  assert.deepEqual(sessionKeys, ["agent:main:agix:calendar:direct:conv_1"]);
  assert.deepEqual(systemPrompts, [privateAgentPrompt(agent)]);
});

test("leaves a message pending when reply delivery fails", async () => {
  const controller = new AbortController();
  const events: string[] = [];
  const client = {
    inbox: async () => ({ messages: [message], next_cursor: null }),
    agent: async () => agent,
    send: async () => { events.push("send"); throw new Error("delivery failed"); },
    conversationAfter: async () => { throw new Error("should not inspect after failed delivery"); },
    process: async () => { events.push("process"); },
  } as unknown as AgixClient;
  const runtime = fakeRuntime(events);
  await listen({
    cfg: {} as OpenClawConfig,
    accountId: "calendar",
    agentName: "calendar",
    client,
    runtime,
    signal: controller.signal,
    log: {
      ...silentLog,
      error: () => controller.abort(),
    },
  });
  assert.deepEqual(events, ["dispatch", "send"]);
});

test("leaves a message pending when a turn produces no agix reply", async () => {
  const controller = new AbortController();
  const events: string[] = [];
  const client = {
    inbox: async () => ({ messages: [message], next_cursor: null }),
    agent: async () => agent,
    conversationAfter: async () => ({
      conversation: { id: message.conversation_id, participants: [agent.address, message.author], created_at: message.created_at, updated_at: message.created_at },
      messages: [],
      next_cursor: null,
    }),
    process: async () => { events.push("process"); },
  } as unknown as AgixClient;

  await listen({
    cfg: {} as OpenClawConfig,
    accountId: "calendar",
    agentName: "calendar",
    client,
    runtime: fakeRuntime(events, { deliver: false }),
    signal: controller.signal,
    log: { ...silentLog, error: () => controller.abort() },
  });

  assert.deepEqual(events, ["dispatch"]);
});

test("suppresses OpenClaw runtime notices and leaves the message pending", async () => {
  const controller = new AbortController();
  const events: string[] = [];
  const client = {
    inbox: async () => ({ messages: [message], next_cursor: null }),
    agent: async () => agent,
    send: async () => { events.push("send"); throw new Error("should not send runtime notices"); },
    conversationAfter: async () => ({
      conversation: { id: message.conversation_id, participants: [agent.address, message.author], created_at: message.created_at, updated_at: message.created_at },
      messages: [],
      next_cursor: null,
    }),
    process: async () => { events.push("process"); },
  } as unknown as AgixClient;

  await listen({
    cfg: {} as OpenClawConfig,
    accountId: "calendar",
    agentName: "calendar",
    client,
    runtime: fakeRuntime(events, { payload: { text: "internal failure", isError: true } }),
    signal: controller.signal,
    log: { ...silentLog, error: () => controller.abort() },
  });

  assert.deepEqual(events, ["dispatch"]);
});

test("filters only internal OpenClaw payload classes", () => {
  const reply = { text: "Tuesday at 2 PM works." };
  assert.equal(filterPublicAgixReplyPayload(reply), reply);
  for (const flag of [
    "isError",
    "isStatusNotice",
    "isFallbackNotice",
    "isCompactionNotice",
    "isReasoning",
    "isCommentary",
  ] as const) {
    assert.equal(filterPublicAgixReplyPayload({ text: "internal", [flag]: true }), null);
  }
});

test("normalizes conversation targets and keeps private instructions private", () => {
  assert.equal(parseConversationTarget("agix:conversation:conv_abc-123"), "conv_abc-123");
  assert.equal(parseConversationTarget("conv_abc"), "conv_abc");
  assert.throws(() => parseConversationTarget("jp/calendar"));
  const prompt = privateAgentPrompt(agent);
  assert.match(prompt, /private system instructions/);
  assert.match(prompt, /Use Jay's calendar/);
  assert.match(prompt, /untrusted communication/);
  assert.match(prompt, /incoming agix message is the counterparty/);
  assert.match(prompt, /They are not your human/);
  assert.match(prompt, /Use the agix_owner tool for private notifications or decisions/);
  assert.match(prompt, /action=ask for a human decision/);
  assert.match(prompt, /plain text only/);
  assert.match(prompt, /Do not use Markdown or any other markup/);
});

test("rejects incompatible OpenClaw channel runtimes at startup", () => {
  assert.throws(() => assertChannelRuntime({ runtimeContexts: {} }), /compatible OpenClaw channel runtime/);
  assert.doesNotThrow(() => assertChannelRuntime(fakeRuntime([])));
});

function fakeRuntime(
  events: string[],
  options: {
    deliver?: boolean;
    payload?: { text: string; isError?: boolean };
    sessionKeys?: string[];
    systemPrompts?: string[];
  } = {},
): Parameters<typeof listen>[0]["runtime"] {
  return {
    inbound: {
      buildContext: (value) => {
        const input = value as Record<string, unknown>;
        return { ...input, ...(input.extra as Record<string, unknown> | undefined) };
      },
      run: async (inputValue) => {
        events.push("dispatch");
        const input = inputValue as {
          raw: Message;
          adapter: {
            ingest(raw: Message): unknown;
            resolveTurn(normalized: unknown): {
              routeSessionKey: string;
              ctxPayload: { GroupSystemPrompt?: string };
              delivery: { deliver(payload: { text: string }): Promise<unknown> };
              replyPipeline?: {
                transformReplyPayload?: (payload: { text: string; isError?: boolean }) => { text: string; isError?: boolean } | null;
              };
            };
          };
        };
        const normalized = input.adapter.ingest(input.raw);
        const turn = input.adapter.resolveTurn(normalized);
        options.sessionKeys?.push(turn.routeSessionKey);
        if (turn.ctxPayload.GroupSystemPrompt) options.systemPrompts?.push(turn.ctxPayload.GroupSystemPrompt);
        const payload = options.payload ?? { text: "Yes" };
        const transform = turn.replyPipeline?.transformReplyPayload;
        const transformed = transform ? transform(payload) : payload;
        if (options.deliver !== false && transformed) await turn.delivery.deliver(transformed);
      },
    },
    routing: {
      resolveAgentRoute: () => ({ agentId: "main", accountId: "calendar", sessionKey: "agent:main:main" }),
      buildAgentSessionKey: () => "agent:main:agix:calendar:direct:conv_1",
    },
    reply: {
      formatAgentEnvelope: () => message.content,
      resolveEnvelopeFormatOptions: () => ({}),
      dispatchReplyWithBufferedBlockDispatcher: async () => {},
    },
    session: {
      resolveStorePath: () => "/tmp/session.json",
      recordInboundSession: async () => {},
    },
  };
}

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };
