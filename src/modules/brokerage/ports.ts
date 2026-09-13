import { Prisma } from '@prisma/client';

/**
 * Ports consumed by the brokerage module and bound by the integrator in
 * app.module.ts:
 *   { provide: FEES_PORT, useExisting: FeesService }
 *   { provide: WITHDRAWAL_SETTLEMENT_PORT, useExisting: PaymentsService }
 */

export type OrderFeeCode = 'COURTAGE_SDB' | 'COMMISSION_ALKE' | 'TAXE';

export interface OrderFeeLine {
  code: OrderFeeCode;
  amount: Prisma.Decimal;
  label: string;
}

export interface FeesPort {
  computeOrderFees(marketId: string, gross: Prisma.Decimal, currency: string): Promise<OrderFeeLine[]>;
}
export const FEES_PORT = Symbol('FEES_PORT');

export interface WithdrawalSettlementPort {
  markWithdrawalPaid(intentId: string, externalRef: string, source: string): Promise<void>;
  failWithdrawal(intentId: string, reason: string): Promise<void>;
}
export const WITHDRAWAL_SETTLEMENT_PORT = Symbol('WITHDRAWAL_SETTLEMENT_PORT');
