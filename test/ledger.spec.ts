import { BadRequestException } from '@nestjs/common';
import { LedgerAccountKind, LedgerOwnerType, LedgerTxnStatus, LedgerTxnType, Prisma } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { EventBus } from '../src/common/events/event-bus.service';
import { DomainEvent } from '../src/common/events/domain-events';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { LedgerAccountRef, PostTxnInput } from '../src/modules/ledger/ledger.types';
import { D } from '../src/common/money';
import { resetDatabase } from './helpers/db';

const USER = 'user-1';
const XAF = 'XAF';

const user = (kind: LedgerAccountKind, currency = XAF, id = USER): LedgerAccountRef => ({
  ownerType: LedgerOwnerType.USER, ownerId: id, currency, kind,
});
const provider = (currency = XAF): LedgerAccountRef => ({
  ownerType: LedgerOwnerType.PROVIDER, ownerId: 'MTN_MOMO', currency, kind: LedgerAccountKind.CLEARING,
});

function deposit(key: string, amount: Prisma.Decimal.Value, currency = XAF, userId = USER): PostTxnInput {
  return {
    type: LedgerTxnType.DEPOSIT,
    idempotencyKey: key,
    currency,
    source: 'PAYMENT_WEBHOOK',
    entries: [
      { account: user(LedgerAccountKind.AVAILABLE, currency, userId), amount },
      { account: provider(currency), amount: D(amount).negated() },
    ],
  };
}

