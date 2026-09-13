import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  LedgerAccount,
  LedgerAccountKind,
  LedgerOwnerType,
  LedgerTxn,
  LedgerTxnStatus,
  LedgerTxnType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EventBus } from '../../common/events/event-bus.service';
import { D, ZERO, roundMoney, decimalsFor } from '../../common/money';
import {
  BalanceSnapshot,
  LedgerAccountRef,
  LedgerPort,
  PostTxnInput,
  UserStatementLine,
  MIRROR_KINDS,
  InvariantReport,
  AccountBalance,
} from './ledger.types';

type Db = Prisma.TransactionClient;

interface NormalisedEntry {
  ref: LedgerAccountRef;
  key: string;
  amount: Prisma.Decimal;
}

interface PostResult {
  txn: LedgerTxn;
  created: boolean;
}

const REVERSAL_PREFIX = 'reversal:';
const TXN_OPTIONS = { maxWait: 15_000, timeout: 30_000 } as const;

function accountKey(ref: LedgerAccountRef): string {
  return `${ref.ownerType}|${ref.ownerId}|${ref.currency}|${ref.kind}`;
}

function isUniqueViolation(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * Grand livre en partie double (blueprint §4.4). Seule voie par laquelle de
 * l'argent bouge : chaque écriture est signée, chaque transaction somme à
 * zéro, rien n'est jamais modifié ni supprimé — on corrige par REVERSAL.
 *
 * Concurrence : les comptes touchés sont verrouillés (`SELECT … FOR UPDATE`,
 * toujours dans l'ordre des ids) avant toute lecture de solde, donc deux
 * débits simultanés ne peuvent pas faire passer un compte USER sous zéro.
 */
@Injectable()
export class LedgerService implements LedgerPort {
  private readonly logger = new Logger(LedgerService.name);

  constructor(private readonly prisma: PrismaService, private readonly events: EventBus) {}

  // ------------------------------------------------------------------ post

  async post(input: PostTxnInput, tx?: Db): Promise<LedgerTxn> {
    const entries = this.normalise(input);

    if (tx) {
      // Caller-owned transaction: we cannot recover from a unique violation
      // (Postgres aborts the whole transaction), so we let it surface. The
      // event is published now; the caller is responsible for committing.
      const result = await this.postIn(input, entries, tx);
      if (result.created) await this.publishPosted(result.txn);
      return result.txn;
    }

    for (let attempt = 0; ; attempt++) {
      try {
        const result = await this.prisma.$transaction((db) => this.postIn(input, entries, db), TXN_OPTIONS);
        if (result.created) await this.publishPosted(result.txn);
        return result.txn;
      } catch (err) {
        if (!isUniqueViolation(err) || attempt >= 2) throw err;
        // Race on idempotencyKey (or on account creation): re-read, retry once.
        const existing = await this.prisma.ledgerTxn.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
        if (existing) return existing;
      }
    }
  }

  /** Runs inside `db`. Returns `created=false` when the idempotency key already exists. */
  private async postIn(
    input: PostTxnInput,
    entries: NormalisedEntry[],
    db: Db,
    extra: { reversalOfId?: string } = {},
  ): Promise<PostResult> {
    const existing = await db.ledgerTxn.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) return { txn: existing, created: false };

    // Resolve (create when missing) every account touched, then lock them all
    // in a deterministic order before reading any balance.
    const accounts = new Map<string, LedgerAccount>();
    for (const e of entries) {
      if (!accounts.has(e.key)) accounts.set(e.key, await this.ensureAccount(e.ref, db));
    }
    const ids = [...accounts.values()].map((a) => a.id).sort();
    await db.$queryRaw`SELECT id FROM "LedgerAccount" WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`;

    // Someone may have posted the same key while we waited for the locks.
    const raced = await db.ledgerTxn.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (raced) return { txn: raced, created: false };

    // Net movement per account, then the non-negative rule.
    const deltas = new Map<string, Prisma.Decimal>();
    for (const e of entries) deltas.set(e.key, (deltas.get(e.key) ?? ZERO).plus(e.amount));

    const guarded = input.enforceNonNegative
      ? input.enforceNonNegative.map(accountKey)
      : entries.filter((e) => e.ref.ownerType === LedgerOwnerType.USER).map((e) => e.key);
    for (const key of new Set(guarded)) {
      const account = accounts.get(key);
      const delta = deltas.get(key);
      if (!account || !delta || delta.greaterThanOrEqualTo(0)) continue;
      const current = await this.sumAccount(account.id, db);
      if (current.plus(delta).lessThan(0)) {
        throw new BadRequestException('Solde insuffisant.');
      }
    }

    const txn = await db.ledgerTxn.create({
      data: {
        type: input.type,
        idempotencyKey: input.idempotencyKey,
        externalReference: input.externalReference,
        source: input.source,
        actorId: input.actorId ?? null,
        createdById: input.actorId ?? null,
        refType: input.refType,
        refId: input.refId,
        currency: input.currency,
        description: input.description,
        metadata: input.metadata,
        reversalOfId: extra.reversalOfId,
        entries: {
          create: entries.map((e) => ({
            accountId: (accounts.get(e.key) as LedgerAccount).id,
            amount: e.amount,
          })),
        },
      },
    });
    return { txn, created: true };
  }

  /** Validates shape, rounding and zero-sum; returns entries with Decimal amounts. */
  private normalise(input: PostTxnInput): NormalisedEntry[] {
    if (!input.idempotencyKey) throw new BadRequestException('Clé d’idempotence requise.');
    if (!input.entries || input.entries.length < 2) {
      throw new BadRequestException('Une transaction comporte au moins deux écritures.');
    }
    const currency = input.currency?.toUpperCase();
    if (!currency) throw new BadRequestException('Devise requise.');
    if (currency !== input.currency) {
      throw new BadRequestException('La devise doit être en majuscules (code ISO 4217).');
    }

    const normalised: NormalisedEntry[] = input.entries.map((e) => {
      const amount = D(e.amount);
      if (!amount.isFinite()) throw new BadRequestException('Montant invalide.');
      if (!roundMoney(amount, currency).equals(amount)) {
        throw new BadRequestException(
          decimalsFor(currency) === 0
            ? `Les montants en ${currency} doivent être des entiers.`
            : `Les montants en ${currency} ont au plus ${decimalsFor(currency)} décimales.`,
        );
      }
      if (e.account.currency !== currency) {
        throw new BadRequestException('Toutes les écritures doivent être dans la devise de la transaction.');
      }
      return { ref: e.account, key: accountKey(e.account), amount };
    });

    const total = normalised.reduce((acc, e) => acc.plus(e.amount), ZERO);
    if (!total.isZero()) {
      throw new BadRequestException('Les écritures d’une transaction doivent sommer à zéro.');
    }
    return normalised;
  }

  private async ensureAccount(ref: LedgerAccountRef, db: Db): Promise<LedgerAccount> {
    const where = {
      ownerType_ownerId_currency_kind: {
        ownerType: ref.ownerType,
        ownerId: ref.ownerId,
        currency: ref.currency,
        kind: ref.kind,
      },
    };
    const found = await db.ledgerAccount.findUnique({ where });
    if (found) return found;
    return db.ledgerAccount.create({
      data: { ownerType: ref.ownerType, ownerId: ref.ownerId, currency: ref.currency, kind: ref.kind },
    });
  }

  private async sumAccount(accountId: string, db: Db): Promise<Prisma.Decimal> {
    const agg = await db.ledgerEntry.aggregate({ where: { accountId }, _sum: { amount: true } });
    return agg._sum.amount ?? ZERO;
  }

  private async publishPosted(txn: LedgerTxn): Promise<void> {
    await this.events.publish('LedgerTxnPosted', {
      entityType: 'LedgerTxn',
      entityId: txn.id,
      actor: txn.actorId ?? 'SYSTEM',
      payload: {
        type: txn.type,
        currency: txn.currency,
        idempotencyKey: txn.idempotencyKey,
        source: txn.source,
        refType: txn.refType,
        refId: txn.refId,
        reversalOfId: txn.reversalOfId,
      },
    });
    if (txn.type === LedgerTxnType.REVERSAL) {
      await this.events.publish('LedgerReversalPosted', {
        entityType: 'LedgerTxn',
        entityId: txn.id,
        actor: txn.actorId ?? 'SYSTEM',
        payload: { reversalOfId: txn.reversalOfId, currency: txn.currency, source: txn.source },
      });
    }
  }

  // --------------------------------------------------------------- reverse

  async reverse(txnId: string, reason: string, actorId: string | null, tx?: Db): Promise<LedgerTxn> {
    const run = async (db: Db): Promise<PostResult> => {
      const original = await db.ledgerTxn.findUnique({
        where: { id: txnId },
        include: { entries: { include: { account: true } } },
      });
      if (!original) throw new NotFoundException('Transaction introuvable.');
      if (original.type === LedgerTxnType.REVERSAL) {
        throw new BadRequestException('Une annulation ne peut pas être annulée.');
      }
      if (original.status === LedgerTxnStatus.REVERSED) {
        throw new BadRequestException('Cette transaction a déjà été annulée.');
      }

      const input: PostTxnInput = {
        type: LedgerTxnType.REVERSAL,
        idempotencyKey: `${REVERSAL_PREFIX}${txnId}`,
        currency: original.currency,
        source: 'ADMIN',
        actorId,
        refType: original.refType ?? undefined,
        refId: original.refId ?? undefined,
        externalReference: original.externalReference ?? undefined,
        description: `Annulation : ${reason}`,
        metadata: { reason, originalType: original.type },
        entries: original.entries.map((e) => ({
          account: {
            ownerType: e.account.ownerType,
            ownerId: e.account.ownerId,
            currency: e.account.currency,
            kind: e.account.kind,
          },
          amount: e.amount.negated(),
        })),
      };
      const result = await this.postIn(input, this.normalise(input), db, { reversalOfId: txnId });
      if (result.created) {
        await db.ledgerTxn.update({ where: { id: txnId }, data: { status: LedgerTxnStatus.REVERSED } });
      }
      return result;
    };

    let result: PostResult;
    if (tx) {
      result = await run(tx);
    } else {
      try {
        result = await this.prisma.$transaction(run, TXN_OPTIONS);
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const existing = await this.prisma.ledgerTxn.findUnique({ where: { idempotencyKey: `${REVERSAL_PREFIX}${txnId}` } });
        if (!existing) throw err;
        return existing;
      }
    }
    if (result.created) await this.publishPosted(result.txn);
    return result.txn;
  }

  // -------------------------------------------------------------- balances

  async balance(account: LedgerAccountRef, tx?: Db): Promise<Prisma.Decimal> {
    const db = tx ?? this.prisma;
    const row = await db.ledgerAccount.findUnique({
      where: {
        ownerType_ownerId_currency_kind: {
          ownerType: account.ownerType,
          ownerId: account.ownerId,
          currency: account.currency,
          kind: account.kind,
        },
      },
      select: { id: true },
    });
    if (!row) return ZERO;
    return this.sumAccount(row.id, db);
  }

  async userBalances(userId: string, currency: string, tx?: Db): Promise<BalanceSnapshot> {
    const balances = await this.ownerBalances(LedgerOwnerType.USER, userId, currency, tx);
    const byKind = new Map(balances.map((b) => [b.kind, b.balance]));
    return {
      currency,
      available: byKind.get(LedgerAccountKind.AVAILABLE) ?? ZERO,
      reserved: byKind.get(LedgerAccountKind.RESERVED) ?? ZERO,
      settling: byKind.get(LedgerAccountKind.SETTLING) ?? ZERO,
      withdrawable: byKind.get(LedgerAccountKind.WITHDRAWABLE) ?? ZERO,
    };
  }

  /** Balance of every account of an owner (optionally in one currency). */
  async ownerBalances(
    ownerType: LedgerOwnerType,
    ownerId: string,
    currency?: string,
    tx?: Db,
  ): Promise<AccountBalance[]> {
    const db = tx ?? this.prisma;
    const accounts = await db.ledgerAccount.findMany({
      where: { ownerType, ownerId, ...(currency ? { currency } : {}) },
      orderBy: [{ currency: 'asc' }, { kind: 'asc' }],
    });
    if (accounts.length === 0) return [];
    const sums = await db.ledgerEntry.groupBy({
      by: ['accountId'],
      where: { accountId: { in: accounts.map((a) => a.id) } },
      _sum: { amount: true },
    });
    const byId = new Map(sums.map((s) => [s.accountId, s._sum.amount ?? ZERO]));
    return accounts.map((a) => ({
      accountId: a.id,
      ownerType: a.ownerType,
      ownerId: a.ownerId,
      currency: a.currency,
      kind: a.kind,
      balance: byId.get(a.id) ?? ZERO,
    }));
  }

  async userCurrencies(userId: string): Promise<string[]> {
    const rows = await this.prisma.ledgerAccount.findMany({
      where: { ownerType: LedgerOwnerType.USER, ownerId: userId },
      distinct: ['currency'],
      select: { currency: true },
      orderBy: { currency: 'asc' },
    });
    return rows.map((r) => r.currency);
  }

  async userStatement(userId: string, currency: string, limit = 50): Promise<UserStatementLine[]> {
    const take = Math.min(Math.max(limit, 1), 500);
    const entries = await this.prisma.ledgerEntry.findMany({
      where: { account: { ownerType: LedgerOwnerType.USER, ownerId: userId, currency } },
      include: { txn: true, account: { select: { kind: true } } },
      orderBy: [{ txn: { postedAt: 'desc' } }, { createdAt: 'desc' }],
      take,
    });
    return entries.map((e) => ({
      txnId: e.txnId,
      type: e.txn.type,
      kind: e.account.kind,
      amount: e.amount,
      currency: e.txn.currency,
      description: e.txn.description,
      refType: e.txn.refType,
      refId: e.txn.refId,
      postedAt: e.txn.postedAt,
    }));
  }

  // ------------------------------------------------------------ invariants

  async verifyInvariants(): Promise<InvariantReport> {
    const unbalancedTxns = await this.prisma.$queryRaw<{ txnId: string }[]>`
      SELECT "txnId" FROM "LedgerEntry" GROUP BY "txnId" HAVING SUM(amount) <> 0`;
    const unbalancedCurrencies = await this.prisma.$queryRaw<{ currency: string; total: Prisma.Decimal }[]>`
      SELECT t.currency AS currency, SUM(e.amount) AS total
      FROM "LedgerEntry" e JOIN "LedgerTxn" t ON t.id = e."txnId"
      GROUP BY t.currency HAVING SUM(e.amount) <> 0`;
    const negativeUserAccounts = await this.prisma.$queryRaw<{ accountId: string }[]>`
      SELECT a.id AS "accountId"
      FROM "LedgerAccount" a JOIN "LedgerEntry" e ON e."accountId" = a.id
      WHERE a."ownerType" = 'USER'
      GROUP BY a.id HAVING SUM(e.amount) < 0`;
    const unbalancedTxnIds = unbalancedTxns.map((r) => r.txnId);
    const currencies = unbalancedCurrencies.map((r) => r.currency);
    const negatives = negativeUserAccounts.map((r) => r.accountId);
    return {
      ok: unbalancedTxnIds.length === 0 && currencies.length === 0 && negatives.length === 0,
      unbalancedTxnIds,
      unbalancedCurrencies: currencies,
      negativeUserAccountIds: negatives,
    };
  }

  async mirrorTotal(currency: string): Promise<Prisma.Decimal> {
    const agg = await this.prisma.ledgerEntry.aggregate({
      where: {
        account: { ownerType: LedgerOwnerType.USER, currency, kind: { in: [...MIRROR_KINDS] } },
      },
      _sum: { amount: true },
    });
    return agg._sum.amount ?? ZERO;
  }

  /** Every currency that has at least one ledger account. */
  async currencies(): Promise<string[]> {
    const rows = await this.prisma.ledgerAccount.findMany({ distinct: ['currency'], select: { currency: true }, orderBy: { currency: 'asc' } });
    return rows.map((r) => r.currency);
  }
}
