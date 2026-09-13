import { OrderStatus, Prisma } from '@prisma/client';
import { D } from '../../common/money';

/**
 * Order state machine (blueprint §4.3) as pure functions. Every transition the
 * services perform — from files, cron or the back-office review executor — is
 * validated here, so the same rules hold whatever the trigger.
 *
 * PENDING → TRANSMITTED → ACKNOWLEDGED → PARTIALLY_EXECUTED → EXECUTED
 *    ↓          ↓              ↓                ↓
 * CANCELLED  REJECTED       EXPIRED          EXPIRED
 *
 * ADJUSTED is a terminal back-office correction reachable from any non-final state.
 */

export const FINAL_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  OrderStatus.EXECUTED,
  OrderStatus.REJECTED,
  OrderStatus.CANCELLED,
  OrderStatus.EXPIRED,
  OrderStatus.ADJUSTED,
]);

/** Statuses in which the SDB still holds the order and may execute it. */
export const OPEN_AT_SDB: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  OrderStatus.TRANSMITTED,
  OrderStatus.ACKNOWLEDGED,
  OrderStatus.PARTIALLY_EXECUTED,
]);

const TRANSITIONS: Record<OrderStatus, ReadonlySet<OrderStatus>> = {
  PENDING: new Set<OrderStatus>([OrderStatus.TRANSMITTED, OrderStatus.CANCELLED, OrderStatus.REJECTED, OrderStatus.ADJUSTED]),
  TRANSMITTED: new Set<OrderStatus>([
    OrderStatus.ACKNOWLEDGED,
    OrderStatus.REJECTED,
    OrderStatus.PARTIALLY_EXECUTED,
    OrderStatus.EXECUTED,
    OrderStatus.EXPIRED,
    OrderStatus.ADJUSTED,
  ]),
  ACKNOWLEDGED: new Set<OrderStatus>([OrderStatus.PARTIALLY_EXECUTED, OrderStatus.EXECUTED, OrderStatus.EXPIRED, OrderStatus.REJECTED, OrderStatus.ADJUSTED]),
  PARTIALLY_EXECUTED: new Set<OrderStatus>([OrderStatus.PARTIALLY_EXECUTED, OrderStatus.EXECUTED, OrderStatus.EXPIRED, OrderStatus.ADJUSTED]),
  EXECUTED: new Set<OrderStatus>(),
  REJECTED: new Set<OrderStatus>(),
  CANCELLED: new Set<OrderStatus>(),
  EXPIRED: new Set<OrderStatus>(),
  ADJUSTED: new Set<OrderStatus>(),
};

export function isFinal(status: OrderStatus): boolean {
  return FINAL_STATUSES.has(status);
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].has(to);
}

export class InvalidTransitionError extends Error {
  constructor(public readonly from: OrderStatus, public readonly to: OrderStatus) {
    super(`Transition ${from} → ${to} interdite.`);
  }
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export interface FillState {
  quantity: Prisma.Decimal;
  filledQuantity: Prisma.Decimal;
  avgExecutedPrice: Prisma.Decimal | null;
}

export interface FillResult {
  filledQuantity: Prisma.Decimal;
  avgExecutedPrice: Prisma.Decimal;
  status: typeof OrderStatus.PARTIALLY_EXECUTED | typeof OrderStatus.EXECUTED;
  remaining: Prisma.Decimal;
}

/** Applies one execution to the order's fill counters; refuses over-fills. */
export function applyFill(state: FillState, qty: Prisma.Decimal.Value, price: Prisma.Decimal.Value): FillResult {
  const q = D(qty);
  const p = D(price);
  if (!q.greaterThan(0)) throw new Error('Quantité exécutée invalide.');
  const filled = D(state.filledQuantity).plus(q);
  if (filled.greaterThan(state.quantity)) throw new Error('Exécution supérieure à la quantité de l’ordre.');
  const prevCost = D(state.filledQuantity).times(state.avgExecutedPrice ?? 0);
  const avg = prevCost.plus(q.times(p)).dividedBy(filled).toDecimalPlaces(4);
  const remaining = D(state.quantity).minus(filled);
  return {
    filledQuantity: filled,
    avgExecutedPrice: avg,
    status: remaining.isZero() ? OrderStatus.EXECUTED : OrderStatus.PARTIALLY_EXECUTED,
    remaining,
  };
}

/** Weighted average cost after adding `qty` at `price` to a position holding `heldQty` at `avgCost`. */
export function weightedAvgCost(
  heldQty: Prisma.Decimal.Value,
  avgCost: Prisma.Decimal.Value,
  qty: Prisma.Decimal.Value,
  price: Prisma.Decimal.Value,
): Prisma.Decimal {
  const total = D(heldQty).plus(qty);
  if (total.isZero()) return D(price);
  return D(heldQty).times(avgCost).plus(D(qty).times(price)).dividedBy(total).toDecimalPlaces(4);
}
