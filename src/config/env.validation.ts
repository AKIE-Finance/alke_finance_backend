/**
 * Environment validation, run once by ConfigModule at boot.
 *
 * Fails fast on the mistakes that are cheap to catch here and expensive in
 * production: a placeholder JWT secret, demo OTP outside a developer machine,
 * simulated payments on a real-money environment. No external dependency.
 *
 * Blueprint v3.2 references: §4.0 (security floor), §4.1 (feature flags
 * SDB_CONNECTOR / PAYMENTS / KYC), D15 (no simulated economy for pilot users).
 */

export const APP_ENVS = ['local', 'staging', 'pilot', 'production'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

export const PAYMENTS_MODES = ['simulated', 'sandbox', 'live'] as const;
export const SDB_CONNECTORS = ['simulated', 'file', 'sftp', 'api'] as const;
export const KYC_MODES = ['simulated', 'smileid'] as const;

const REAL_MONEY: ReadonlySet<string> = new Set<AppEnv>(['pilot', 'production']);

function oneOf(value: unknown, allowed: readonly string[], key: string, errors: string[]): string {
  const v = String(value);
  if (!allowed.includes(v)) errors.push(`${key} must be one of ${allowed.join('|')} (got "${v}")`);
  return v;
}

export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const errors: string[] = [];

  const appEnv = oneOf(config.APP_ENV ?? 'local', APP_ENVS, 'APP_ENV', errors) as AppEnv;
  const isLocal = appEnv === 'local';
  const realMoney = REAL_MONEY.has(appEnv);

  for (const key of ['DATABASE_URL', 'JWT_SECRET']) {
    if (!config[key]) errors.push(`${key} is required`);
  }

  const jwtSecret = String(config.JWT_SECRET ?? '');
  if (!isLocal && jwtSecret.length < 32) errors.push('JWT_SECRET must be at least 32 characters outside local');
  if (!isLocal && /change-me/i.test(jwtSecret)) errors.push('JWT_SECRET still carries the .env.example placeholder');

  const otpDemo = String(config.OTP_DEMO_MODE ?? 'false') === 'true';
  if (otpDemo && !isLocal) errors.push('OTP_DEMO_MODE=true is only allowed when APP_ENV=local');

  const paymentsMode = oneOf(config.PAYMENTS_MODE ?? (isLocal ? 'simulated' : 'sandbox'), PAYMENTS_MODES, 'PAYMENTS_MODE', errors);
  if (paymentsMode === 'live' && !realMoney) errors.push('PAYMENTS_MODE=live is only allowed when APP_ENV is pilot or production');
  if (paymentsMode === 'simulated' && realMoney) errors.push('PAYMENTS_MODE=simulated is forbidden when APP_ENV is pilot or production');

  const sdbConnector = oneOf(config.SDB_CONNECTOR ?? 'simulated', SDB_CONNECTORS, 'SDB_CONNECTOR', errors);
  const kycMode = oneOf(config.KYC_MODE ?? 'simulated', KYC_MODES, 'KYC_MODE', errors);
  if (kycMode === 'simulated' && realMoney) errors.push('KYC_MODE=simulated is forbidden when APP_ENV is pilot or production');

  const port = Number(config.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push(`PORT must be an integer between 1 and 65535 (got "${config.PORT}")`);

  if (!isLocal && config.CORS_ORIGINS === undefined) {
    errors.push('CORS_ORIGINS (comma-separated list of allowed origins) is required outside local');
  }

  if (errors.length) {
    throw new Error(`Invalid environment configuration:\n - ${errors.join('\n - ')}`);
  }

  return { ...config, APP_ENV: appEnv, PAYMENTS_MODE: paymentsMode, SDB_CONNECTOR: sdbConnector, KYC_MODE: kycMode, PORT: port };
}
