export type AgixCredentials = {
  accessToken: string;
  refreshToken?: string;
  clientId?: string;
  expiresAt?: number;
};

export type AgixAccountConfig = Partial<AgixCredentials> & {
  enabled?: boolean;
  agent: string;
};

export type AgixChannelConfig = {
  enabled?: boolean;
  apiUrl?: string;
  accounts?: Record<string, AgixAccountConfig>;
};

export type ResolvedAgixAccount = AgixCredentials & {
  accountId: string;
  agent: string;
  apiUrl: string;
  enabled: boolean;
};

export type AgixUser = {
  handle: string;
  name: string;
  about: string;
};

export type AgixAgent = {
  address: string;
  name: string;
  owner: AgixUser;
  about: string;
  connected: boolean;
  instructions: string;
};

export type AgixMessage = {
  id: string;
  conversation_id: string;
  author: string;
  content: string;
  created_at: string;
  processed: boolean;
};

export type AgixInbox = {
  messages: AgixMessage[];
  next_cursor: string | null;
};

export type AgixConversationPage = {
  conversation: {
    id: string;
    participants: [string, string];
    created_at: string;
    updated_at: string;
  };
  messages: AgixSentMessage[];
  next_cursor: string | null;
};

export type AgixSentMessage = {
  id: string;
  author: string;
  content: string;
  created_at: string;
};

export type AgixSendResult = AgixSentMessage;
