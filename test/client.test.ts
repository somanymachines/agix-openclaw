import assert from "node:assert/strict";
import test from "node:test";
import { AgixClient } from "../src/client.js";

test("refreshes an expiring token and persists the rotation", async () => {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  let persisted = "";
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    requests.push({ url, authorization: headers.get("authorization") });
    if (url === "https://agixlink.com/token") {
      return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
    }
    return Response.json({ handle: "jp", name: "Jay", about: "" });
  };
  const client = new AgixClient({
    apiUrl: "https://agixlink.com/api/v1",
    credentials: {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      clientId: "client_1",
      expiresAt: Date.now() - 1,
    },
    fetch: fetchImpl,
    onCredentials: (credentials) => { persisted = credentials.refreshToken ?? ""; },
  });

  assert.equal((await client.me()).handle, "jp");
  assert.equal(persisted, "new-refresh");
  assert.deepEqual(requests.map((request) => request.authorization), [null, "Bearer new-access"]);
});

test("returns the API's direct Message representation when sending", async () => {
  const sent = {
    id: "msg_2",
    author: "agix/calendar",
    content: "Hello",
    created_at: "2026-08-27T22:00:00.000Z",
  };
  const client = new AgixClient({
    apiUrl: "https://agixlink.com/api/v1",
    credentials: { accessToken: "access" },
    fetch: async () => Response.json(sent, { status: 201 }),
  });

  assert.deepEqual(await client.send("calendar", "conv_1", "Hello"), sent);
});

test("loads only messages after the inbound message when verifying delivery", async () => {
  let requestedUrl = "";
  const page = {
    conversation: {
      id: "conv_1",
      participants: ["agix/calendar", "jp/calendar"],
      created_at: "2026-08-27T22:00:00.000Z",
      updated_at: "2026-08-27T22:01:00.000Z",
    },
    messages: [],
    next_cursor: null,
  };
  const client = new AgixClient({
    apiUrl: "https://agixlink.com/api/v1",
    credentials: { accessToken: "access" },
    fetch: async (input) => {
      requestedUrl = String(input);
      return Response.json(page);
    },
  });

  assert.deepEqual(await client.conversationAfter("calendar", "conv_1", "msg_1"), page);
  assert.equal(
    requestedUrl,
    "https://agixlink.com/api/v1/me/agents/calendar/conversations/conv_1?after_message_id=msg_1&limit=100",
  );
});

test("reports OAuth refresh errors instead of a generic HTTP 400", async () => {
  const client = new AgixClient({
    apiUrl: "https://agixlink.com/api/v1",
    credentials: {
      accessToken: "expired-access",
      refreshToken: "rotated-refresh",
      clientId: "client_1",
      expiresAt: Date.now() - 1,
    },
    fetch: async () => Response.json({
      error: "invalid_grant",
      error_description: "Refresh token is invalid.",
    }, { status: 400 }),
  });

  await assert.rejects(client.me(), /Refresh token is invalid/);
});
