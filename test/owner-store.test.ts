import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OwnerRequestStore, type PendingOwnerRequest } from "../src/owner-store.js";

test("persists pending owner requests across store instances", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "agix-owner-store-test-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const request = pendingRequest();

  await new OwnerRequestStore(stateDir).register(request.requestId, request, { ttlMs: 60_000 });

  const restartedStore = new OwnerRequestStore(stateDir);
  assert.deepEqual(await restartedStore.lookup(request.requestId), request);
  assert.deepEqual(await restartedStore.entries(), [{ key: request.requestId, value: request }]);

  const file = join(stateDir, "plugins", "agix", "owner-requests.json");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(await restartedStore.delete(request.requestId), true);
  assert.equal(await restartedStore.lookup(request.requestId), undefined);
});

test("expires pending owner requests", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "agix-owner-store-test-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const request = pendingRequest();
  const store = new OwnerRequestStore(stateDir);

  await store.register(request.requestId, request, { ttlMs: -1 });

  assert.equal(await new OwnerRequestStore(stateDir).lookup(request.requestId), undefined);
});

function pendingRequest(): PendingOwnerRequest {
  return {
    requestId: "agix_request_1",
    sourceSessionKey: "agent:main:agix:calendar:direct:conv_1",
    sourceAgentId: "main",
    accountId: "calendar",
    agentName: "calendar",
    conversationId: "conv_1",
    question: "Should I accept the changed scope?",
    context: "The counterparty requested an additional deliverable.",
    createdAt: 1_787_918_000_000,
  };
}
