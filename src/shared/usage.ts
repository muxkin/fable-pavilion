import type { AgentUsage } from '../../packages/adapter-sdk/src/usage.js';

export interface UsageSnapshot {
  state: 'loading' | 'current' | 'stale' | 'unavailable';
  value?: AgentUsage;
}

export interface UsageResetScope {
  hostId: string;
  deviceId: string;
  backendId: string;
  requestId: string;
}

export interface UsageResetResult {
  outcome: 'reset' | 'alreadyRedeemed' | 'noCredit' | 'nothingToReset';
  usage: AgentUsage | null;
}
