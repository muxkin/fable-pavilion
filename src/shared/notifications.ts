export const notificationId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type NotificationKind = 'message' | 'audio-call' | 'video-call' | 'call-cleared';
export interface NotificationEvent {
  kind: NotificationKind;
  id: string;
  conversation: string;
  expiresAt: number;
}
export interface NotificationConfig {
  webKey: string | null;
  android: boolean;
  registered: boolean;
  account: string;
}
