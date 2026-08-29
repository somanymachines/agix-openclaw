import { createHash, randomBytes } from "node:crypto";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup-runtime";
import type { Agent, Credentials } from "./types.js";

type OAuthMetadata = {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
};

type RegisteredClient = { client_id: string };
type TokenResponse = { access_token: string; refresh_token?: string; expires_in?: number };

export type OAuthLoginResult = {
  credentials: Credentials;
  agents: Agent[];
};

const CREATE_AGENT = "__create_agent__";

export async function loginToAgix(input: {
  apiUrl: string;
  accountId?: string | null;
  prompter: WizardPrompter;
  fetch?: typeof fetch;
}): Promise<OAuthLoginResult> {
  const fetchImpl = input.fetch ?? fetch;
  const apiUrl = input.apiUrl.replace(/\/$/, "");
  const origin = new URL(apiUrl).origin;
  const metadataResponse = await fetchImpl(`${origin}/.well-known/oauth-authorization-server`);
  if (!metadataResponse.ok) throw new Error(`Could not start agix login (HTTP ${metadataResponse.status}). Check the agix API URL and try again.`);
  const metadata = await metadataResponse.json() as OAuthMetadata;
  const redirectUri = "http://127.0.0.1:1456/callback";
  const registration = await fetchImpl(metadata.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "OpenClaw agix plugin",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (!registration.ok) throw new Error(`Could not register OpenClaw with agix (HTTP ${registration.status}).`);
  const { client_id: clientId } = await registration.json() as RegisteredClient;
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const state = base64Url(randomBytes(24));
  const authorize = new URL(metadata.authorization_endpoint);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "agix",
    resource: apiUrl,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  }).toString();

  await input.prompter.note(
    `Open this URL in your browser:\n\n${authorize}\n\nAuthorize OpenClaw, then copy the complete localhost callback URL from your browser's address bar. If your Gateway is running remotely, the callback page may not load; that's expected.`,
    "Connect to agix",
  );
  const callbackText = await input.prompter.text({
    message: "Paste the complete callback URL",
    validate: (value) => validateCallback(value, state),
  });
  const callback = new URL(callbackText.trim());
  const code = callback.searchParams.get("code");
  if (!code) throw new Error("This callback URL doesn't include an authorization code. Complete authorization in agix, then paste the new callback URL.");

  const tokenResponse = await fetchImpl(metadata.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource: apiUrl,
    }),
  });
  if (!tokenResponse.ok) throw new Error(`Could not complete agix authorization (HTTP ${tokenResponse.status}).`);
  const token = await tokenResponse.json() as TokenResponse;
  const credentials: Credentials = {
    accessToken: token.access_token,
    ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
    clientId,
    expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
  };
  const agentsResponse = await fetchImpl(`${apiUrl}/me/agents?limit=100`, {
    headers: { authorization: `Bearer ${credentials.accessToken}` },
  });
  if (!agentsResponse.ok) throw new Error(`Could not load your agix agents (HTTP ${agentsResponse.status}).`);
  const { agents } = await agentsResponse.json() as { agents: Agent[] };
  if (!agents.length) {
    const agent = await createAgent({
      apiUrl,
      accessToken: credentials.accessToken,
      first: true,
      ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
      prompter: input.prompter,
      fetch: fetchImpl,
    });
    return { credentials, agents: [agent] };
  }
  const requested = input.accountId && input.accountId !== "default" ? input.accountId : undefined;
  const initial = requested && agents.some((agent) => agent.name === requested) ? requested : agents[0]!.name;
  const choices = await input.prompter.multiselect({
    message: "Which agix agents do you want OpenClaw to operate?",
    options: [
      ...agents.map((agent) => ({
        value: agent.name,
        label: agent.address,
        ...(agent.about ? { hint: agent.about } : {}),
      })),
      { value: CREATE_AGENT, label: "Create a new agent…" },
    ],
    initialValues: [initial],
  });
  if (!choices.length) throw new Error("Select at least one agix agent to connect.");

  const selected = agents.filter((agent) => choices.includes(agent.name));
  if (choices.includes(CREATE_AGENT)) {
    selected.push(await createAgent({
      apiUrl,
      accessToken: credentials.accessToken,
      first: false,
      prompter: input.prompter,
      fetch: fetchImpl,
    }));
  }
  return { credentials, agents: selected };
}

async function createAgent(input: {
  apiUrl: string;
  accessToken: string;
  first: boolean;
  accountId?: string | null;
  prompter: WizardPrompter;
  fetch: typeof fetch;
}): Promise<Agent> {
  await input.prompter.note(
    input.first
      ? "This agix identity doesn't have any agents yet. Create one for OpenClaw to operate."
      : "Create another agix agent for OpenClaw to operate.",
    input.first ? "Create your first agent" : "Create a new agent",
  );
  const requested = input.accountId && input.accountId !== "default" && validateAgentName(input.accountId) === undefined
    ? input.accountId
    : undefined;
  const name = (await input.prompter.text({
    message: "Choose its agent name",
    placeholder: "assistant",
    ...(requested ? { initialValue: requested } : {}),
    validate: validateAgentName,
  })).trim();
  const about = (await input.prompter.text({
    message: "What can this agent do? (public, optional)",
    placeholder: "Coordinates plans and handles everyday tasks.",
  })).trim();
  const instructions = (await input.prompter.text({
    message: "Anything it should know? (private, optional)",
    placeholder: "Ask me before making purchases.",
  })).trim();
  const shouldCreate = await input.prompter.confirm({
    message: `Create and connect the agent “${name}”?`,
    initialValue: true,
  });
  if (!shouldCreate) throw new Error("Agent creation cancelled.");

  const response = await input.fetch(`${input.apiUrl}/me/agents`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name, about, instructions }),
  });
  if (!response.ok) throw new Error(`Could not create your agix agent (HTTP ${response.status}).`);
  return await response.json() as Agent;
}

function validateAgentName(value: string): string | undefined {
  const name = value.trim();
  if (!name) return "Enter an agent name.";
  if (name.length > 32) return "Use 32 characters or fewer.";
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) return "Start with a lowercase letter, then use lowercase letters, numbers, hyphens, or underscores.";
  return undefined;
}

export function validateCallback(value: string, state: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.origin !== "http://127.0.0.1:1456" || url.pathname !== "/callback") return "Paste the complete localhost callback URL from your browser's address bar.";
    if (url.searchParams.get("state") !== state) return "This callback is from a different login attempt. Paste the callback URL from the browser tab you just opened.";
    if (!url.searchParams.get("code")) return "This callback URL doesn't include an authorization code. Complete authorization in agix, then paste the new callback URL.";
    return undefined;
  } catch {
    return "Paste the complete callback URL, starting with `http://127.0.0.1:1456/callback`.";
  }
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}
