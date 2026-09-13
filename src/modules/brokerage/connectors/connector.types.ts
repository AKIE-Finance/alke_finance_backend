import { BrokerAccount, Instrument, Market, MarketPartner, Order, OrderBatch, PaymentIntent, User } from '@prisma/client';

/**
 * SDB connector contract (blueprint §4.5). The file connector produces the
 * ORD/WDR files and reads ACK/EXE/CSH from an inbox; the simulated connector
 * answers virtually. sftp/api are v1.1+.
 */

export type BatchUser = Pick<User, 'id' | 'fullName' | 'email' | 'phone'>;

export interface BatchOrderLine {
  order: Order;
  instrument: Instrument;
  user: BatchUser;
  brokerAccount: BrokerAccount & { externalAccountNo: string };
}

export interface BatchContext {
  batch: OrderBatch;
  partner: MarketPartner;
  market: Market;
}

export interface SubmitBatchInput extends BatchContext {
  lines: BatchOrderLine[];
}

export interface SubmitResult {
  fileName: string;
  fileHash: string;
  content: string;
}

export interface PollContext extends BatchContext {
  orders: Order[];
}

export interface AckLine {
  order_id: string;
  status: 'ACCEPTED' | 'REJECTED';
  reject_code?: string;
  reject_text?: string;
  sdb_ref: string;
  ack_at: string;
}

export interface ExeLine {
  order_id: string;
  sdb_ref: string;
  executed_qty: string;
  price: string;
  gross_amount: string;
  courtage: string;
  taxes: string;
  net_amount: string;
  settlement_date: string;
  executed_at: string;
  status: 'FILLED' | 'PARTIAL' | 'UNFILLED';
}

export interface CshLine {
  date: string;
  reference: string;
  direction: 'IN' | 'OUT';
  amount: string;
  balance: string;
}

export interface WdrLine {
  intent: PaymentIntent;
  brokerAccount: BrokerAccount & { externalAccountNo: string };
}

export interface IOrderConnector {
  readonly kind: 'simulated' | 'file';
  submit(input: SubmitBatchInput): Promise<SubmitResult>;
  submitWithdrawals(input: BatchContext & { lines: WdrLine[] }): Promise<SubmitResult>;
  pollAck(batch: PollContext): Promise<AckLine[]>;
  pollExecutions(batch: PollContext): Promise<ExeLine[]>;
  fetchStatement(partnerId: string, date: Date): Promise<CshLine[]>;
}

export const ORDER_CONNECTOR = Symbol('ORDER_CONNECTOR');
