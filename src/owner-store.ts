import { join } from "node:path";
import { withFileLock } from "openclaw/plugin-sdk/file-lock";
import { readJsonIfExists, writeJsonAtomic } from "openclaw/plugin-sdk/infra-runtime";

const STORE_VERSION = 1;
const MAX_ENTRIES = 1_000;
const LOCK_OPTIONS = {
  retries: { retries: 20, factor: 1.5, minTimeout: 10, maxTimeout: 250, randomize: true },
  stale: 30_000,
};

export type PendingOwnerRequest = {
  requestId: string;
  sourceSessionKey: string;
  sourceAgentId: string;
  accountId: string;
  agentName: string;
  conversationId: string;
  question: string;
  context?: string;
  createdAt: number;
};

type StoredRequest = PendingOwnerRequest & { expiresAt: number };
type StoreFile = { version: typeof STORE_VERSION; requests: Record<string, StoredRequest> };

export class OwnerRequestStore {
  private readonly filePath: string;

  constructor(stateDir: string) {
    this.filePath = join(stateDir, "plugins", "agix", "owner-requests.json");
  }

  async register(requestId: string, value: PendingOwnerRequest, options: { ttlMs: number }): Promise<void> {
    await this.mutate((store, now) => {
      pruneExpired(store, now);
      if (!store.requests[requestId] && Object.keys(store.requests).length >= MAX_ENTRIES) {
        throw new Error(`Too many pending agix owner requests (${MAX_ENTRIES}). Answer or clear an existing request before creating another.`);
      }
      store.requests[requestId] = { ...value, expiresAt: now + options.ttlMs };
    });
  }

  async lookup(requestId: string): Promise<PendingOwnerRequest | undefined> {
    return this.mutate((store, now) => {
      pruneExpired(store, now);
      return withoutExpiry(store.requests[requestId]);
    });
  }

  async delete(requestId: string): Promise<boolean> {
    return this.mutate((store, now) => {
      pruneExpired(store, now);
      if (!store.requests[requestId]) return false;
      delete store.requests[requestId];
      return true;
    });
  }

  async entries(): Promise<Array<{ key: string; value: PendingOwnerRequest }>> {
    return this.mutate((store, now) => {
      pruneExpired(store, now);
      return Object.entries(store.requests)
        .map(([key, value]) => ({ key, value: withoutExpiry(value)! }))
        .sort((left, right) => left.value.createdAt - right.value.createdAt);
    });
  }

  private async mutate<T>(operation: (store: StoreFile, now: number) => T): Promise<T> {
    return withFileLock(this.filePath, LOCK_OPTIONS, async () => {
      const store = await readStore(this.filePath);
      const result = operation(store, Date.now());
      await writeJsonAtomic(this.filePath, store, { mode: 0o600, dirMode: 0o700, durable: true });
      return result;
    });
  }
}

async function readStore(filePath: string): Promise<StoreFile> {
  const value = await readJsonIfExists<unknown>(filePath);
  if (value == null) return { version: STORE_VERSION, requests: {} };
  if (!isStoreFile(value)) {
    throw new Error(`The agix owner request store is invalid: ${filePath}`);
  }
  return value;
}

function isStoreFile(value: unknown): value is StoreFile {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { version?: unknown; requests?: unknown };
  if (candidate.version !== STORE_VERSION || !candidate.requests || typeof candidate.requests !== "object" || Array.isArray(candidate.requests)) {
    return false;
  }
  return Object.values(candidate.requests).every(isStoredRequest);
}

function isStoredRequest(value: unknown): value is StoredRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  return [
    "requestId",
    "sourceSessionKey",
    "sourceAgentId",
    "accountId",
    "agentName",
    "conversationId",
    "question",
  ].every((field) => typeof request[field] === "string") &&
    (request.context === undefined || typeof request.context === "string") &&
    typeof request.createdAt === "number" && Number.isFinite(request.createdAt) &&
    typeof request.expiresAt === "number" && Number.isFinite(request.expiresAt);
}

function pruneExpired(store: StoreFile, now: number): void {
  for (const [requestId, request] of Object.entries(store.requests)) {
    if (request.expiresAt <= now) delete store.requests[requestId];
  }
}

function withoutExpiry(value: StoredRequest | undefined): PendingOwnerRequest | undefined {
  if (!value) return undefined;
  const { expiresAt: _expiresAt, ...request } = value;
  return request;
}
