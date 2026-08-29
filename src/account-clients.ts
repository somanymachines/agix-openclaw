import type { AgixClient } from "./client.js";
import type { ResolvedAccount } from "./types.js";

export class AccountClientRegistry {
  private readonly clients = new Map<string, AgixClient>();

  set(account: ResolvedAccount, client: AgixClient): void {
    this.clients.set(key(account), client);
  }

  get(account: ResolvedAccount): AgixClient | undefined {
    return this.clients.get(key(account));
  }

  delete(account: ResolvedAccount, client: AgixClient): void {
    const accountKey = key(account);
    if (this.clients.get(accountKey) === client) this.clients.delete(accountKey);
  }

  deleteAccount(accountId: string): void {
    for (const accountKey of this.clients.keys()) {
      if (accountKey.startsWith(`${accountId}\0`)) this.clients.delete(accountKey);
    }
  }
}

function key(account: ResolvedAccount): string {
  return `${account.accountId}\0${account.apiUrl}\0${account.agent}`;
}
