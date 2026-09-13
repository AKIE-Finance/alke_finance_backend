import { Prisma } from '@prisma/client';

/**
 * Money helpers. All arithmetic on amounts goes through Prisma.Decimal; the
 * `number` type never carries money past an API boundary. XAF and XOF are
 * zero-decimal currencies: amounts in those currencies are integers.
 */
export type Money = Prisma.Decimal;
export const D = (v: Prisma.Decimal.Value): Money => new Prisma.Decimal(v);
export const ZERO = D(0);

const ZERO_DECIMAL_CURRENCIES = new Set(['XAF', 'XOF', 'GNF', 'RWF', 'UGX', 'JPY', 'KRW']);

export function decimalsFor(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2;
}

/** Round to the currency's minor unit, half-up (accounting convention). */
export function roundMoney(amount: Prisma.Decimal.Value, currency: string): Money {
  return D(amount).toDecimalPlaces(decimalsFor(currency), Prisma.Decimal.ROUND_HALF_UP);
}

export function isPositive(amount: Prisma.Decimal.Value): boolean {
  return D(amount).greaterThan(0);
}

export function sum(values: Prisma.Decimal.Value[]): Money {
  return values.reduce<Money>((acc, v) => acc.plus(v), ZERO);
}

/** Percentage fee with optional floor/cap, rounded to the currency. */
export function percentageFee(
  base: Prisma.Decimal.Value,
  percent: Prisma.Decimal.Value,
  currency: string,
  min?: Prisma.Decimal.Value | null,
  max?: Prisma.Decimal.Value | null,
): Money {
  let fee = D(base).times(percent).dividedBy(100);
  if (min != null && fee.lessThan(min)) fee = D(min);
  if (max != null && fee.greaterThan(max)) fee = D(max);
  return roundMoney(fee, currency);
}

export function toApi(amount: Prisma.Decimal.Value | null | undefined): string | null {
  return amount == null ? null : D(amount).toFixed();
}
