import { Prisma } from '@prisma/client';
import { D, ZERO, sum } from '../../common/money';
import { OrderFeeLine } from './ports';

/** Shape stored in Order.feesJson: the fee lines computed at placement. */
export interface StoredFeeLine {
  code: string;
  amount: string;
  label: string;
}

export function feesToJson(lines: readonly OrderFeeLine[]): Prisma.InputJsonValue {
  return lines.map((l) => ({ code: l.code, amount: l.amount.toFixed(), label: l.label }));
}

export function feeLinesFromJson(json: Prisma.JsonValue | null | undefined): StoredFeeLine[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return [];
    const o = item as Record<string, unknown>;
    if (typeof o.code !== 'string' || (typeof o.amount !== 'string' && typeof o.amount !== 'number')) return [];
    return [{ code: o.code, amount: String(o.amount), label: typeof o.label === 'string' ? o.label : o.code }];
  });
}

export interface FeeTotals {
  courtage: Prisma.Decimal;
  commission: Prisma.Decimal;
  taxes: Prisma.Decimal;
  total: Prisma.Decimal;
}

export function feesFromJson(json: Prisma.JsonValue | null | undefined): FeeTotals {
  const lines = feeLinesFromJson(json);
  const pick = (code: string): Prisma.Decimal => sum(lines.filter((l) => l.code === code).map((l) => D(l.amount)));
  const courtage = pick('COURTAGE_SDB');
  const commission = pick('COMMISSION_ALKE');
  const taxes = pick('TAXE');
  return { courtage, commission, taxes, total: courtage.plus(commission).plus(taxes) };
}

export const feeTotal = (lines: readonly OrderFeeLine[]): Prisma.Decimal => lines.reduce((acc, l) => acc.plus(l.amount), ZERO);
