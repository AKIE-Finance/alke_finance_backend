import { PaymentIntent, PaymentProvider } from '@prisma/client';

export type ProviderStatus = 'PENDING' | 'PAID' | 'FAILED';

export interface CollectionResult {
  providerRef?: string;
  status: ProviderStatus;
  /** Hosted checkout page (CinetPay) the client must open to pay. */
  paymentUrl?: string;
  raw?: unknown;
}

export interface StatusResult {
  status: ProviderStatus;
  providerRef?: string;
  /** Provider's own status word, stored as PaymentIntent.providerStatus. */
  providerStatus?: string;
  reason?: string;
  raw: unknown;
}

export type WebhookHeaders = Record<string, string | string[] | undefined>;

/**
 * Adapter contract for mobile-money / aggregator providers (blueprint §4.8).
 * A callback is only a hint: the service always re-queries `queryStatus`
 * before crediting the ledger.
 */
export interface PaymentProviderPort {
  readonly provider: PaymentProvider;
  /** Asks the provider to collect `intent.amount` from `intent.msisdn`. */
  requestCollection(intent: PaymentIntent): Promise<CollectionResult>;
  /** Authoritative status of a collection request. */
  queryStatus(intent: PaymentIntent): Promise<StatusResult>;
  /** Validates a callback signature when the provider offers one (undefined otherwise). */
  verifyCallback?(headers: WebhookHeaders, body: unknown): boolean;
}

export function headerValue(headers: WebhookHeaders, name: string): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(raw) ? raw[0] : raw;
}
