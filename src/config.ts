import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { AccountConfig, ChannelConfig, ResolvedAccount } from "./types.js";

export const DEFAULT_API_URL = "https://agixlink.com/api/v1";

export function channelConfig(cfg: OpenClawConfig): ChannelConfig {
  return ((cfg.channels as Record<string, unknown> | undefined)?.agix ?? {}) as ChannelConfig;
}

export function listAccountIds(cfg: OpenClawConfig): string[] {
  return Object.keys(channelConfig(cfg).accounts ?? {}).sort();
}

export function accountConfig(cfg: OpenClawConfig, accountId: string): AccountConfig | undefined {
  return channelConfig(cfg).accounts?.[accountId];
}

export function resolveAccount(cfg: OpenClawConfig, accountId?: string | null): ResolvedAccount {
  const id = accountId?.trim() || listAccountIds(cfg)[0] || "default";
  const channel = channelConfig(cfg);
  const account = channel.accounts?.[id];
  return {
    accountId: id,
    agent: account?.agent?.trim() || id,
    apiUrl: (channel.apiUrl?.trim() || DEFAULT_API_URL).replace(/\/$/, ""),
    accessToken: account?.accessToken?.trim() || "",
    ...(account?.refreshToken ? { refreshToken: account.refreshToken } : {}),
    ...(account?.clientId ? { clientId: account.clientId } : {}),
    ...(account?.expiresAt ? { expiresAt: account.expiresAt } : {}),
    enabled: channel.enabled !== false && account?.enabled !== false,
  };
}

export function patchAccount(
  cfg: OpenClawConfig,
  accountId: string,
  patch: Partial<AccountConfig>,
): OpenClawConfig {
  const channel = channelConfig(cfg);
  const current = channel.accounts?.[accountId] ?? { agent: accountId };
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      agix: {
        ...channel,
        enabled: channel.enabled ?? true,
        accounts: {
          ...channel.accounts,
          [accountId]: { ...current, ...patch },
        },
      },
    },
  };
}

export function clearAccountCredentials(cfg: OpenClawConfig, accountId: string): OpenClawConfig {
  const channel = channelConfig(cfg);
  const current = channel.accounts?.[accountId];
  if (!current) return cfg;
  const { accessToken: _accessToken, refreshToken: _refreshToken, clientId: _clientId, expiresAt: _expiresAt, ...rest } = current;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      agix: {
        ...channel,
        accounts: { ...channel.accounts, [accountId]: rest },
      },
    },
  };
}
