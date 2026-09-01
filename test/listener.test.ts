import assert from "node:assert/strict";
import test from "node:test";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { ApiError, type Client } from "../src/client.js";
import {
  assertChannelRuntime,
  filterPublicAgixReplyPayload,
  listen,
  parseConversationTarget,
  privateAgentPrompt,
} from "../src/listener.js";
import type { Agent, Conversation, Message } from "../src/types.js";

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

const directConversation: Conversation = {
  id: message.conversation_id,
  participants: [
    { agent: agent.address, status: "active" },
    { agent: message.author, status: "active" },
  ],
  created_at: message.created_at,
  updated_at: message.created_at,
};

const groupConversation: Conversation = {
  ...directConversation,
  participants: [
    ...directConversation.participants,
    { agent: "li/research", status: "active" },
  ],
};

test("dispatches, delivers, and only then marks a message processed", async () => {
  const controller = new AbortController();
  const events: string[] = [];
  const sessionKeys: string[] = [];
  const systemPrompts: string[] = [];
  const client = {
    inbox: async () => ({ messages: [message], next_cursor: null }),
    agent: async () => agent,
    conversation: async () => ({ conversation: directConversation, messages: [], next_cursor: null }),
    send: async () => {
      events.push("send");
      return { id: "msg_2", author: agent.address, content: "Yes", created_at: message.created_at };
    },
    process: async () => {
      events.push("process");
      controller.abort();
    },
  } as unknown as Client;
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
    conversation: async () => ({ conversation: directConversation, messages: [], next_cursor: null }),
    send: async () => { events.push("send"); throw new Error("delivery failed"); },
    process: async () => { events.push("process"); },
  } as unknown as Client;
  const runtime = fakeRuntime(events, { swallowDeliveryErrors: true });
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

test("skips deliveries revoked during Conversation lookup or acknowledgement", async () => {
  const controller = new AbortController();
  const lookupRevoked = { ...message, id: "msg_lookup_revoked", conversation_id: "conv_lookup_revoked" };
  const ackRevoked = { ...message, id: "msg_ack_revoked", conversation_id: "conv_ack_revoked" };
  const active = { ...message, id: "msg_active", conversation_id: "conv_active" };
  const acknowledged: string[] = [];
  const skipped: string[] = [];
  const client = {
    inbox: async () => ({ messages: [lookupRevoked, ackRevoked, active], next_cursor: null }),
    agent: async () => agent,
    conversation: async (_name: string, conversationId: string) => {
      if (conversationId === lookupRevoked.conversation_id) throw new ApiError(404, "membership inactive");
      return {
        conversation: { ...groupConversation, id: conversationId },
        messages: [],
        next_cursor: null,
      };
    },
    process: async (_name: string, messageId: string) => {
      acknowledged.push(messageId);
      if (messageId === ackRevoked.id) throw new ApiError(404, "delivery cancelled");
      controller.abort();
    },
  } as unknown as Client;

  await listen({
    cfg: {} as OpenClawConfig,
    accountId: "calendar",
    agentName: "calendar",
    client,
    runtime: fakeRuntime([], { deliver: false }),
    signal: controller.signal,
    log: { ...silentLog, info: (detail) => skipped.push(detail) },
  });

  assert.deepEqual(acknowledged, [ackRevoked.id, active.id]);
  assert.equal(skipped.length, 2);
  assert.match(skipped[0]!, /msg_lookup_revoked/);
  assert.match(skipped[1]!, /msg_ack_revoked/);
});

test("preserves Agent-level disable handling for an Agent lookup 404", async () => {
  const controller = new AbortController();
  const client = {
    inbox: async () => ({ messages: [message], next_cursor: null }),
    agent: async () => { throw new ApiError(404, "agent disabled"); },
  } as unknown as Client;

  await assert.rejects(listen({
    cfg: {} as OpenClawConfig,
    accountId: "calendar",
    agentName: "calendar",
    client,
    runtime: fakeRuntime([]),
    signal: controller.signal,
    log: silentLog,
  }), /agent disabled/);
});

test("reuses per-block idempotency keys after a partial multi-block failure", async () => {
  const controller = new AbortController();
  const sends: Array<{ text: string; key: string }> = [];
  let sendAttempt = 0;
  const client = {
    inbox: async () => ({ messages: [message], next_cursor: null }),
    agent: async () => agent,
    conversation: async () => ({ conversation: directConversation, messages: [], next_cursor: null }),
    send: async (_name: string, _conversationId: string, text: string, key: string) => {
      sends.push({ text, key });
      sendAttempt += 1;
      if (sendAttempt === 2) throw new Error("second block failed");
      return { id: `sent_${sendAttempt}`, author: agent.address, content: text, created_at: message.created_at };
    },
    process: async () => controller.abort(),
  } as unknown as Client;

  await listen({
    cfg: {} as OpenClawConfig,
    accountId: "calendar",
    agentName: "calendar",
    client,
    runtime: fakeRuntime([], {
      payloads: [{ text: "First block" }, { text: "Second block" }],
      swallowDeliveryErrors: true,
    }),
    signal: controller.signal,
    log: silentLog,
  });

  assert.deepEqual(sends.map((send) => send.text), ["First block", "Second block", "First block", "Second block"]);
  assert.equal(sends[0]!.key, sends[2]!.key);
  assert.equal(sends[1]!.key, sends[3]!.key);
  assert.notEqual(sends[0]!.key, sends[1]!.key);
});

test("reuses the idempotency key when a committed send loses its response", async () => {
  const controller = new AbortController();
  const attemptedKeys: string[] = [];
  const committedKeys = new Set<string>();
  const client = {
    inbox: async () => ({ messages: [message], next_cursor: null }),
    agent: async () => agent,
    conversation: async () => ({ conversation: directConversation, messages: [], next_cursor: null }),
    send: async (_name: string, _conversationId: string, text: string, key: string) => {
      attemptedKeys.push(key);
      const alreadyCommitted = committedKeys.has(key);
      committedKeys.add(key);
      if (!alreadyCommitted) throw new Error("response lost after commit");
      return { id: "sent_existing", author: agent.address, content: text, created_at: message.created_at };
    },
    process: async () => controller.abort(),
  } as unknown as Client;

  await listen({
    cfg: {} as OpenClawConfig,
    accountId: "calendar",
    agentName: "calendar",
    client,
    runtime: fakeRuntime([], { swallowDeliveryErrors: true }),
    signal: controller.signal,
    log: silentLog,
  });

  assert.equal(committedKeys.size, 1);
  assert.equal(attemptedKeys.length, 2);
  assert.equal(attemptedKeys[0], attemptedKeys[1]);
});

test("preserves reply-required behavior for a direct two-participant Conversation", async () => {
  const controller = new AbortController();
  const events: string[] = [];
  const client = {
    inbox: async () => ({ messages: [message], next_cursor: null }),
    agent: async () => agent,
    conversation: async () => ({ conversation: directConversation, messages: [], next_cursor: null }),
    process: async () => { events.push("process"); },
  } as unknown as Client;

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

test("uses one group Conversation session for messages from multiple authors", async () => {
  const controller = new AbortController();
  const secondMessage = { ...message, id: "msg_2", author: "li/research", content: "I can research that." };
  const events: string[] = [];
  const sessionKeys: string[] = [];
  const contexts: Array<Record<string, unknown>> = [];
  const systemPrompts: string[] = [];
  let processed = 0;
  const client = {
    inbox: async () => ({ messages: [message, secondMessage], next_cursor: null }),
    agent: async () => agent,
    conversation: async () => ({ conversation: groupConversation, messages: [], next_cursor: null }),
    process: async () => {
      processed += 1;
      if (processed === 2) controller.abort();
    },
  } as unknown as Client;

  await listen({
    cfg: {} as OpenClawConfig,
    accountId: "calendar",
    agentName: "calendar",
    client,
    runtime: fakeRuntime(events, { deliver: false, sessionKeys, contexts, systemPrompts }),
    signal: controller.signal,
    log: silentLog,
  });

  assert.equal(processed, 2);
  assert.deepEqual(sessionKeys, [
    "agent:main:agix:calendar:group:conv_1",
    "agent:main:agix:calendar:group:conv_1",
  ]);
  assert.deepEqual(contexts.map((context) => context.from), [
    "agix:agent:maria/calendar",
    "agix:agent:li/research",
  ]);
  assert.deepEqual(contexts.map((context) => (context.conversation as { kind: string }).kind), ["group", "group"]);
  assert.ok(systemPrompts.every((prompt) => prompt.includes("one participant, not necessarily the sole counterparty")));
});

test("marks an intentionally unanswered group Message processed", async () => {
  const controller = new AbortController();
  const events: string[] = [];
  const client = {
    inbox: async () => ({ messages: [message], next_cursor: null }),
    agent: async () => agent,
    conversation: async () => ({ conversation: groupConversation, messages: [], next_cursor: null }),
    process: async () => { events.push("process"); controller.abort(); },
  } as unknown as Client;

  await listen({
    cfg: {} as OpenClawConfig,
    accountId: "calendar",
    agentName: "calendar",
    client,
    runtime: fakeRuntime(events, { deliver: false }),
    signal: controller.signal,
    log: silentLog,
  });

  assert.deepEqual(events, ["dispatch", "process"]);
});

test("suppresses OpenClaw runtime notices and leaves the message pending", async () => {
  const controller = new AbortController();
  const events: string[] = [];
  const client = {
    inbox: async () => ({ messages: [message], next_cursor: null }),
    agent: async () => agent,
    conversation: async () => ({ conversation: directConversation, messages: [], next_cursor: null }),
    send: async () => { events.push("send"); throw new Error("should not send runtime notices"); },
    process: async () => { events.push("process"); },
  } as unknown as Client;

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
    payloads?: Array<{ text: string; isError?: boolean }>;
    sessionKeys?: string[];
    systemPrompts?: string[];
    contexts?: Array<Record<string, unknown>>;
    swallowDeliveryErrors?: boolean;
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
        options.contexts?.push(turn.ctxPayload as Record<string, unknown>);
        if (turn.ctxPayload.GroupSystemPrompt) options.systemPrompts?.push(turn.ctxPayload.GroupSystemPrompt);
        const transform = turn.replyPipeline?.transformReplyPayload;
        const payloads = options.payloads ?? [options.payload ?? { text: "Yes" }];
        for (const payload of payloads) {
          const transformed = transform ? transform(payload) : payload;
          if (options.deliver !== false && transformed) {
            try {
              await turn.delivery.deliver(transformed);
            } catch (error) {
              if (!options.swallowDeliveryErrors) throw error;
            }
          }
        }
      },
    },
    routing: {
      resolveAgentRoute: () => ({ agentId: "main", accountId: "calendar", sessionKey: "agent:main:main" }),
      buildAgentSessionKey: (inputValue) => {
        const input = inputValue as { peer: { kind: string; id: string } };
        return `agent:main:agix:calendar:${input.peer.kind}:${input.peer.id}`;
      },
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
