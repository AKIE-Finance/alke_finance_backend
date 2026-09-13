import { FeeType, LedgerAccountKind, LedgerOwnerType, Prisma } from '@prisma/client';

/**
 * Typed payloads stored in PendingApproval.payload for the actions whose
 * executors live in this module. `read*` helpers validate the JSON before an
 * executor acts on it — a malformed payload fails the approval (state FAILED)
 * instead of doing something half-right.
 */

export interface LiveTradingTogglePayload {
  marketId: string;
  liveTrading: boolean;
}

export interface LedgerAdjustPayload {
  currency: string;
  entries: { account: { ownerType: LedgerOwnerType; ownerId: string; kind: LedgerAccountKind }; amount: string }[];
  description: string;
}

export interface LedgerReversalPayload {
  txnId: string;
  reason: string;
}

export interface ConfigChangePayload {
  key: string;
  value: Prisma.InputJsonValue;
}

export interface FeeChangePayload {
  marketId: string | null;
  feeType: FeeType;
  isPercentage: boolean;
  value: string;
  minAmount: string | null;
  maxAmount: string | null;
  label: string;
}

export interface PaymentForceCompletePayload {
  intentId: string;
}

export interface UserUnblockPayload {
  userId: string;
}

function asRecord(payload: Prisma.JsonValue): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Charge utile de la demande invalide.');
  }
  return payload as Record<string, unknown>;
}

function str(rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`Champ « ${key} » manquant dans la demande.`);
  return v;
}

function bool(rec: Record<string, unknown>, key: string): boolean {
  const v = rec[key];
  if (typeof v !== 'boolean') throw new Error(`Champ « ${key} » manquant dans la demande.`);
  return v;
}

function optStr(rec: Record<string, unknown>, key: string): string | null {
  const v = rec[key];
  return typeof v === 'string' && v.trim() ? v : null;
}

export function readLiveTradingToggle(payload: Prisma.JsonValue): LiveTradingTogglePayload {
  const rec = asRecord(payload);
  return { marketId: str(rec, 'marketId'), liveTrading: bool(rec, 'liveTrading') };
}

export function readLedgerAdjust(payload: Prisma.JsonValue): LedgerAdjustPayload {
  const rec = asRecord(payload);
  const raw = rec.entries;
  if (!Array.isArray(raw) || raw.length < 2) throw new Error('Un ajustement comporte au moins deux écritures.');
  const entries = raw.map((e) => {
    const entry = asRecord(e as Prisma.JsonValue);
    const account = asRecord(entry.account as Prisma.JsonValue);
    const ownerType = str(account, 'ownerType');
    const kind = str(account, 'kind');
    if (!(Object.values(LedgerOwnerType) as string[]).includes(ownerType)) throw new Error(`Type de propriétaire inconnu : ${ownerType}.`);
    if (!(Object.values(LedgerAccountKind) as string[]).includes(kind)) throw new Error(`Type de compte inconnu : ${kind}.`);
    return {
      account: { ownerType: ownerType as LedgerOwnerType, ownerId: str(account, 'ownerId'), kind: kind as LedgerAccountKind },
      amount: String(entry.amount),
    };
  });
  return { currency: str(rec, 'currency'), entries, description: str(rec, 'description') };
}

export function readLedgerReversal(payload: Prisma.JsonValue): LedgerReversalPayload {
  const rec = asRecord(payload);
  return { txnId: str(rec, 'txnId'), reason: str(rec, 'reason') };
}

export function readConfigChange(payload: Prisma.JsonValue): ConfigChangePayload {
  const rec = asRecord(payload);
  if (rec.value === undefined) throw new Error('Champ « value » manquant dans la demande.');
  return { key: str(rec, 'key'), value: rec.value as Prisma.InputJsonValue };
}

export function readFeeChange(payload: Prisma.JsonValue): FeeChangePayload {
  const rec = asRecord(payload);
  const feeType = str(rec, 'feeType');
  if (!(Object.values(FeeType) as string[]).includes(feeType)) throw new Error(`Type de frais inconnu : ${feeType}.`);
  return {
    marketId: optStr(rec, 'marketId'),
    feeType: feeType as FeeType,
    isPercentage: bool(rec, 'isPercentage'),
    value: String(rec.value),
    minAmount: rec.minAmount == null ? null : String(rec.minAmount),
    maxAmount: rec.maxAmount == null ? null : String(rec.maxAmount),
    label: str(rec, 'label'),
  };
}

export function readPaymentForceComplete(payload: Prisma.JsonValue): PaymentForceCompletePayload {
  return { intentId: str(asRecord(payload), 'intentId') };
}

export function readUserUnblock(payload: Prisma.JsonValue): UserUnblockPayload {
  return { userId: str(asRecord(payload), 'userId') };
}
