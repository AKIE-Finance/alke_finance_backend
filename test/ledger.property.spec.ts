import { BadRequestException } from '@nestjs/common';
import { LedgerAccountKind, LedgerOwnerType, LedgerTxn, LedgerTxnType, Prisma } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { EventBus } from '../src/common/events/event-bus.service';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { LedgerAccountRef, MIRROR_KINDS, PostTxnInput } from '../src/modules/ledger/ledger.types';
import { D, ZERO } from '../src/common/money';
import { resetDatabase } from './helpers/db';

/** Tiny seeded PRNG (mulberry32) so a failing sequence is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const USERS = ['u-alpha', 'u-beta', 'u-gamma'];
const CURRENCIES = ['XAF', 'EUR'];
const OPS = ['deposit', 'reserve', 'release', 'fill', 'fee', 'withdraw', 'reverse'] as const;
type Op = (typeof OPS)[number];

const SEED = Number(process.env.LEDGER_PROPERTY_SEED ?? 20260904);
const STEPS = Number(process.env.LEDGER_PROPERTY_STEPS ?? 320);

const acct = (ownerType: LedgerOwnerType, ownerId: string, currency: string, kind: LedgerAccountKind): LedgerAccountRef => ({
  ownerType, ownerId, currency, kind,
});
const key = (a: LedgerAccountRef) => `${a.ownerType}|${a.ownerId}|${a.currency}|${a.kind}`;

/** Independent model of the balances, updated only when the ledger accepted the post. */
class Model {
  readonly balances = new Map<string, Prisma.Decimal>();

  apply(input: PostTxnInput): void {
    for (const e of input.entries) {
      const k = key(e.account);
      this.balances.set(k, (this.balances.get(k) ?? ZERO).plus(e.amount));
    }
  }

  wouldGoNegative(input: PostTxnInput): boolean {
    const deltas = new Map<string, Prisma.Decimal>();
    for (const e of input.entries) {
      if (e.account.ownerType !== LedgerOwnerType.USER) continue;
      const k = key(e.account);
      deltas.set(k, (deltas.get(k) ?? ZERO).plus(e.amount));
    }
    for (const [k, delta] of deltas) {
      if ((this.balances.get(k) ?? ZERO).plus(delta).lessThan(0)) return true;
    }
    return false;
  }

  userMirror(currency: string): Prisma.Decimal {
    let total = ZERO;
    for (const [k, v] of this.balances) {
      const [ownerType, , cur, kind] = k.split('|');
      if (ownerType === LedgerOwnerType.USER && cur === currency && (MIRROR_KINDS as readonly string[]).includes(kind)) {
        total = total.plus(v);
      }
    }
    return total;
  }
}

