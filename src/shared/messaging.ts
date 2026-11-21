import type { AgentActivity } from './agent-activity.js';

/** Messaging identities never authorize desktop control or device pairing. */
export interface ChatUser {
  /** Permanent, arbitrary-length decimal UID. Never convert to a number. */
  id: string;
  /** Qualified UID scoped to the account service, e.g. 10000000@chat.example.com. */
  address: string;
  kind: 'human' | 'agent';
  encrypted?: boolean;
  isAdmin?: boolean;
  avatarUrl?: string;
  username: string;
  displayName: string;
  createdAt: number;
}
export interface ChatContact extends ChatUser {
  remark: string;
  blocked: boolean;
}
export interface ChatAttachment {
  /** Ciphertext metadata remains signed even after the owner releases the file bytes. */
  removed?: boolean;
  encrypted?: string;
  id: string;
  name: string;
  size: number;
  mime: string;
  url: string;
}
export type MessageState = 'complete' | 'streaming' | 'cancelled' | 'failed';
export interface ChatQuestion {
  id: string;
  header: string;
  question: string;
  detail?: string;
  multiSelect?: boolean;
  options: { label: string; description: string }[];
}
export type InteractionInput = {
  kind: 'question' | 'approval';
  recipientId: string;
  title: string;
  description: string;
  questions?: ChatQuestion[];
  /** Absolute expiry, at most seven days ahead; defaults to 24 hours. */
  expiresAt?: number;
};
export type InteractionResponse =
  { decision: 'approve' | 'reject'; comment?: string } | { answers: Record<string, string[]> };
