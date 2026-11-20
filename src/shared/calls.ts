export type CallMode = 'audio' | 'video';
export interface AgentCall {
  id: string;
  conversationId: string;
  callerId: string;
  recipientId?: string;
  agentId: string;
  mode: CallMode;
  state: 'ringing' | 'active' | 'ended';
  reason: string;
  createdAt: number;
}
export const callRecipient = (call: AgentCall) => call.recipientId ?? call.agentId;
export const callPeer = (call: AgentCall, user: string) =>
  call.callerId === user ? callRecipient(call) : call.callerId;
export interface CallSignal {
  id: string;
  sequence: number;
  senderId: string;
  encrypted: string;
}
export type CallPayload =
  | { type: 'description'; description: { type: 'offer' | 'answer'; sdp: string } }
  | {
      type: 'candidate';
      candidate: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null };
    };
export interface CallIceServer {
  urls: string[];
  username?: string;
  credential?: string;
}
export interface CallCapabilities {
  audio: boolean;
  video: boolean;
  expiresAt: number;
}
