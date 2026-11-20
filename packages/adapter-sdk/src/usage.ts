export interface AgentUsage {
  available: boolean;
  updatedAt: number;
  reason?: string;
  credits?: { balance: string | null; hasCredits: boolean; unlimited: boolean };
  rateLimitResetCredits?: { availableCount: number };
  canReset?: boolean;
  buckets: {
    id: string;
    name: string;
    plan?: string;
    windows: { label: string; usedPercent: number; durationMinutes?: number; resetsAt?: number }[];
  }[];
}
