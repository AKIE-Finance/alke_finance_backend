import { LedgerAccountKind, LedgerOwnerType, LedgerTxn, LedgerTxnType, Prisma } from '@prisma/client';

/**
 * Ledger contract (blueprint §4.4). Implemented by LedgerService; consumed by
 * payments, brokerage, reconciliation and admin. This file is the agreed
 * interface between modules — change it deliberately.
 *
 * Invariants the implementation guarantees:
 *  - every posted transaction's entries sum to exactly zero;
 *  - entries are never updated or deleted; corrections are REVERSAL txns;
 *  - a second post with the same idempotencyKey returns the first txn and
 *    writes nothing;
 *  - a debit that would take a USER account below zero is refused inside the
 *    same database transaction that reads the balance (SELECT ... FOR UPDATE on
 *    the account row), so concurrent requests cannot double-spend.
 */

export interface LedgerAccountRef {
  ownerType: LedgerOwnerType;
  ownerId: string; // User.id, MarketPartner.id, fee code, PaymentProvider, or "SYSTEM"
  currency: string;
  kind: LedgerAccountKind;
}

export interface LedgerEntryInput {
  account: LedgerAccountRef;
  /** Signed. Positive credits the account, negative debits it. */
  amount: Prisma.Decimal.Value;
}

export interface PostTxnInput {
  type: LedgerTxnType;
  idempotencyKey: string;
  currency: string;
  entries: LedgerEntryInput[];
  source: string; // PAYMENT_WEBHOOK | ORDER | EXE_FILE | CSH_FILE | ADMIN | JOB
  actorId?: string | null;
  refType?: string;
  refId?: string;
  externalReference?: string;
  description?: string;
  metadata?: Prisma.InputJsonValue;
  /** Accounts that may not go negative as a result of this txn (default: every USER account touched). */
  enforceNonNegative?: LedgerAccountRef[];
}

export interface BalanceSnapshot {
  available: Prisma.Decimal;
  reserved: Prisma.Decimal;
  settling: Prisma.Decimal;
  withdrawable: Prisma.Decimal;
  currency: string;
}

export interface LedgerPort {
  /** Idempotent, atomic post. Optionally runs inside a caller-provided transaction client. */
  post(input: PostTxnInput, tx?: Prisma.TransactionClient): Promise<LedgerTxn>;

  /** Posts a REVERSAL of `txnId` (all entries negated) and marks the original REVERSED. Idempotent on `reversal:<txnId>`. */
  reverse(txnId: string, reason: string, actorId: string | null, tx?: Prisma.TransactionClient): Promise<LedgerTxn>;

  /** SUM(entries) for one account (0 when the account does not exist). */
  balance(account: LedgerAccountRef, tx?: Prisma.TransactionClient): Promise<Prisma.Decimal>;

  /** All kinds for a user in one currency. */
  userBalances(userId: string, currency: string, tx?: Prisma.TransactionClient): Promise<BalanceSnapshot>;

  /** Every currency in which the user has any account. */
  userCurrencies(userId: string): Promise<string[]>;

  /** Entries for a user's accounts, newest first, for the transaction-history screen. */
  userStatement(userId: string, currency: string, limit?: number): Promise<UserStatementLine[]>;

  /** Ledger-wide invariant check: SUM of all entries per txn = 0 and per currency = 0. */
  verifyInvariants(): Promise<{ ok: boolean; unbalancedTxnIds: string[] }>;

  /** Mirror principle (§4.4): SUM(user AVAILABLE + RESERVED + SETTLING) per currency. */
  mirrorTotal(currency: string): Promise<Prisma.Decimal>;
}

export interface UserStatementLine {
  txnId: string;
  type: LedgerTxnType;
  kind: LedgerAccountKind;
  amount: Prisma.Decimal;
  currency: string;
  description: string | null;
  refType: string | null;
  refId: string | null;
  postedAt: Date;
}

/** Well-known system owner ids. */
export const SYSTEM_OWNER = 'SYSTEM';
export const FEE_CODES = ['COURTAGE_SDB', 'COMMISSION_ALKE', 'FX_SPREAD', 'TAXE', 'WITHDRAWAL'] as const;
export type FeeCode = (typeof FEE_CODES)[number];

export const LEDGER_PORT = Symbol('LEDGER_PORT');

// --- Additive extensions (ledger implementation) --------------------------------

/** Kinds that make up the mirror total (§4.4): what the SDB cash account must cover. */
export const MIRROR_KINDS = [LedgerAccountKind.AVAILABLE, LedgerAccountKind.RESERVED, LedgerAccountKind.SETTLING] as const;

/** Richer result of `verifyInvariants` (superset of the contract's `{ ok, unbalancedTxnIds }`). */
export interface InvariantReport {
  ok: boolean;
  unbalancedTxnIds: string[];
  /** Currencies whose entries do not sum to zero. */
  unbalancedCurrencies: string[];
  /** USER accounts whose balance is below zero. */
  negativeUserAccountIds: string[];
}

export interface AccountBalance extends LedgerAccountRef {
  accountId: string;
  balance: Prisma.Decimal;
}

/** Idempotency-key conventions used across modules (ARCHITECTURE.md rule 2). */
export const LedgerKeys = {
  deposit: (intentId: string) => `deposit:${intentId}`,
  withdrawReserve: (intentId: string) => `withdraw-reserve:${intentId}`,
  withdraw: (intentId: string) => `withdraw:${intentId}`,
  withdrawRelease: (intentId: string) => `withdraw-release:${intentId}`,
  reversal: (txnId: string) => `reversal:${txnId}`,
} as const;
