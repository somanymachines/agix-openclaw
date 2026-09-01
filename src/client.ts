import { randomUUID } from "node:crypto";
import type {
  Agent,
  ConversationPage,
  Credentials,
  Inbox,
  SendResult,
  User,
} from "./types.js";

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
};

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly retryable = false) {
    super(message);
  }
}

export type ClientOptions = {
  apiUrl: string;
  credentials: Credentials;
  fetch?: typeof fetch;
  onCredentials?: (credentials: Credentials) => Promise<void> | void;
};

export class Client {
  private credentials: Credentials;
  private readonly fetchImpl: typeof fetch;
  private refreshPromise: Promise<void> | undefined;

  constructor(private readonly options: ClientOptions) {
    this.credentials = { ...options.credentials };
    this.fetchImpl = options.fetch ?? fetch;
  }

  async me(): Promise<User> {
    return this.request<User>("/me");
  }

  async agents(): Promise<{ agents: Agent[]; next_cursor: string | null }> {
    return this.request("/me/agents?limit=100");
  }

  async agent(name: string): Promise<Agent> {
    return this.request(`/me/agents/${encodeURIComponent(name)}`);
  }

  async inbox(name: string, signal?: AbortSignal): Promise<Inbox> {
    return this.request(`/me/agents/${encodeURIComponent(name)}/inbox?wait=300&limit=50`, signal ? { signal } : {});
  }

  async process(name: string, messageId: string): Promise<void> {
    await this.request(`/me/agents/${encodeURIComponent(name)}/inbox/messages/${encodeURIComponent(messageId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ processed: true }),
    });
  }

  async send(name: string, conversationId: string, content: string, idempotencyKey: string = randomUUID()): Promise<SendResult> {
    return this.request(`/me/agents/${encodeURIComponent(name)}/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({ content }),
    });
  }

  async conversation(name: string, conversationId: string): Promise<ConversationPage> {
    return this.request(
      `/me/agents/${encodeURIComponent(name)}/conversations/${encodeURIComponent(conversationId)}?limit=100`,
    );
  }

  private async request<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
    if (this.shouldRefresh()) await this.refresh();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.credentials.accessToken}`);
    const response = await this.fetchImpl(`${this.options.apiUrl}${path}`, { ...init, headers });
    if (response.status === 401 && !retried && this.credentials.refreshToken && this.credentials.clientId) {
      await this.refresh();
      return this.request<T>(path, init, true);
    }
    if (!response.ok) throw await apiError(response);
    return await response.json() as T;
  }

  private shouldRefresh(): boolean {
    return Boolean(
      this.credentials.refreshToken &&
      this.credentials.clientId &&
      this.credentials.expiresAt &&
      this.credentials.expiresAt <= Date.now() + 60_000,
    );
  }

  private async refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.performRefresh().finally(() => { this.refreshPromise = undefined; });
    return this.refreshPromise;
  }

  private async performRefresh(): Promise<void> {
    const refreshToken = this.credentials.refreshToken;
    const clientId = this.credentials.clientId;
    if (!refreshToken || !clientId) {
      throw new ApiError(401, "agix authentication expired. Run `openclaw channels login --channel agix` to reconnect.");
    }
    const tokenUrl = new URL(this.options.apiUrl);
    tokenUrl.pathname = "/token";
    tokenUrl.search = "";
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      resource: this.options.apiUrl,
    });
    const response = await this.fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) throw await apiError(response);
    const token = await response.json() as TokenResponse;
    this.credentials = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? refreshToken,
      clientId,
      expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
    };
    await this.options.onCredentials?.({ ...this.credentials });
  }
}

async function apiError(response: Response): Promise<ApiError> {
  let message = `The agix API request failed (HTTP ${response.status}).`;
  let retryable = response.status === 429 || response.status >= 500;
  try {
    const body = await response.json() as {
      error?: string | { message?: string; retryable?: boolean };
      error_description?: string;
    };
    if (typeof body.error === "object" && body.error?.message) message = body.error.message;
    else if (body.error_description) message = body.error_description;
    else if (typeof body.error === "string") message = body.error;
    if (typeof body.error === "object" && typeof body.error?.retryable === "boolean") retryable = body.error.retryable;
  } catch {}
  return new ApiError(response.status, message, retryable);
}
