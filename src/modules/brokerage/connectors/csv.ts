import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { D, roundMoney } from '../../../common/money';
import { isoWithOffset, yyyymmdd } from '../trading-days';
import { AckLine, BatchOrderLine, CshLine, ExeLine, WdrLine } from './connector.types';

/**
 * File formats exchanged with the SDB (blueprint §4.5): UTF-8, header row,
 * semicolon separator, LF line endings, no quoting (fields never contain ';'
 * — free text is sanitised). Byte-exactness matters: the SHA-256 of the file
 * is carried in the signed manifest.
 */

export const MARKET_TZ = 'Africa/Douala';
export const CSV_SEP = ';';
export const CSV_EOL = '\n';

export const ORD_COLUMNS = [
  'order_id',
  'client_account_no',
  'client_name',
  'side',
  'isin',
  'quantity',
  'order_type',
  'validity',
  'max_amount_xaf',
  'created_at',
  'client_ref',
] as const;

export const WDR_COLUMNS = ['withdrawal_id', 'client_account_no', 'amount', 'channel', 'msisdn', 'requested_at'] as const;
export const ACK_COLUMNS = ['order_id', 'status', 'reject_code', 'reject_text', 'sdb_ref', 'ack_at'] as const;
export const EXE_COLUMNS = [
  'order_id',
  'sdb_ref',
  'executed_qty',
  'price',
  'gross_amount',
  'courtage',
  'taxes',
  'net_amount',
  'settlement_date',
  'executed_at',
  'status',
] as const;
export const CSH_COLUMNS = ['date', 'reference', 'direction', 'amount', 'balance'] as const;

/** Removes separators and line breaks from free text so a row stays one line. */
export function sanitizeField(value: string | null | undefined): string {
  return (value ?? '').replace(/[;\r\n]+/g, ' ').trim();
}

/** Quantities: integers print without decimals, fractional lots keep up to 4 places. */
export function formatQuantity(q: Prisma.Decimal.Value): string {
  const d = D(q);
  return d.isInteger() ? d.toFixed(0) : d.toFixed(4).replace(/0+$/, '');
}

export function formatAmount(a: Prisma.Decimal.Value, currency: string): string {
  return roundMoney(a, currency).toFixed();
}

export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function batchFileName(partnerCode: string, type: 'ORD' | 'WDR' | 'ACK' | 'EXE' | 'CSH', date: Date, sequence: number): string {
  return `ALKE_${partnerCode}_${type}_${yyyymmdd(date, MARKET_TZ)}_${String(sequence).padStart(3, '0')}.csv`;
}

export function toCsv(columns: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [columns.join(CSV_SEP), ...rows.map((r) => r.join(CSV_SEP))];
  return lines.join(CSV_EOL) + CSV_EOL;
}

export function buildOrdCsv(lines: readonly BatchOrderLine[]): string {
  const rows = lines.map(({ order, instrument, user, brokerAccount }) => [
    order.id,
    sanitizeField(brokerAccount.externalAccountNo),
    sanitizeField(user.fullName),
    order.side,
    sanitizeField(instrument.isin ?? instrument.symbol),
    formatQuantity(order.quantity),
    order.orderType,
    sanitizeField(order.validity),
    formatAmount(order.maxAmount, instrument.currency),
    isoWithOffset(order.submittedAt, MARKET_TZ),
    user.id,
  ]);
  return toCsv(ORD_COLUMNS, rows);
}

export function buildWdrCsv(lines: readonly WdrLine[]): string {
  const rows = lines.map(({ intent, brokerAccount }) => [
    intent.id,
    sanitizeField(brokerAccount.externalAccountNo),
    formatAmount(intent.amount, intent.currency),
    intent.provider,
    sanitizeField(intent.msisdn),
    isoWithOffset(intent.createdAt, MARKET_TZ),
  ]);
  return toCsv(WDR_COLUMNS, rows);
}

// ------------------------------------------------------------------ parsing

export class CsvFormatError extends Error {}

