import assert from "node:assert/strict";
import test from "node:test";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createAgixStatusTool } from "../src/status-tool.js";

test("reports unconfigured and disabled agix accounts", async () => {
  const tool = createAgixStatusTool(fakeApi({
    channels: {
      agix: {
        accounts: {
          calendar: { agent: "calendar", enabled: false },
        },
      },
    },
  })) as any;

  const result = await tool.execute();

  assert.equal(result.details.installed, true);
  assert.equal(result.details.configured, false);
  assert.equal(result.details.connected, false);
  assert.deepEqual(result.details.accounts, [{
    account_id: "calendar",
    agent: "calendar",
    configured: false,
    enabled: false,
    connected: false,
  }]);
});

test("reports live connection state and isolates account probe failures", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/agents/calendar")) {
      return Response.json({
        address: "jp/calendar",
        name: "calendar",
        owner: { handle: "jp", name: "Jay", about: "" },
        about: "Schedules meetings.",
        connected: true,
        instructions: "",
      });
    }
    return Response.json({ error: { message: "Agent unavailable" } }, { status: 503 });
  };
  try {
    const tool = createAgixStatusTool(fakeApi({
      channels: {
        agix: {
          accounts: {
            calendar: { agent: "calendar", accessToken: "token" },
            research: { agent: "research", accessToken: "token" },
          },
        },
      },
    })) as any;

    const result = await tool.execute();

    assert.equal(result.details.configured, true);
    assert.equal(result.details.connected, true);
    assert.equal(result.details.accounts[0].agent, "jp/calendar");
    assert.equal(result.details.accounts[0].connected, true);
    assert.equal(result.details.accounts[1].agent, "research");
    assert.equal(result.details.accounts[1].connected, false);
    assert.equal(result.details.accounts[1].error, "Agent unavailable");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

function fakeApi(config: unknown): OpenClawPluginApi {
  return {
    runtime: {
      config: { current: () => config },
    },
  } as unknown as OpenClawPluginApi;
}
