import assert from "node:assert/strict";
import test from "node:test";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup-runtime";
import { loginToAgix, validateCallback } from "../src/oauth.js";

test("completes browser authorization and selects the only owned agent", async () => {
  let authorizationUrl = "";
  const requests: string[] = [];
  const prompter = {
    note: async (message: string, title?: string) => {
      assert.equal(title, "Connect to agix");
      authorizationUrl = message.split("\n\n")[1] ?? "";
    },
    text: async ({ validate }: { validate?: (value: string) => string | undefined }) => {
      const state = new URL(authorizationUrl).searchParams.get("state");
      const callback = `http://127.0.0.1:1456/callback?code=code_1&state=${state}`;
      assert.equal(validate?.(callback), undefined);
      return callback;
    },
    select: async () => { throw new Error("single-agent login should not prompt for selection"); },
  } as unknown as WizardPrompter;

  const result = await loginToAgix({
    apiUrl: "https://agixlink.com/api/v1",
    prompter,
    fetch: async (input, init) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return Response.json({
          authorization_endpoint: "https://agixlink.com/authorize",
          token_endpoint: "https://agixlink.com/token",
          registration_endpoint: "https://agixlink.com/register",
        });
      }
      if (url.endsWith("/register")) return Response.json({ client_id: "client_1" });
      if (url.endsWith("/token")) {
        assert.equal(init?.method, "POST");
        return Response.json({ access_token: "access_1", refresh_token: "refresh_1", expires_in: 3600 });
      }
      if (url.endsWith("/api/v1/me/agents?limit=100")) {
        return Response.json({
          agents: [{
            address: "jp/calendar",
            name: "calendar",
            owner: { handle: "jp", name: "Jay", about: "" },
            about: "Schedules meetings.",
            connected: true,
            instructions: "Ask before creating an event.",
          }],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  assert.equal(result.agent.name, "calendar");
  assert.equal(result.credentials.accessToken, "access_1");
  assert.equal(result.credentials.refreshToken, "refresh_1");
  assert.deepEqual(requests, [
    "https://agixlink.com/.well-known/oauth-authorization-server",
    "https://agixlink.com/register",
    "https://agixlink.com/token",
    "https://agixlink.com/api/v1/me/agents?limit=100",
  ]);
});

test("creates and connects the first agent after authorization", async () => {
  let authorizationUrl = "";
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const answers = ["helper", "Handles errands with other agents.", "Ask before spending money."];
  const prompter = {
    note: async (message: string, title?: string) => {
      if (title === "Connect to agix") authorizationUrl = message.split("\n\n")[1] ?? "";
      else {
        assert.equal(title, "Create your first agent");
        assert.match(message, /doesn't have any agents/);
      }
    },
    text: async ({ message, validate }: { message: string; validate?: (value: string) => string | undefined }) => {
      if (message === "Paste the complete callback URL") {
        const state = new URL(authorizationUrl).searchParams.get("state");
        return `http://127.0.0.1:1456/callback?code=code_1&state=${state}`;
      }
      const answer = answers.shift() ?? "";
      assert.equal(validate?.(answer), undefined);
      return answer;
    },
    confirm: async ({ message, initialValue }: { message: string; initialValue?: boolean }) => {
      assert.equal(message, "Create and connect the agent “helper”?");
      assert.equal(initialValue, true);
      return true;
    },
    select: async () => { throw new Error("first-agent login should not prompt for selection"); },
  } as unknown as WizardPrompter;

  const createdAgent = {
    address: "jp/helper",
    name: "helper",
    owner: { handle: "jp", name: "Jay", about: "" },
    about: "Handles errands with other agents.",
    connected: false,
    instructions: "Ask before spending money.",
  };
  const result = await loginToAgix({
    apiUrl: "https://agixlink.com/api/v1",
    prompter,
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ url, ...(init ? { init } : {}) });
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return Response.json({
          authorization_endpoint: "https://agixlink.com/authorize",
          token_endpoint: "https://agixlink.com/token",
          registration_endpoint: "https://agixlink.com/register",
        });
      }
      if (url.endsWith("/register")) return Response.json({ client_id: "client_1" });
      if (url.endsWith("/token")) return Response.json({ access_token: "access_1", expires_in: 3600 });
      if (url.endsWith("/api/v1/me/agents?limit=100")) return Response.json({ agents: [] });
      if (url.endsWith("/api/v1/me/agents")) return Response.json(createdAgent, { status: 201 });
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  assert.deepEqual(result.agent, createdAgent);
  const createRequest = requests.at(-1)!;
  assert.equal(createRequest.init?.method, "POST");
  assert.equal(new Headers(createRequest.init?.headers).get("authorization"), "Bearer access_1");
  assert.deepEqual(JSON.parse(String(createRequest.init?.body)), {
    name: "helper",
    about: "Handles errands with other agents.",
    instructions: "Ask before spending money.",
  });
});

test("gives actionable callback validation errors", () => {
  assert.equal(
    validateCallback("not a URL", "state_1"),
    "Paste the complete callback URL, starting with `http://127.0.0.1:1456/callback`.",
  );
  assert.equal(
    validateCallback("http://127.0.0.1:1456/callback?code=code_1&state=old", "state_1"),
    "This callback is from a different login attempt. Paste the callback URL from the browser tab you just opened.",
  );
  assert.equal(
    validateCallback("http://127.0.0.1:1456/callback?state=state_1", "state_1"),
    "This callback URL doesn't include an authorization code. Complete authorization in agix, then paste the new callback URL.",
  );
});
