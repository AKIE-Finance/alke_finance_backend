import { createHash } from 'crypto';
import { BrokerAccount, Instrument, Order, OrderSide, OrderStatus, OrderType, Prisma } from '@prisma/client';
import {
  ackToCsv,
  batchFileName,
  buildOrdCsv,
  cshToCsv,
  CsvFormatError,
  exeToCsv,
  parseAck,
  parseCsh,
  parseExe,
  sha256,
} from '../src/modules/brokerage/connectors/csv';
import { BatchOrderLine } from '../src/modules/brokerage/connectors/connector.types';
import { SimulatedConnector } from '../src/modules/brokerage/connectors/simulated.connector';
import { FileConnector } from '../src/modules/brokerage/connectors/file.connector';
import { isoWithOffset } from '../src/modules/brokerage/trading-days';
import { D } from '../src/common/money';

const ORDER_ID = '4f1c2c3e-9d5a-4b7e-8f21-0a1b2c3d4e5f';
const USER_ID = 'a1b2c3d4-0000-4000-8000-000000000001';

function line(overrides: Partial<{ fullName: string; isin: string | null; quantity: string; submittedAt: string }> = {}): BatchOrderLine {
  const order = {
    id: ORDER_ID,
    userId: USER_ID,
    side: OrderSide.BUY,
    orderType: OrderType.MARKET,
    status: OrderStatus.PENDING,
    quantity: new Prisma.Decimal(overrides.quantity ?? '10'),
    maxAmount: new Prisma.Decimal('50750'),
    validity: 'DAY',
    submittedAt: new Date(overrides.submittedAt ?? '2026-09-04T09:15:00.000Z'),
  } as unknown as Order;
  const instrument = { isin: overrides.isin === undefined ? 'CM0000000001' : overrides.isin, symbol: 'SEMC', currency: 'XAF' } as unknown as Instrument;
  const brokerAccount = { externalAccountNo: 'ACC-0001' } as unknown as BrokerAccount & { externalAccountNo: string };
  return { order, instrument, user: { id: USER_ID, fullName: overrides.fullName ?? 'Aline Mbappe', email: 'a@x.test', phone: '+237600000000' }, brokerAccount };
}

