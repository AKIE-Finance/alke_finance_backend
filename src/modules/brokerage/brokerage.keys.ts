import { LedgerAccountKind, LedgerOwnerType } from '@prisma/client';
import { LedgerAccountRef } from '../ledger/ledger.types';

/** Idempotency keys for every ledger txn the brokerage module posts (ARCHITECTURE.md rule 2). */
export const BrokerageKeys = {
  reserve: (orderId: string) => `reserve:${orderId}`,
  release: (orderId: string) => `release:${orderId}`,
  fill: (executionId: string) => `fill:${executionId}`,
  settlement: (executionId: string) => `settlement:${executionId}`,
  settlementFailRelease: (executionId: string) => `settlement-fail-release:${executionId}`,
} as const;

export const userAccount = (userId: string, currency: string, kind: LedgerAccountKind): LedgerAccountRef => ({
  ownerType: LedgerOwnerType.USER,
  ownerId: userId,
  currency,
  kind,
});

export const sdbClearing = (partnerId: string, currency: string): LedgerAccountRef => ({
  ownerType: LedgerOwnerType.SDB,
  ownerId: partnerId,
  currency,
  kind: LedgerAccountKind.CLEARING,
});

export const feeAccount = (code: string, currency: string): LedgerAccountRef => ({
  ownerType: LedgerOwnerType.FEE,
  ownerId: code,
  currency,
  kind: LedgerAccountKind.AVAILABLE,
});

/** Actor ids used on events published by files and jobs. */
export const SYSTEM_ACTOR = 'SYSTEM';
export const SDB_FILE_ACTOR = 'SDB_FILE';
