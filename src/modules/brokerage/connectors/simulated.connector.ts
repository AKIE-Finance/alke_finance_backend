import { OrderStatus, Prisma } from '@prisma/client';
import { D, roundMoney } from '../../../common/money';
import { addTradingDays, calendarDay, isoWithOffset } from '../trading-days';
import { AckLine, BatchContext, CshLine, ExeLine, IOrderConnector, PollContext, SubmitBatchInput, SubmitResult, WdrLine } from './connector.types';
import { buildOrdCsv, buildWdrCsv, MARKET_TZ, sha256 } from './csv';
import { FileConnector } from './file.connector';
import { feesFromJson } from '../fees-json';

/**
 * Tier-0 connector: answers as a perfectly cooperative SDB would. Used on
 * local/staging and in tests; never selected when APP_ENV is pilot/production
 * with a live market (env validation + PolicyService.isSimulated).
 *
 * Behaviour: every ORD line is ACCEPTED with sdb_ref SIM-<n>; every
 * acknowledged order is FILLED at its estimated price, or PARTIAL (50%)
 * when quantity ≥ 100 and SIM_PARTIAL_FILLS=true; courtage/taxes come from
 * the order's feesJson (prorated on a partial fill); settlement_date =
 * executed_at + market.settlementDays trading days.
 */
export class SimulatedConnector implements IOrderConnector {
  readonly kind = 'simulated' as const;
  private readonly file: FileConnector | null;
  private seq = 0;

  constructor(fileDir: string | undefined = process.env.SDB_FILE_DIR) {
    this.file = fileDir ? new FileConnector(fileDir) : null;
  }

  async submit(input: SubmitBatchInput): Promise<SubmitResult> {
    if (this.file) return this.file.submit(input);
    const content = buildOrdCsv(input.lines);
    return { fileName: input.batch.fileName, fileHash: sha256(content), content };
  }

  async submitWithdrawals(input: BatchContext & { lines: WdrLine[] }): Promise<SubmitResult> {
    if (this.file) return this.file.submitWithdrawals(input);
    const content = buildWdrCsv(input.lines);
    return { fileName: input.batch.fileName, fileHash: sha256(content), content };
  }

  async pollAck(ctx: PollContext): Promise<AckLine[]> {
    const now = isoWithOffset(new Date(), MARKET_TZ);
    return ctx.orders
      .filter((o) => o.status === OrderStatus.TRANSMITTED)
      .map((o) => ({ order_id: o.id, status: 'ACCEPTED' as const, sdb_ref: `SIM-${++this.seq}`, ack_at: now }));
  }

  async pollExecutions(ctx: PollContext): Promise<ExeLine[]> {
    const executedAt = new Date();
    const settlement = addTradingDays(calendarDay(executedAt, MARKET_TZ), ctx.market.settlementDays);
    const partial = process.env.SIM_PARTIAL_FILLS === 'true';
    const currency = ctx.market.currency;
    return ctx.orders
      .filter((o) => o.status === OrderStatus.ACKNOWLEDGED || o.status === OrderStatus.PARTIALLY_EXECUTED)
      .map((o) => {
        const remaining = D(o.quantity).minus(o.filledQuantity);
        const isPartial = partial && D(o.quantity).greaterThanOrEqualTo(100) && D(o.filledQuantity).isZero();
        const qty = isPartial ? D(o.quantity).dividedBy(2).toDecimalPlaces(0, Prisma.Decimal.ROUND_DOWN) : remaining;
        const price = D(o.estimatedPrice);
        const gross = roundMoney(qty.times(price), currency);
        const ratio = qty.dividedBy(o.quantity);
        const fees = feesFromJson(o.feesJson);
        const courtage = roundMoney(fees.courtage.times(ratio), currency);
        const taxes = roundMoney(fees.taxes.times(ratio), currency);
        const net = o.side === 'BUY' ? gross.plus(courtage).plus(taxes) : gross.minus(courtage).minus(taxes);
        return {
          order_id: o.id,
          sdb_ref: o.sdbRef ?? `SIM-${o.id.slice(0, 8)}`,
          executed_qty: qty.toFixed(),
          price: price.toFixed(),
          gross_amount: gross.toFixed(),
          courtage: courtage.toFixed(),
          taxes: taxes.toFixed(),
          net_amount: net.toFixed(),
          settlement_date: settlement.toISOString().slice(0, 10),
          executed_at: isoWithOffset(executedAt, MARKET_TZ),
          status: isPartial ? ('PARTIAL' as const) : ('FILLED' as const),
        };
      });
  }

  async fetchStatement(): Promise<CshLine[]> {
    return [];
  }
}
