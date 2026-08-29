import type { Client } from "./client.js";
import type { ResolvedAccount } from "./types.js";

export class AccountClientRegistry {
  private readonly clients = new Map<string, Client>();
  private readonly credentialClients = new Map<string, Client>();

  set(account: ResolvedAccount, client: Client): void {
    this.clients.set(key(account), client);
    this.credentialClients.set(credentialKey(account), client);
  }

  get(account: ResolvedAccount): Client | undefined {
    return this.clients.get(key(account));
  }

  getShared(account: ResolvedAccount): Client | undefined {
    return this.credentialClients.get(credentialKey(account));
  }

  delete(account: ResolvedAccount, client: Client): void {
    const accountKey = key(account);
    if (this.clients.get(accountKey) === client) this.clients.delete(accountKey);
    this.removeSharedClientWhenUnused(account, client);
  }

  deleteAccount(accountId: string): void {
    const removed = new Set<Client>();
    for (const accountKey of this.clients.keys()) {
      if (!accountKey.startsWith(`${accountId}\0`)) continue;
      const client = this.clients.get(accountKey);
      if (client) removed.add(client);
      this.clients.delete(accountKey);
    }
    for (const [credentials, client] of this.credentialClients) {
      if (removed.has(client) && ![...this.clients.values()].includes(client)) {
        this.credentialClients.delete(credentials);
      }
    }
  }

  private removeSharedClientWhenUnused(account: ResolvedAccount, client: Client): void {
    if ([...this.clients.values()].includes(client)) return;
    const credentials = credentialKey(account);
    if (this.credentialClients.get(credentials) === client) this.credentialClients.delete(credentials);
  }
}

function key(account: ResolvedAccount): string {
  return `${account.accountId}\0${account.apiUrl}\0${account.agent}`;
}

function credentialKey(account: ResolvedAccount): string {
  return `${account.apiUrl}\0${account.clientId ?? account.accessToken}`;
}