export interface ChatInteraction extends InteractionInput {
  id: string;
  expiresAt: number;
  status: 'pending' | 'answered' | 'approved' | 'rejected' | 'cancelled' | 'expired';
  response?: InteractionResponse;
  respondedBy?: string;
  respondedAt?: number;
}
export interface ChatSticker {
  encrypted?: string;
  id: string;
  name: string;
  mime: string;
  size: number;
  url: string;
}
export interface ChatMessage {
  /** Decrypted client-only retry contract, never a plaintext server field. */
  initialRequest?: { text: string; options: SendMessageOptions };
  id: string;
  sequence: number;
  conversationId: string;
  senderId: string;
  sender: ChatUser;
  clientId: string;
  text: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  state: MessageState;
  attachments: ChatAttachment[];
  mentions: string[];
  replyTo: string | null;
  interaction?: ChatInteraction;
  sticker?: boolean;
  /** Public activity milestones from the signed, encrypted Agent reply. */
  activities?: AgentActivity[];
}
export interface ChatMember extends ChatUser {
  role: 'owner' | 'member';
  readSequence: number;
}
export interface ChatConversation {
  readOnlyReason?: string;
  id: string;
  kind: 'direct' | 'group';
  name: string;
  ownerId: string | null;
  closed: boolean;
  peer: ChatUser | null;
  members: ChatMember[];
  lastMessage: ChatMessage | null;
  unread: number;
  readSequence: number;
  peerReadSequence: number;
}
export interface ChatEvent {
  sequence: number;
  type: 'message' | 'message.updated' | 'read' | 'contacts' | 'profile' | 'conversation' | 'call';
  conversationId: string | null;
  message?: ChatMessage;
}
export interface ChatSync {
  events: ChatEvent[];
  cursor: number;
}
export interface ChatHistory {
  messages: ChatMessage[];
  before?: number;
}
export interface SendMessageOptions {
  state?: 'complete' | 'streaming';
  attachmentIds?: string[];
  mentions?: string[];
  replyTo?: string;
  interaction?: InteractionInput;
  stickerId?: string;
}
/** Shared by browsers, command-line tools and Agent integrations. */
export interface MessagingClient {
  me(signal?: AbortSignal): Promise<{ user: ChatUser | null }>;
  contacts(signal?: AbortSignal): Promise<{ users: ChatContact[] }>;
  addContact(identifier: string): Promise<{ user: ChatUser }>;
  conversations(signal?: AbortSignal): Promise<{ conversations: ChatConversation[] }>;
  direct(userId: string): Promise<{ conversation: ChatConversation }>;
  history(id: string, before?: number, signal?: AbortSignal): Promise<ChatHistory>;
  send(
    id: string,
    text: string,
    clientId: string,
    options?: SendMessageOptions,
  ): Promise<{ message: ChatMessage }>;
  updateMessage(
    id: string,
    messageId: string,
    revision: number,
    text: string,
    state: MessageState,
    activities?: AgentActivity[],
  ): Promise<{ message: ChatMessage }>;
  read(id: string, sequence: number): Promise<{ ok: boolean }>;
  sync(cursor: number, wait?: number, signal?: AbortSignal): Promise<ChatSync>;
}
export interface AdminDailyActivity {
  day: string;
  messages: number;
  files: number;
  fileBytes: number;
  newUsers: number;
}
export interface AdminOverview {
  runtime?: 'cloudflare' | 'node';
  authority: string;
  retentionDays: number;
  generatedAt: number;
  policy?: {
    registrationEnabled: boolean;
    registrationRequiresCode: boolean;
    deviceLoginOnly: boolean;
    humanContacts: boolean;
  };
  users: { total: number; humans: number; agents: number; new24h: number; new7d: number };
  sessions: { active: number; active24h: number };
  desktops?: { total: number; active: number; revoked: number };
  conversations: { total: number; direct: number; group: number; closedGroups: number };
  messages: {
    total: number;
    last24h: number;
    expiredPending: number;
    streaming: number;
    pendingInteractions: number;
    oldestAt: number | null;
  };
  files: {
    total: number;
    bytes: number;
    expiredPending: number;
    orphanPending: number;
    oldestAt: number | null;
  };
  stickers: { total: number; bytes: number };
  avatars: { total: number; bytes: number };
  gcQueue: { pending: number; orphanMedia: number };
  dailyActivity: AdminDailyActivity[];
}
export interface AdminUserSummary {
  id: string;
  address: string;
  kind: 'human' | 'agent';
  ownerId: string | null;
  username: string;
  displayName: string;
  avatarUrl?: string;
  createdAt: number;
  encrypted: boolean;
  activeSessions: number;
  lastActiveAt: number | null;
  messageCount: number;
  fileCount: number;
  fileBytes: number;
  stickerCount: number;
  stickerBytes: number;
  hasAvatar: boolean;
}
export interface AdminSessionEntry {
  deviceId: string;
  userId: string;
  username: string;
  displayName: string;
  userKind: 'human' | 'agent';
  name: string;
  customName: string | null;
  platform: string | null;
  os: string | null;
  browser: string | null;
  ip: string | null;
  location: string | null;
  origin: string | null;
  createdAt: number | null;
  lastActiveAt: number | null;
  verifiedAt: number | null;
  expiresAt: number;
  current: boolean;
}
export interface AdminDesktopEntry {
  hostId: string;
  accountId: string;
  accountUsername: string | null;
  accountDisplayName: string | null;
  name: string;
  issuedAt: number;
  revokedAt: number | null;
}
export interface AdminUserDetail {
  user: AdminUserSummary;
  owner: { id: string; username: string; displayName: string } | null;
  ownedAgents: AdminUserSummary[];
  sessions: AdminSessionEntry[];
  desktops: AdminDesktopEntry[];
}
export interface AdminConversationSummary {
  id: string;
  kind: 'direct' | 'group';
  name: string;
  ownerId: string | null;
  closed: boolean;
  memberCount: number;
  messageCount: number;
  fileCount: number;
  fileBytes: number;
  lastMessageAt: number | null;
}
export interface AdminStorageConsumer {
  userId: string;
  username: string;
  displayName: string;
  kind: 'human' | 'agent';
  fileBytes: number;
  stickerBytes: number;
  avatarBytes: number;
  totalBytes: number;
  fileCount: number;
  stickerCount: number;
}
export interface AdminStorageDetail {
  retentionDays: number;
  files: { total: number; bytes: number; expiredPending: number; orphanPending: number };
  stickers: { total: number; bytes: number };
  avatars: { total: number; bytes: number };
  gcQueue: { key: string; notBefore: number }[];
  orphanMediaCount: number;
  topConsumers: AdminStorageConsumer[];
}
export interface AdminAuditEntry {
  id: number;
  createdAt: number;
  actorId: string;
  actorUsername: string | null;
  actorDisplayName: string | null;
  action: string;
  target: string | null;
  detail: string;
}
export interface AdminCleanupResult {
  deletedMessages: number;
  deletedFiles: number;
  deletedObjects: number;
  overview: AdminOverview;
}
