import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { createAgixOwnerTool, registerAgixOwnerTool } from "../src/owner-bridge.js";

test("notifies the owner through the main session's private route", async (t) => {
  const harness = fakeApi();
  t.after(harness.cleanup);
  const tool = createAgixOwnerTool(harness.api, agixContext()) as any;
  const result = await tool.execute("call_1", { action: "notify", message: "Booked the meeting." });

  assert.equal(result.details.status, "sent");
  assert.equal(harness.ownerMessages.length, 1);
  assert.deepEqual(pick(harness.ownerMessages[0]!, ["channel", "to", "accountId"]), {
    channel: "telegram",
    to: "telegram:1234",
    accountId: "default",
  });
  assert.match(String(harness.ownerMessages[0]!.text), /Your calendar agent has an update/);
  assert.match(String(harness.ownerMessages[0]!.text), /Booked the meeting/);
});

test("asks privately, records the request, and resumes the isolated agix session with the owner's answer", async (t) => {
  const harness = fakeApi();
  t.after(harness.cleanup);
  const sourceTool = createAgixOwnerTool(harness.api, agixContext()) as any;
  const asked = await sourceTool.execute("call_1", {
    action: "ask",
    message: "Should I accept the changed scope?",
    context: "The counterparty requested an additional deliverable.",
  });
  const requestId = String(asked.details.request_id);
  assert.match(requestId, /^agix_/);
  assert.equal(asked.details.status, "pending");
  assert.match(String(harness.ownerMessages[0]!.text), /Your calendar agent needs your input/);
  assert.doesNotMatch(String(harness.ownerMessages[0]!.text), new RegExp(requestId));

  const ownerTool = createAgixOwnerTool(harness.api, {
    agentId: "main",
    sessionKey: "agent:main:main",
    messageChannel: "telegram",
    senderIsOwner: true,
  }) as any;
  const pending = await ownerTool.execute("call_2", { action: "pending" });
  assert.equal(pending.details.pending.length, 1);
  assert.equal(pending.details.pending[0].request_id, requestId);

  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    address: "jp/calendar",
    name: "calendar",
    owner: { handle: "jp", name: "Jay", about: "" },
    about: "Schedules meetings.",
    connected: true,
    instructions: "Private agent instructions.",
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const responded = await ownerTool.execute("call_3", {
      action: "respond",
      request_id: requestId,
      response: "Yes, accept it.",
    });
    assert.equal(responded.details.status, "resumed");
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.equal(harness.inboundTurns.length, 1);
  assert.match(String(harness.inboundTurns[0]!.raw.content), /Yes, accept it/);
  assert.equal(harness.inboundTurns[0]!.turn.routeSessionKey, "agent:main:agix:calendar:direct:conv_1");
  assert.match(String(harness.inboundTurns[0]!.turn.ctxPayload.GroupSystemPrompt), /trusted private response/);
  assert.match(String(harness.inboundTurns[0]!.turn.ctxPayload.GroupSystemPrompt), /Private agent instructions/);
  const after = await ownerTool.execute("call_4", { action: "pending" });
  assert.equal(after.details.pending.length, 0);
});

test("alerts the owner's private agent when a decision request is pending", async (t) => {
  const harness = fakeApi();
  t.after(harness.cleanup);
  registerAgixOwnerTool(harness.api);
  const sourceTool = createAgixOwnerTool(harness.api, agixContext()) as any;
  await sourceTool.execute("call_1", { action: "ask", message: "Choose A or B." });

  const result = await harness.beforePromptBuild!({}, {
    agentId: "main",
    sessionKey: "agent:main:main",
    channel: "telegram",
  });
  assert.match(String(result?.appendSystemContext), /1 pending private agix owner request/);
  assert.match(String(result?.appendSystemContext), /action=pending/);
  assert.doesNotMatch(String(result?.appendSystemContext), /Choose A or B/);
});

test("does not let an untrusted agix sender inspect or answer owner requests", async (t) => {
  const harness = fakeApi();
  t.after(harness.cleanup);
  const tool = createAgixOwnerTool(harness.api, agixContext()) as any;
  await assert.rejects(tool.execute("call_1", { action: "pending" }), /Only the human owner/);
  await assert.rejects(tool.execute("call_2", { action: "respond", request_id: "x", response: "yes" }), /Only the human owner/);
});

function agixContext(): OpenClawPluginToolContext {
  const config = {
    channels: {
      agix: {
        accounts: {
          calendar: { agent: "calendar", accessToken: "token" },
        },
      },
    },
  };
  return {
    agentId: "main",
    agentAccountId: "calendar",
    sessionKey: "agent:main:agix:calendar:direct:conv_1",
    messageChannel: "agix",
    senderIsOwner: false,
    deliveryContext: { channel: "agix", to: "agix:conversation:conv_1", accountId: "calendar" },
    config,
  } as OpenClawPluginToolContext;
}

function fakeApi() {
  const stateDir = mkdtempSync(join(tmpdir(), "agix-owner-bridge-test-"));
  const ownerMessages: Record<string, unknown>[] = [];
  const inboundTurns: Array<{ raw: any; turn: any }> = [];
  let beforePromptBuild: ((event: any, ctx: any) => Promise<any> | any) | undefined;
  const config = {
    channels: {
      agix: {
        accounts: {
          calendar: { agent: "calendar", accessToken: "token" },
        },
      },
    },
  };
  const api = {
    runtime: {
      config: { current: () => config },
      agent: {
        session: {
          getSessionEntry: () => ({
            sessionId: "owner-session",
            updatedAt: Date.now(),
            deliveryContext: { channel: "telegram", to: "telegram:1234", accountId: "default" },
          }),
        },
      },
      state: {
        resolveStateDir: () => stateDir,
      },
      channel: {
        outbound: {
          loadAdapter: async (channel: string) => ({
            sendText: async (params: Record<string, unknown>) => {
              ownerMessages.push({ channel, ...params });
              return { channel, messageId: "owner-message-1" };
            },
          }),
        },
        inbound: {
          run: async (input: any) => {
            const normalized = input.adapter.ingest(input.raw);
            inboundTurns.push({ raw: input.raw, turn: input.adapter.resolveTurn(normalized) });
          },
          buildContext: (input: any) => ({ ...input, ...input.extra }),
        },
        routing: {
          resolveAgentRoute: () => ({ agentId: "main", accountId: "calendar", sessionKey: "unused" }),
          buildAgentSessionKey: () => "agent:main:agix:calendar:direct:conv_1",
        },
        reply: {
          formatAgentEnvelope: (input: any) => input.body,
          resolveEnvelopeFormatOptions: () => ({}),
          dispatchReplyWithBufferedBlockDispatcher: () => {},
        },
        session: {
          resolveStorePath: () => "/tmp/sessions.json",
          recordInboundSession: () => {},
        },
      },
    },
    registerTool: () => {},
    on: (name: string, handler: any) => {
      if (name === "before_prompt_build") beforePromptBuild = handler;
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as unknown as OpenClawPluginApi;
  return {
    api,
    ownerMessages,
    inboundTurns,
    get beforePromptBuild() { return beforePromptBuild; },
    cleanup: () => rmSync(stateDir, { recursive: true, force: true }),
  };
}

function pick(value: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}
