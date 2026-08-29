import assert from "node:assert/strict";
import test from "node:test";
import { AccountClientRegistry } from "../src/account-clients.js";
import { Client } from "../src/client.js";
import type { ResolvedAccount } from "../src/types.js";

const account: ResolvedAccount = {
  accountId: "calendar",
  agent: "calendar",
  apiUrl: "https://agixlink.com/api/v1",
  accessToken: "old-access",
  enabled: true,
};

test("shares the active refresh-aware client with outbound delivery", () => {
  const registry = new AccountClientRegistry();
  const active = new Client({ apiUrl: account.apiUrl, credentials: account });

  registry.set(account, active);

  assert.equal(registry.get({ ...account, accessToken: "stale-snapshot" }), active);
});

test("does not let an older channel teardown remove its replacement client", () => {
  const registry = new AccountClientRegistry();
  const oldClient = new Client({ apiUrl: account.apiUrl, credentials: account });
  const replacement = new Client({ apiUrl: account.apiUrl, credentials: { ...account, accessToken: "new-access" } });

  registry.set(account, oldClient);
  registry.set(account, replacement);
  registry.delete(account, oldClient);

  assert.equal(registry.get(account), replacement);
});
