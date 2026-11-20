import type { AgentUsage } from '../../adapter-sdk/src/usage.js';

/** Forward only display fields, never account identifiers or reset-credit IDs. */
export function codexUsage(value: any, now = Date.now()): AgentUsage {
  const limits =
    value?.rateLimitsByLimitId && Object.keys(value.rateLimitsByLimitId).length
      ? Object.entries(value.rateLimitsByLimitId)
      : value?.rateLimits
        ? [[value.rateLimits.limitId ?? 'codex', value.rateLimits]]
        : [];
  const buckets = limits.flatMap(([id, raw]: any) => {
    if (!raw || typeof raw !== 'object') return [];
    const windows = ['primary', 'secondary'].flatMap((key, index) => {
      const window = raw[key];
      if (typeof window?.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) return [];
      const minutes =
        typeof window.windowDurationMins === 'number' && window.windowDurationMins > 0
          ? window.windowDurationMins
          : undefined;
      return [
        {
          label:
            minutes === 10080
              ? '每周用量'
              : minutes === 300
                ? '5 小时用量'
                : minutes
                  ? `${minutes} 分钟用量`
                  : index
                    ? '长期用量'
                    : '当前用量',
          usedPercent: Math.max(0, Math.min(100, window.usedPercent)),
          ...(minutes ? { durationMinutes: minutes } : {}),
          ...(Number.isFinite(window.resetsAt) && window.resetsAt > 0
            ? { resetsAt: window.resetsAt * 1000 }
            : {}),
        },
      ];
    });
    return windows.length
      ? [
          {
            id: String(id),
            name: typeof raw.limitName === 'string' ? raw.limitName : String(id),
            ...(typeof raw.planType === 'string' ? { plan: raw.planType } : {}),
            windows,
          },
        ]
      : [];
  });
  const rawCredits = value?.rateLimitsByLimitId?.codex?.credits ?? value?.rateLimits?.credits;
  const credits =
    typeof rawCredits?.hasCredits === 'boolean' && typeof rawCredits.unlimited === 'boolean'
      ? {
          balance: typeof rawCredits.balance === 'string' ? rawCredits.balance : null,
          hasCredits: rawCredits.hasCredits,
          unlimited: rawCredits.unlimited,
        }
      : undefined;
  const availableCount = value?.rateLimitResetCredits?.availableCount;
  const resetCredits =
    Number.isSafeInteger(availableCount) && availableCount >= 0 ? { availableCount } : undefined;
  const available = buckets.length > 0 || !!credits || !!resetCredits;
  return {
    available,
    updatedAt: now,
    buckets,
    ...(credits ? { credits } : {}),
    ...(resetCredits ? { rateLimitResetCredits: resetCredits } : {}),
    ...(!available ? { reason: '当前账户暂未提供用量信息' } : {}),
  };
}