/** Parses a semicolon CSV with a header row into records; `required` columns must all be present. */
export function parseCsv(text: string, required: readonly string[]): Record<string, string>[] {
  const lines = text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new CsvFormatError('Fichier vide.');
  const header = lines[0].split(CSV_SEP).map((h) => h.trim());
  const missing = required.filter((c) => !header.includes(c));
  if (missing.length) throw new CsvFormatError(`Colonnes manquantes : ${missing.join(', ')}.`);
  return lines.slice(1).map((line, i) => {
    const cells = line.split(CSV_SEP);
    if (cells.length < header.length) throw new CsvFormatError(`Ligne ${i + 2} : ${cells.length} champs, ${header.length} attendus.`);
    const record: Record<string, string> = {};
    header.forEach((h, idx) => (record[h] = (cells[idx] ?? '').trim()));
    return record;
  });
}

function oneOf<T extends string>(value: string, allowed: readonly T[], field: string, line: number): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new CsvFormatError(`Ligne ${line} : ${field} « ${value} » invalide (attendu ${allowed.join('|')}).`);
  }
  return value as T;
}

function decimalField(value: string, field: string, line: number): string {
  if (!/^-?\d+(\.\d+)?$/.test(value)) throw new CsvFormatError(`Ligne ${line} : ${field} « ${value} » n’est pas un nombre.`);
  return value;
}

export function parseAck(text: string): AckLine[] {
  return parseCsv(text, ['order_id', 'status', 'sdb_ref', 'ack_at']).map((r, i) => ({
    order_id: r.order_id,
    status: oneOf(r.status, ['ACCEPTED', 'REJECTED'] as const, 'status', i + 2),
    reject_code: r.reject_code || undefined,
    reject_text: r.reject_text || undefined,
    sdb_ref: r.sdb_ref,
    ack_at: r.ack_at,
  }));
}

export function parseExe(text: string): ExeLine[] {
  return parseCsv(text, [...EXE_COLUMNS]).map((r, i) => {
    const line = i + 2;
    return {
      order_id: r.order_id,
      sdb_ref: r.sdb_ref,
      executed_qty: decimalField(r.executed_qty, 'executed_qty', line),
      price: decimalField(r.price, 'price', line),
      gross_amount: decimalField(r.gross_amount, 'gross_amount', line),
      courtage: decimalField(r.courtage || '0', 'courtage', line),
      taxes: decimalField(r.taxes || '0', 'taxes', line),
      net_amount: decimalField(r.net_amount, 'net_amount', line),
      settlement_date: r.settlement_date,
      executed_at: r.executed_at,
      status: oneOf(r.status, ['FILLED', 'PARTIAL', 'UNFILLED'] as const, 'status', line),
    };
  });
}

export function parseCsh(text: string): CshLine[] {
  return parseCsv(text, [...CSH_COLUMNS]).map((r, i) => ({
    date: r.date,
    reference: r.reference,
    direction: oneOf(r.direction, ['IN', 'OUT'] as const, 'direction', i + 2),
    amount: decimalField(r.amount, 'amount', i + 2),
    balance: decimalField(r.balance, 'balance', i + 2),
  }));
}

export function ackToCsv(lines: readonly AckLine[]): string {
  return toCsv(
    ACK_COLUMNS,
    lines.map((l) => [l.order_id, l.status, l.reject_code ?? '', sanitizeField(l.reject_text), l.sdb_ref, l.ack_at]),
  );
}

export function exeToCsv(lines: readonly ExeLine[]): string {
  return toCsv(
    EXE_COLUMNS,
    lines.map((l) => [
      l.order_id,
      l.sdb_ref,
      l.executed_qty,
      l.price,
      l.gross_amount,
      l.courtage,
      l.taxes,
      l.net_amount,
      l.settlement_date,
      l.executed_at,
      l.status,
    ]),
  );
}

export function cshToCsv(lines: readonly CshLine[]): string {
  return toCsv(
    CSH_COLUMNS,
    lines.map((l) => [l.date, l.reference, l.direction, l.amount, l.balance]),
  );
}
