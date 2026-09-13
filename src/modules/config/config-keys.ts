/** Well-known ConfigValue keys (seeded by prisma/seed.ts) with their fallbacks. */
export const CONFIG_KEYS = {
  pilotDepositCapXaf: 'pilot.deposit_cap_xaf',
  withdrawalDailyCapXaf: 'withdrawal.daily_cap_xaf',
  paymentIntentTtlMinutes: 'payment.intent_ttl_minutes',
  withdrawalIntentTtlDays: 'withdrawal.intent_ttl_days',
} as const;

export const CONFIG_DEFAULTS = {
  [CONFIG_KEYS.pilotDepositCapXaf]: 500_000,
  [CONFIG_KEYS.withdrawalDailyCapXaf]: 500_000,
  [CONFIG_KEYS.paymentIntentTtlMinutes]: 15,
  [CONFIG_KEYS.withdrawalIntentTtlDays]: 7,
} as const;
