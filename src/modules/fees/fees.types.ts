import { FeeType, Prisma } from '@prisma/client';
import { FeeCode } from '../ledger/ledger.types';

/** Fee codes charged on an order (blueprint §3.2). FX_SPREAD and WITHDRAWAL are charged elsewhere. */
export const ORDER_FEE_TYPES = [FeeType.COURTAGE_SDB, FeeType.COMMISSION_ALKE, FeeType.TAXE] as const;
export type OrderFeeCode = Extract<FeeCode, 'COURTAGE_SDB' | 'COMMISSION_ALKE' | 'TAXE'>;

/** One fee to post as a ledger line: user AVAILABLE -amount / FEE:<code> AVAILABLE +amount. */
export interface FeeLine {
  code: OrderFeeCode;
  amount: Prisma.Decimal;
  label: string;
  scheduleId: string;
}