describe('SDB file formats (blueprint §4.5)', () => {
  it('ORD file is byte-exact: header, semicolons, LF, +01:00 timestamps, SHA-256 of the exact bytes', () => {
    const content = buildOrdCsv([line()]);
    const expected =
      'order_id;client_account_no;client_name;side;isin;quantity;order_type;validity;max_amount_xaf;created_at;client_ref\n' +
      `${ORDER_ID};ACC-0001;Aline Mbappe;BUY;CM0000000001;10;MARKET;DAY;50750;2026-09-04T10:15:00+01:00;${USER_ID}\n`;
    expect(content).toBe(expected);
    expect(Buffer.from(content, 'utf8')).toEqual(Buffer.from(expected, 'utf8'));
    expect(content.includes('\r')).toBe(false);
    expect(sha256(content)).toBe(createHash('sha256').update(expected, 'utf8').digest('hex'));
    expect(sha256(content)).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256(content)).not.toBe(sha256(content.replace('50750', '50751')));

    // Free text never breaks the line; fractional lots and missing ISIN fall back deterministically.
    const dirty = buildOrdCsv([line({ fullName: 'Nom;avec\nsaut', isin: null, quantity: '12.5000' })]).split('\n')[1];
    expect(dirty).toBe(`${ORDER_ID};ACC-0001;Nom avec saut;BUY;SEMC;12.5;MARKET;DAY;50750;2026-09-04T10:15:00+01:00;${USER_ID}`);
    expect(isoWithOffset(new Date('2026-12-31T23:30:00Z'), 'Africa/Douala')).toBe('2027-01-01T00:30:00+01:00');
  });

  it('file names follow ALKE_<CODE>_<TYPE>_<YYYYMMDD>_<SEQ3>.csv in the market timezone', () => {
    const at = new Date('2026-09-04T23:30:00.000Z'); // already the 5th in Douala
    expect(batchFileName('SDB1', 'ORD', at, 1)).toBe('ALKE_SDB1_ORD_20260905_001.csv');
    expect(batchFileName('SDB1', 'WDR', at, 12)).toBe('ALKE_SDB1_WDR_20260905_012.csv');
    expect(FileConnector.ordFileName({ code: 'sgc', id: 'x' }, at, 3)).toBe('ALKE_SGC_ORD_20260905_003.csv');
    expect(FileConnector.ordFileName({ code: null, id: 'abcdef12-3456' }, at, 1)).toBe('ALKE_ABCDEF12_ORD_20260905_001.csv');
    expect(FileConnector.ordFileName({ code: 'SDB1', id: 'x' }, at, 1).replace('_ORD_', '_ACK_')).toBe('ALKE_SDB1_ACK_20260905_001.csv');
  });

  it('ACK / EXE / CSH parsers round-trip their writers and reject malformed files', () => {
    const ack =
      'order_id;status;reject_code;reject_text;sdb_ref;ack_at\n' +
      `${ORDER_ID};ACCEPTED;;;SDB-77;2026-09-04T10:20:00+01:00\n` +
      `${USER_ID};REJECTED;E12;Compte inconnu;;2026-09-04T10:20:01+01:00\n`;
    const ackLines = parseAck(ack);
    expect(ackLines).toHaveLength(2);
    expect(ackLines[0]).toEqual({ order_id: ORDER_ID, status: 'ACCEPTED', reject_code: undefined, reject_text: undefined, sdb_ref: 'SDB-77', ack_at: '2026-09-04T10:20:00+01:00' });
    expect(ackLines[1].reject_code).toBe('E12');
    expect(ackToCsv(ackLines)).toBe(ack);

    const exe =
      'order_id;sdb_ref;executed_qty;price;gross_amount;courtage;taxes;net_amount;settlement_date;executed_at;status\n' +
      `${ORDER_ID};SDB-77;10;5000;50000;500;250;50750;2026-09-09;2026-09-04T11:00:00+01:00;FILLED\n` +
      `${USER_ID};SDB-78;5;5000;25000;0;0;25000;2026-09-09;2026-09-04T11:00:00+01:00;PARTIAL\n`;
    const exeLines = parseExe(exe);
    expect(exeLines[0].net_amount).toBe('50750');
    expect(exeLines[1].status).toBe('PARTIAL');
    expect(exeToCsv(exeLines)).toBe(exe);
    // CRLF and a BOM are tolerated on input.
    expect(parseExe('﻿' + exe.replace(/\n/g, '\r\n'))).toEqual(exeLines);

    const csh = 'date;reference;direction;amount;balance\n2026-09-04;DEP-1;IN;25000;125000\n2026-09-04;WDR-9;OUT;-10000;115000\n';
    const cshLines = parseCsh(csh);
    expect(cshLines).toEqual([
      { date: '2026-09-04', reference: 'DEP-1', direction: 'IN', amount: '25000', balance: '125000' },
      { date: '2026-09-04', reference: 'WDR-9', direction: 'OUT', amount: '-10000', balance: '115000' },
    ]);
    expect(cshToCsv(cshLines)).toBe(csh);

    expect(() => parseAck('order_id;status\nx;ACCEPTED\n')).toThrow(CsvFormatError);
    expect(() => parseAck('order_id;status;reject_code;reject_text;sdb_ref;ack_at\nx;MAYBE;;;r;t\n')).toThrow(/status « MAYBE » invalide/);
    expect(() => parseCsh('date;reference;direction;amount;balance\n2026-09-04;R;IN;abc;1\n')).toThrow(/n’est pas un nombre/);
    expect(() => parseCsh('')).toThrow('Fichier vide.');
    expect(() => parseCsh('date;reference;direction;amount;balance\n2026-09-04;R;IN\n')).toThrow(/Ligne 2/);
  });

  it('the simulated connector answers ACCEPTED then FILLED (or PARTIAL ≥ 100 with SIM_PARTIAL_FILLS) without touching disk', async () => {
    const previous = process.env.SIM_PARTIAL_FILLS;
    try {
      const connector = new SimulatedConnector(undefined);
      const market = { currency: 'XAF', settlementDays: 3 } as never;
      const ctxBase = { batch: {} as never, partner: {} as never, market };
      const transmitted = { ...line().order, status: OrderStatus.TRANSMITTED, filledQuantity: D(0), estimatedPrice: D(5000), feesJson: [{ code: 'COURTAGE_SDB', amount: '500', label: 'c' }, { code: 'TAXE', amount: '250', label: 't' }] } as unknown as Order;
      const acks = await connector.pollAck({ ...ctxBase, orders: [transmitted] });
      expect(acks).toHaveLength(1);
      expect(acks[0].status).toBe('ACCEPTED');
      expect(acks[0].sdb_ref).toBe('SIM-1');
      expect(acks[0].ack_at).toMatch(/\+01:00$/);

      process.env.SIM_PARTIAL_FILLS = 'false';
      const acked = { ...transmitted, status: OrderStatus.ACKNOWLEDGED, sdbRef: 'SIM-1' } as unknown as Order;
      const [fill] = await connector.pollExecutions({ ...ctxBase, orders: [acked] });
      expect(fill).toMatchObject({ order_id: ORDER_ID, sdb_ref: 'SIM-1', executed_qty: '10', price: '5000', gross_amount: '50000', courtage: '500', taxes: '250', net_amount: '50750', status: 'FILLED' });
      expect(fill.settlement_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      process.env.SIM_PARTIAL_FILLS = 'true';
      const big = { ...acked, quantity: D(100), maxAmount: D(507500), feesJson: [{ code: 'COURTAGE_SDB', amount: '5000', label: 'c' }, { code: 'TAXE', amount: '2500', label: 't' }] } as unknown as Order;
      const [partial] = await connector.pollExecutions({ ...ctxBase, orders: [big] });
      expect(partial).toMatchObject({ executed_qty: '50', gross_amount: '250000', courtage: '2500', taxes: '1250', net_amount: '253750', status: 'PARTIAL' });
      // Small orders are never split.
      const [small] = await connector.pollExecutions({ ...ctxBase, orders: [acked] });
      expect(small.status).toBe('FILLED');
      expect(await connector.fetchStatement()).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.SIM_PARTIAL_FILLS;
      else process.env.SIM_PARTIAL_FILLS = previous;
    }
  });
});