describe('Ledger property test (seeded random operation sequences)', () => {
  const prisma = new PrismaService();
  const ledger = new LedgerService(prisma, new EventBus());

  beforeAll(() => prisma.$connect());
  beforeEach(() => resetDatabase(prisma));
  afterAll(() => prisma.$disconnect());

  async function assertInvariants(model: Model, posted: Map<string, PostTxnInput>, step: number, op: string) {
    const ctx = `step ${step} (${op}, seed ${SEED})`;

    const unbalanced = await prisma.$queryRaw<{ txnId: string }[]>`
      SELECT "txnId" FROM "LedgerEntry" GROUP BY "txnId" HAVING SUM(amount) <> 0`;
    expect({ ctx, unbalanced }).toEqual({ ctx, unbalanced: [] });

    const negatives = await prisma.$queryRaw<{ id: string }[]>`
      SELECT a.id FROM "LedgerAccount" a JOIN "LedgerEntry" e ON e."accountId" = a.id
      WHERE a."ownerType" = 'USER' GROUP BY a.id HAVING SUM(e.amount) < 0`;
    expect({ ctx, negatives }).toEqual({ ctx, negatives: [] });

    for (const currency of CURRENCIES) {
      const perCurrency = await prisma.$queryRaw<{ total: Prisma.Decimal | null }[]>`
        SELECT SUM(e.amount) AS total FROM "LedgerEntry" e JOIN "LedgerTxn" t ON t.id = e."txnId" WHERE t.currency = ${currency}`;
      expect({ ctx, currency, total: D(perCurrency[0].total ?? 0).toString() }).toEqual({ ctx, currency, total: '0' });

      const mirror = await ledger.mirrorTotal(currency);
      expect({ ctx, currency, mirror: mirror.toString() }).toEqual({ ctx, currency, mirror: model.userMirror(currency).toString() });
    }

    // Spot check: the model's view of each touched account equals the ledger's.
    for (const input of posted.values()) {
      for (const e of input.entries) {
        const expected = model.balances.get(key(e.account)) ?? ZERO;
        const actual = await ledger.balance(e.account);
        expect({ ctx, account: key(e.account), balance: actual.toString() }).toEqual({ ctx, account: key(e.account), balance: expected.toString() });
      }
      break; // one txn per step keeps the test fast; the aggregate checks above cover the rest
    }
  }

  it(`keeps every invariant across ${STEPS} random operations`, async () => {
    const rnd = mulberry32(SEED);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
    const amount = (currency: string) => {
      const units = 1 + Math.floor(rnd() * 500);
      return currency === 'XAF' ? D(units) : D(units).dividedBy(4).toDecimalPlaces(2);
    };

    const model = new Model();
    const posted = new Map<string, PostTxnInput>(); // idempotencyKey → input
    const reversible: LedgerTxn[] = [];
    let accepted = 0;
    let refused = 0;
    let reversed = 0;

    for (let step = 0; step < STEPS; step++) {
      const op: Op = pick(OPS);
      const userId = pick(USERS);
      const currency = pick(CURRENCIES);
      const amt = amount(currency);
      const user = (kind: LedgerAccountKind) => acct(LedgerOwnerType.USER, userId, currency, kind);
      const providerClearing = acct(LedgerOwnerType.PROVIDER, 'MTN_MOMO', currency, LedgerAccountKind.CLEARING);
      const sdbClearing = acct(LedgerOwnerType.SDB, 'sdb-1', currency, LedgerAccountKind.CLEARING);
      const feeAccount = acct(LedgerOwnerType.FEE, 'COURTAGE_SDB', currency, LedgerAccountKind.AVAILABLE);
      const idk = `${op}:${step}`;

      if (op === 'reverse') {
        if (reversible.length === 0) continue;
        const idx = Math.floor(rnd() * reversible.length);
        const target = reversible[idx];
        const original = posted.get(target.idempotencyKey) as PostTxnInput;
        const negated: PostTxnInput = {
          ...original,
          type: LedgerTxnType.REVERSAL,
          idempotencyKey: `reversal:${target.id}`,
          entries: original.entries.map((e) => ({ account: e.account, amount: D(e.amount).negated() })),
        };
        try {
          await ledger.reverse(target.id, 'property test', null);
          expect(model.wouldGoNegative(negated)).toBe(false);
          model.apply(negated);
          posted.set(negated.idempotencyKey, negated);
          reversible.splice(idx, 1);
          reversed++;
        } catch (err) {
          expect(err).toBeInstanceOf(BadRequestException);
          expect(model.wouldGoNegative(negated)).toBe(true);
          refused++;
        }
        await assertInvariants(model, posted, step, op);
        continue;
      }

      let input: PostTxnInput;
      switch (op) {
        case 'deposit':
          input = { type: LedgerTxnType.DEPOSIT, idempotencyKey: idk, currency, source: 'TEST', entries: [
            { account: user(LedgerAccountKind.AVAILABLE), amount: amt },
            { account: providerClearing, amount: amt.negated() },
          ] };
          break;
        case 'reserve':
          input = { type: LedgerTxnType.RESERVE, idempotencyKey: idk, currency, source: 'TEST', entries: [
            { account: user(LedgerAccountKind.AVAILABLE), amount: amt.negated() },
            { account: user(LedgerAccountKind.RESERVED), amount: amt },
          ] };
          break;
        case 'release':
          input = { type: LedgerTxnType.RELEASE, idempotencyKey: idk, currency, source: 'TEST', entries: [
            { account: user(LedgerAccountKind.RESERVED), amount: amt.negated() },
            { account: user(LedgerAccountKind.AVAILABLE), amount: amt },
          ] };
          break;
        case 'fill':
          input = { type: LedgerTxnType.FILL, idempotencyKey: idk, currency, source: 'TEST', entries: [
            { account: user(LedgerAccountKind.RESERVED), amount: amt.negated() },
            { account: sdbClearing, amount: amt },
          ] };
          break;
        case 'fee':
          input = { type: LedgerTxnType.FEE, idempotencyKey: idk, currency, source: 'TEST', entries: [
            { account: user(LedgerAccountKind.AVAILABLE), amount: amt.negated() },
            { account: feeAccount, amount: amt },
          ] };
          break;
        case 'withdraw':
        default:
          input = { type: LedgerTxnType.WITHDRAWAL, idempotencyKey: idk, currency, source: 'TEST', entries: [
            { account: user(LedgerAccountKind.AVAILABLE), amount: amt.negated() },
            { account: providerClearing, amount: amt },
          ] };
          break;
      }

      const expectRefusal = model.wouldGoNegative(input);
      try {
        const txn = await ledger.post(input);
        expect({ step, op, expectRefusal }).toEqual({ step, op, expectRefusal: false });
        model.apply(input);
        posted.set(input.idempotencyKey, input);
        reversible.push(txn);
        accepted++;
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        expect({ step, op, expectRefusal, message: (err as Error).message }).toEqual({ step, op, expectRefusal: true, message: 'Solde insuffisant.' });
        refused++;
      }
      await assertInvariants(model, posted, step, op);
    }

    // Sanity: the sequence exercised both paths.
    expect(accepted).toBeGreaterThan(50);
    expect(refused).toBeGreaterThan(5);
    expect(reversed).toBeGreaterThan(0);
    const report = await ledger.verifyInvariants();
    expect(report.ok).toBe(true);
    expect(await prisma.ledgerTxn.count()).toBe(accepted + reversed);
  });

  it('serialises 20 concurrent debits: exactly the affordable number succeed, never negative', async () => {
    const userId = 'u-concurrent';
    const currency = 'XAF';
    const available = acct(LedgerOwnerType.USER, userId, currency, LedgerAccountKind.AVAILABLE);
    const reserved = acct(LedgerOwnerType.USER, userId, currency, LedgerAccountKind.RESERVED);
    const clearing = acct(LedgerOwnerType.PROVIDER, 'MTN_MOMO', currency, LedgerAccountKind.CLEARING);

    await ledger.post({
      type: LedgerTxnType.DEPOSIT, idempotencyKey: 'seed', currency, source: 'TEST',
      entries: [{ account: available, amount: 75 }, { account: clearing, amount: -75 }],
    });

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        ledger.post({
          type: LedgerTxnType.RESERVE, idempotencyKey: `concurrent:${i}`, currency, source: 'TEST',
          entries: [{ account: available, amount: -10 }, { account: reserved, amount: 10 }],
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toBe(7);
    expect(rejected).toHaveLength(13);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(BadRequestException);
      expect((r.reason as Error).message).toBe('Solde insuffisant.');
    }
    expect((await ledger.balance(available)).toString()).toBe('5');
    expect((await ledger.balance(reserved)).toString()).toBe('70');
    expect(await prisma.ledgerTxn.count()).toBe(8);
    expect((await ledger.verifyInvariants()).ok).toBe(true);
  });
});
