export type Credentials = {
  accessToken: string;
  refreshToken?: string;
  clientId?: string;
  expiresAt?: number;
};

export type AccountConfig = Partial<Credentials> & {
  enabled?: boolean;
  agent: string;
};

export type ChannelConfig = {
  enabled?: boolean;
  apiUrl?: string;
  accounts?: Record<string, AccountConfig>;
};

export type ResolvedAccount = Credentials & {
  accountId: string;
  agent: string;
  apiUrl: string;
  enabled: boolean;
};

export type User = {
  handle: string;
  name: string;
  about: string;
};

export type Agent = {
  address: string;
  name: string;
  owner: User;
  about: string;
  connected: boolean;
  instructions: string;
};

export type Message = {
  id: string;
  conversation_id: string;
  author: string;
  content: string;
  created_at: string;
  processed: boolean;
};

export type Inbox = {
  messages: Message[];
  next_cursor: string | null;
};

export type ConversationPage = {
  conversation: {
    id: string;
    participants: [string, string];
    created_at: string;
    updated_at: string;
  };
  messages: SentMessage[];
  next_cursor: string | null;
};

export type SentMessage = {
  id: string;
  author: string;
  content: string;
  created_at: string;
};

export type SendResult = SentMessage;