describe('LedgerService', () => {
  const prisma = new PrismaService();
  const events = new EventBus();
  const published: DomainEvent[] = [];
  const ledger = new LedgerService(prisma, events);

  beforeAll(async () => {
    await prisma.$connect();
    events.subscribe('*', (e) => {
      published.push(e);
    });
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    published.length = 0;
  });
  afterAll(async () => prisma.$disconnect());

  it('posts credits and debits, creating accounts on the fly', async () => {
    const txn = await ledger.post(deposit('deposit:1', 1000));
    expect(txn.type).toBe(LedgerTxnType.DEPOSIT);
    expect(txn.status).toBe(LedgerTxnStatus.POSTED);

    expect((await ledger.balance(user(LedgerAccountKind.AVAILABLE))).toString()).toBe('1000');
    expect((await ledger.balance(provider())).toString()).toBe('-1000');
    expect((await ledger.balance(user(LedgerAccountKind.RESERVED))).toString()).toBe('0');

    const entries = await prisma.ledgerEntry.findMany({ where: { txnId: txn.id } });
    expect(entries).toHaveLength(2);
    expect(published.map((e) => e.name)).toEqual(['LedgerTxnPosted']);
    expect(published[0].entityType).toBe('LedgerTxn');
    expect(published[0].entityId).toBe(txn.id);
  });

  it('rejects entries that do not sum to zero', async () => {
    await expect(
      ledger.post({
        type: LedgerTxnType.DEPOSIT,
        idempotencyKey: 'bad:1',
        currency: XAF,
        source: 'TEST',
        entries: [
          { account: user(LedgerAccountKind.AVAILABLE), amount: 100 },
          { account: provider(), amount: -99 },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await prisma.ledgerTxn.count()).toBe(0);
    expect(await prisma.ledgerAccount.count()).toBe(0);
  });

  it('refuses non-integer amounts in zero-decimal currencies and >2 decimals elsewhere', async () => {
    await expect(ledger.post(deposit('frac:1', '10.5'))).rejects.toThrow(/entiers/);
    await expect(ledger.post(deposit('frac:2', '10.505', 'EUR'))).rejects.toThrow(/décimales/);
    await expect(ledger.post(deposit('frac:3', '10.50', 'EUR'))).resolves.toBeDefined();
  });

  it('enforces the non-negative rule on USER accounts', async () => {
    await ledger.post(deposit('deposit:1', 500));
    await expect(
      ledger.post({
        type: LedgerTxnType.RESERVE,
        idempotencyKey: 'reserve:1',
        currency: XAF,
        source: 'ORDER',
        entries: [
          { account: user(LedgerAccountKind.AVAILABLE), amount: -600 },
          { account: user(LedgerAccountKind.RESERVED), amount: 600 },
        ],
      }),
    ).rejects.toThrow('Solde insuffisant.');
    expect((await ledger.balance(user(LedgerAccountKind.AVAILABLE))).toString()).toBe('500');
    expect(await prisma.ledgerTxn.count()).toBe(1);

    // Non-user accounts may go negative (provider clearing already is).
    await expect(ledger.post(deposit('deposit:2', 100))).resolves.toBeDefined();
  });

  it('is idempotent: re-posting the same key returns the first txn and writes nothing', async () => {
    const first = await ledger.post(deposit('deposit:same', 250));
    const second = await ledger.post(deposit('deposit:same', 250));
    expect(second.id).toBe(first.id);
    expect(await prisma.ledgerTxn.count()).toBe(1);
    expect(await prisma.ledgerEntry.count()).toBe(2);
    expect((await ledger.balance(user(LedgerAccountKind.AVAILABLE))).toString()).toBe('250');
    expect(published.filter((e) => e.name === 'LedgerTxnPosted')).toHaveLength(1);
  });

  it('reverses a txn once, marks it REVERSED and refuses a second reversal', async () => {
    const original = await ledger.post(deposit('deposit:r', 300));
    const reversal = await ledger.reverse(original.id, 'erreur de saisie', 'admin-1');

    expect(reversal.type).toBe(LedgerTxnType.REVERSAL);
    expect(reversal.reversalOfId).toBe(original.id);
    expect(reversal.idempotencyKey).toBe(`reversal:${original.id}`);
    const reloaded = await prisma.ledgerTxn.findUniqueOrThrow({ where: { id: original.id } });
    expect(reloaded.status).toBe(LedgerTxnStatus.REVERSED);
    expect((await ledger.balance(user(LedgerAccountKind.AVAILABLE))).toString()).toBe('0');
    expect((await ledger.balance(provider())).toString()).toBe('0');
    expect(published.map((e) => e.name)).toEqual(['LedgerTxnPosted', 'LedgerTxnPosted', 'LedgerReversalPosted']);

    await expect(ledger.reverse(original.id, 'again', 'admin-1')).rejects.toThrow(/déjà été annulée/);
    await expect(ledger.reverse(reversal.id, 'reverse the reversal', 'admin-1')).rejects.toThrow(/annulation/);
    expect(await prisma.ledgerTxn.count()).toBe(2);
  });

  it('refuses a reversal that would make a user account negative', async () => {
    const dep = await ledger.post(deposit('deposit:spent', 100));
    await ledger.post({
      type: LedgerTxnType.WITHDRAWAL,
      idempotencyKey: 'withdraw:1',
      currency: XAF,
      source: 'TEST',
      entries: [
        { account: user(LedgerAccountKind.AVAILABLE), amount: -100 },
        { account: provider(), amount: 100 },
      ],
    });
    await expect(ledger.reverse(dep.id, 'late', null)).rejects.toThrow('Solde insuffisant.');
    expect((await prisma.ledgerTxn.findUniqueOrThrow({ where: { id: dep.id } })).status).toBe(LedgerTxnStatus.POSTED);
  });

  it('reports userBalances per kind, userCurrencies and userStatement', async () => {
    await ledger.post(deposit('deposit:a', 1000));
    await ledger.post(deposit('deposit:eur', '20.50', 'EUR'));
    await ledger.post({
      type: LedgerTxnType.RESERVE,
      idempotencyKey: 'reserve:a',
      currency: XAF,
      source: 'ORDER',
      description: 'Réservation ordre',
      entries: [
        { account: user(LedgerAccountKind.AVAILABLE), amount: -400 },
        { account: user(LedgerAccountKind.RESERVED), amount: 400 },
      ],
    });
    await ledger.post({
      type: LedgerTxnType.RESERVE,
      idempotencyKey: 'withdraw-reserve:a',
      currency: XAF,
      source: 'USER',
      entries: [
        { account: user(LedgerAccountKind.AVAILABLE), amount: -100 },
        { account: user(LedgerAccountKind.WITHDRAWABLE), amount: 100 },
      ],
    });

    const b = await ledger.userBalances(USER, XAF);
    expect(b.available.toString()).toBe('500');
    expect(b.reserved.toString()).toBe('400');
    expect(b.settling.toString()).toBe('0');
    expect(b.withdrawable.toString()).toBe('100');
    expect((await ledger.userBalances(USER, 'EUR')).available.toString()).toBe('20.5');
    expect((await ledger.userBalances('nobody', XAF)).available.toString()).toBe('0');

    expect(await ledger.userCurrencies(USER)).toEqual(['EUR', 'XAF']);

    const statement = await ledger.userStatement(USER, XAF);
    expect(statement).toHaveLength(5); // deposit (1) + 2 reserves × 2 user entries
    expect(statement[0].type).toBe(LedgerTxnType.RESERVE);
    expect(statement.every((l) => l.currency === XAF)).toBe(true);
    expect(await ledger.userStatement(USER, XAF, 2)).toHaveLength(2);
  });

  it('computes the mirror total (AVAILABLE + RESERVED + SETTLING of all users)', async () => {
    await ledger.post(deposit('d1', 1000, XAF, 'u1'));
    await ledger.post(deposit('d2', 2000, XAF, 'u2'));
    await ledger.post({
      type: LedgerTxnType.RESERVE,
      idempotencyKey: 'wr',
      currency: XAF,
      source: 'USER',
      entries: [
        { account: user(LedgerAccountKind.AVAILABLE, XAF, 'u2'), amount: -500 },
        { account: user(LedgerAccountKind.WITHDRAWABLE, XAF, 'u2'), amount: 500 },
      ],
    });
    await ledger.post({
      type: LedgerTxnType.RESERVE,
      idempotencyKey: 'or',
      currency: XAF,
      source: 'ORDER',
      entries: [
        { account: user(LedgerAccountKind.AVAILABLE, XAF, 'u1'), amount: -300 },
        { account: user(LedgerAccountKind.RESERVED, XAF, 'u1'), amount: 300 },
      ],
    });
    expect((await ledger.mirrorTotal(XAF)).toString()).toBe('2500');
    expect((await ledger.mirrorTotal('EUR')).toString()).toBe('0');
  });

  it('verifyInvariants is ok on a consistent ledger and flags a corrupted one', async () => {
    await ledger.post(deposit('d1', 1000));
    await ledger.post(deposit('d2', '12.34', 'EUR'));
    const ok = await ledger.verifyInvariants();
    expect(ok).toMatchObject({ ok: true, unbalancedTxnIds: [], unbalancedCurrencies: [], negativeUserAccountIds: [] });

    // Corrupt on purpose, bypassing the service.
    const txn = await prisma.ledgerTxn.findUniqueOrThrow({ where: { idempotencyKey: 'd1' } });
    const account = await prisma.ledgerAccount.findFirstOrThrow({ where: { ownerType: LedgerOwnerType.USER } });
    await prisma.ledgerEntry.create({ data: { txnId: txn.id, accountId: account.id, amount: -5000 } });
    const bad = await ledger.verifyInvariants();
    expect(bad.ok).toBe(false);
    expect(bad.unbalancedTxnIds).toEqual([txn.id]);
    expect(bad.unbalancedCurrencies).toEqual([XAF]);
    expect(bad.negativeUserAccountIds).toEqual([account.id]);
  });

  it('runs inside a caller-provided transaction and rolls back with it', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await ledger.post(deposit('in-tx', 700), tx);
        expect((await ledger.balance(user(LedgerAccountKind.AVAILABLE), tx)).toString()).toBe('700');
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(await prisma.ledgerTxn.count()).toBe(0);
    expect((await ledger.balance(user(LedgerAccountKind.AVAILABLE))).toString()).toBe('0');
  });
});
