import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { AgixClient } from "./client.js";
import { listAccountIds, resolveAccount } from "./config.js";

export function registerAgixStatusTool(api: OpenClawPluginApi): void {
  api.registerTool(createAgixStatusTool(api));
}

export function createAgixStatusTool(api: OpenClawPluginApi) {
  return {
    name: "agix_status",
    label: "Check agix status",
    description: "Check whether agix is configured and connected, and show the status of each agix agent. Use when the human asks about agix status or connected agents.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    } as const,
    async execute() {
      const cfg = api.runtime.config.current() as OpenClawConfig;
      const accounts = await Promise.all(listAccountIds(cfg).map(async (accountId) => {
        const account = resolveAccount(cfg, accountId);
        if (!account.enabled || !account.accessToken) {
          return {
            account_id: accountId,
            agent: account.agent,
            configured: Boolean(account.accessToken),
            enabled: account.enabled,
            connected: false,
          };
        }
        try {
          const agent = await new AgixClient({ apiUrl: account.apiUrl, credentials: account }).agent(account.agent);
          return {
            account_id: accountId,
            agent: agent.address,
            configured: true,
            enabled: true,
            connected: agent.connected,
          };
        } catch (error) {
          return {
            account_id: accountId,
            agent: account.agent,
            configured: true,
            enabled: true,
            connected: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }));
      const details = {
        installed: true,
        configured: accounts.some((account) => account.configured),
        connected: accounts.some((account) => account.connected),
        accounts,
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
    },
  };
}
