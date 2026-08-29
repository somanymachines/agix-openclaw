import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { createClackPrompter } from "openclaw/plugin-sdk/setup-runtime";
import { replaceConfigFile } from "openclaw/plugin-sdk/config-mutation";
import { AccountClientRegistry } from "./account-clients.js";
import { Client } from "./client.js";
import {
  accountConfig,
  channelConfig,
  clearAccountCredentials,
  listAccountIds,
  patchAccount,
  resolveAccount,
} from "./config.js";
import { assertChannelRuntime, listen, parseConversationTarget } from "./listener.js";
import { loginToAgix, type OAuthLoginResult } from "./oauth.js";

const accountClients = new AccountClientRegistry();

export const agixPlugin: ChannelPlugin = {
  id: "agix",
  meta: {
    id: "agix",
    label: "agix",
    selectionLabel: "agix",
    detailLabel: "agix agent",
    docsPath: "https://agixlink.com",
    docsLabel: "agixlink.com",
    blurb: "Let your agent communicate and work with other agents.",
    markdownCapable: false,
    forceAccountBinding: true,
    exposure: { configured: true, setup: true, docs: true },
  },
  capabilities: {
    chatTypes: ["direct"],
    threads: false,
    media: false,
    reactions: false,
    nativeCommands: false,
    blockStreaming: true,
  },
  approvalCapability: {
    delivery: {
      shouldSuppressForwardingFallback: ({ target }) => target.channel === "agix",
    },
    getActionAvailabilityState: () => ({ kind: "unsupported" }),
    getExecInitiatingSurfaceState: () => ({ kind: "unsupported" }),
    resolveApproveCommandBehavior: () => ({ kind: "ignore" }),
  },
  reload: { configPrefixes: ["channels.agix"] },
  config: {
    listAccountIds,
    defaultAccountId: (cfg) => listAccountIds(cfg)[0] ?? "default",
    resolveAccount,
    inspectAccount: (cfg, accountId) => {
      const account = resolveAccount(cfg, accountId);
      return {
        accountId: account.accountId,
        enabled: account.enabled,
        configured: Boolean(account.accessToken),
        tokenStatus: account.accessToken ? "available" : "missing",
        agent: account.agent,
        apiUrl: account.apiUrl,
      };
    },
    isEnabled: (account) => account.enabled,
    isConfigured: (account) => Boolean(account.accessToken),
    unconfiguredReason: () => "Run `openclaw channels login --channel agix`.",
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.agent,
      enabled: account.enabled,
      configured: Boolean(account.accessToken),
      connected: false,
      tokenStatus: account.accessToken ? "available" : "missing",
      baseUrl: account.apiUrl,
    }),
    setAccountEnabled: ({ cfg, accountId, enabled }) => patchAccount(cfg, accountId, { enabled }),
    deleteAccount: ({ cfg, accountId }) => deleteAccount(cfg, accountId),
    hasConfiguredState: ({ cfg }) => listAccountIds(cfg).some((id) => Boolean(resolveAccount(cfg, id).accessToken)),
    hasPersistedAuthState: ({ cfg }) => listAccountIds(cfg).some((id) => Boolean(accountConfig(cfg, id)?.refreshToken)),
  },
  auth: {
    login: async ({ cfg, accountId }) => {
      const prompter = createClackPrompter();
      const section = channelConfig(cfg);
      const result = await loginToAgix({
        apiUrl: (section.apiUrl ?? "https://agixlink.com/api/v1").replace(/\/$/, ""),
        ...(accountId !== undefined ? { accountId } : {}),
        prompter,
      });
      const next = applyLoginResult(cfg, accountId, result);
      await replaceConfigFile({ nextConfig: next, afterWrite: { mode: "auto" } });
      await prompter.outro(`Connected ${result.agents.map((agent) => agent.address).join(", ")} to OpenClaw.`);
    },
  },
  status: {
    probeAccount: async ({ account, cfg }) => {
      const client = accountClients.get(account) ?? persistentClient(cfg, account);
      const [user, agent] = await Promise.all([client.me(), client.agent(account.agent)]);
      return { ok: true, user: user.handle, agent: agent.address, connected: agent.connected };
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => {
      const inspected = account as typeof account & { configured?: boolean; tokenStatus?: string };
      const configured = inspected.configured ?? Boolean(account.accessToken);
      return {
        accountId: account.accountId,
        name: account.agent,
        enabled: account.enabled,
        configured,
        running: runtime?.running ?? false,
        connected: runtime?.connected ?? false,
        tokenStatus: inspected.tokenStatus ?? (configured ? "available" : "missing"),
        baseUrl: account.apiUrl,
        probe,
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
        lastError: runtime?.lastError ?? null,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      if (!ctx.channelRuntime) throw new Error("The agix plugin requires the OpenClaw channel runtime.");
      assertChannelRuntime(ctx.channelRuntime);
      if (!ctx.account.accessToken) {
        throw new Error(`The agix account "${ctx.accountId}" is not authenticated. Run \`openclaw channels login --channel agix\` to reconnect.`);
      }
      let persistedCfg = ctx.cfg;
      const client = accountClients.getShared(ctx.account) ?? new Client({
        apiUrl: ctx.account.apiUrl,
        credentials: ctx.account,
        onCredentials: async (credentials) => {
          persistedCfg = patchIdentityCredentials(persistedCfg, ctx.account, credentials);
          await replaceConfigFile({
            nextConfig: persistedCfg,
            afterWrite: { mode: "none", reason: "The active agix client already holds the refreshed credentials." },
          });
        },
      });
      accountClients.set(ctx.account, client);
      ctx.log?.info(`[${ctx.accountId}] listening as ${ctx.account.agent}`);
      try {
        await listen({
          cfg: ctx.cfg,
          accountId: ctx.accountId,
          agentName: ctx.account.agent,
          client,
          runtime: ctx.channelRuntime as unknown as Parameters<typeof listen>[0]["runtime"],
          signal: ctx.abortSignal,
          log: ctx.log ?? console,
          setStatus: (patch) => ctx.setStatus({ ...ctx.getStatus(), ...patch, accountId: ctx.accountId }),
        });
      } finally {
        accountClients.delete(ctx.account, client);
      }
    },
    logoutAccount: async ({ cfg, accountId }) => {
      accountClients.deleteAccount(accountId);
      const current = accountConfig(cfg, accountId);
      if (!current) return { cleared: false, loggedOut: false };
      const next = clearAccountCredentials(cfg, accountId);
      await replaceConfigFile({ nextConfig: next, afterWrite: { mode: "auto" } });
      return { cleared: true, loggedOut: true };
    },
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 32_000,
    shouldSuppressLocalPayloadPrompt: ({ hint }) => hint?.kind === "approval-pending",
    resolveTarget: ({ to }) => {
      try { return { ok: true, to: parseConversationTarget(to ?? "") }; }
      catch (error) { return { ok: false, error: error as Error }; }
    },
    sendText: async ({ cfg, accountId, to, text }) => {
      const account = resolveAccount(cfg, accountId);
      const client = accountClients.get(account) ?? persistentClient(cfg, account);
      const conversationId = parseConversationTarget(to);
      const result = await client.send(account.agent, conversationId, text);
      return { channel: "agix", messageId: result.id, conversationId };
    },
  },
  messaging: {
    targetPrefixes: ["agix", "conversation"],
    normalizeTarget: (raw) => {
      try { return parseConversationTarget(raw); } catch { return undefined; }
    },
    targetResolver: {
      looksLikeId: (raw) => {
        try { parseConversationTarget(raw); return true; }
        catch { return false; }
      },
      hint: "<conv_...>",
    },
  },
  agentPrompt: {
    messageToolHints: () => [
      "- Reply to the current inbound agix conversation with the `message` tool using `action=send` and no explicit channel or target; OpenClaw already supplies the correct source route.",
      "- Only specify an agix target when contacting a different conversation. agix targets are durable conversation IDs (`conv_...`).",
    ],
  },
};

export function applyLoginResult(
  cfg: OpenClawConfig,
  accountId: string | null | undefined,
  result: OAuthLoginResult,
): OpenClawConfig {
  const explicitAccountId = accountId && accountId !== "default" && result.agents.length === 1
    ? accountId
    : undefined;
  let next = cfg;
  for (const agent of result.agents) {
    const existingAccountId = listAccountIds(cfg)
      .find((candidateId) => resolveAccount(cfg, candidateId).agent === agent.name);
    next = patchAccount(next, explicitAccountId ?? existingAccountId ?? agent.name, {
      agent: agent.name,
      enabled: true,
      ...result.credentials,
    });
  }
  return next;
}

export function persistentClient(cfg: OpenClawConfig, account: ReturnType<typeof resolveAccount>): Client {
  let persistedCfg = cfg;
  return new Client({
    apiUrl: account.apiUrl,
    credentials: account,
    onCredentials: async (credentials) => {
      persistedCfg = patchIdentityCredentials(persistedCfg, account, credentials);
      await replaceConfigFile({
        nextConfig: persistedCfg,
        afterWrite: { mode: "none", reason: "The agix client already holds the refreshed credentials." },
      });
    },
  });
}

function patchIdentityCredentials(
  cfg: OpenClawConfig,
  account: ReturnType<typeof resolveAccount>,
  credentials: Parameters<typeof patchAccount>[2],
): OpenClawConfig {
  let next = cfg;
  for (const accountId of listAccountIds(cfg)) {
    const candidate = resolveAccount(cfg, accountId);
    const sameIdentity = account.clientId
      ? candidate.clientId === account.clientId
      : candidate.accessToken === account.accessToken;
    if (candidate.apiUrl === account.apiUrl && sameIdentity) {
      next = patchAccount(next, accountId, credentials);
    }
  }
  return next;
}

export function clientForAccount(cfg: OpenClawConfig, account: ReturnType<typeof resolveAccount>): Client {
  return accountClients.get(account) ?? persistentClient(cfg, account);
}

function deleteAccount(cfg: OpenClawConfig, accountId: string): OpenClawConfig {
  const section = channelConfig(cfg);
  const accounts = { ...section.accounts };
  delete accounts[accountId];
  return {
    ...cfg,
    channels: { ...cfg.channels, agix: { ...section, accounts } },
  };
}
