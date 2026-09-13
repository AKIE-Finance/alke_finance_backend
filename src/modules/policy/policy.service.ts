import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LEDGER_PORT, LedgerPort } from '../ledger/ledger.types';
import { D } from '../../common/money';
import {
  InstrumentFacts,
  MarketFacts,
  OrderDraftFacts,
  PolicyCheck,
  UserFacts,
  deny,
  isSimulatedTrading,
  ruleCanOpenBrokerAccount,
  ruleCanPlaceOrder,
  ruleCanTrade,
} from './policy.rules';

export type { PolicyCheck } from './policy.rules';

export const POLICY_CONFIG_KEYS = {
  orderCapXaf: 'pilot.order_cap_xaf',
  demoUserEmails: 'demo.user_emails',
} as const;
export const DEFAULT_ORDER_CAP_XAF = 250_000;

/**
 * Policy guards (blueprint §4.13): the single place where a business
 * eligibility rule lives. Facts are loaded here; decisions are made by the
 * pure functions in policy.rules.ts.
 *
 * ConfigValue rows are read directly (latest effective row for the key) so
 * the module has no dependency on the config module's cache.
 */
@Injectable()
export class PolicyService {
  constructor(private readonly prisma: PrismaService, @Inject(LEDGER_PORT) private readonly ledger: LedgerPort) {}

  async configValue<T>(key: string, tx?: Prisma.TransactionClient): Promise<T | undefined> {
    const now = new Date();
    const row = await (tx ?? this.prisma).configValue.findFirst({
      where: { key, effectiveFrom: { lte: now }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] },
      orderBy: { effectiveFrom: 'desc' },
    });
    return row ? (row.value as T) : undefined;
  }

  async orderCap(): Promise<Prisma.Decimal | null> {
    const raw = await this.configValue<number | string | null>(POLICY_CONFIG_KEYS.orderCapXaf);
    if (raw === null) return null;
    return D(raw ?? DEFAULT_ORDER_CAP_XAF);
  }

  /** Demo users may place simulated (paper) orders: configured e-mails, or everyone on a local machine (D15). */
  async isDemoUser(email: string): Promise<boolean> {
    if ((process.env.APP_ENV ?? 'local') === 'local') return true;
    const list = (await this.configValue<unknown>(POLICY_CONFIG_KEYS.demoUserEmails)) ?? [];
    return Array.isArray(list) && list.some((e) => typeof e === 'string' && e.toLowerCase() === email.toLowerCase());
  }

  connectorSimulated(): boolean {
    return (process.env.SDB_CONNECTOR ?? 'simulated') === 'simulated';
  }

  marketFacts(market: { liveTrading: boolean }): MarketFacts {
    return { liveTrading: market.liveTrading, connectorSimulated: this.connectorSimulated() };
  }

  isSimulated(market: { liveTrading: boolean }): boolean {
    return isSimulatedTrading(this.marketFacts(market));
  }

  private async userFacts(userId: string): Promise<UserFacts | null> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { kycStatus: true, isBlocked: true, email: true } });
    if (!user) return null;
    return { kycStatus: user.kycStatus, isBlocked: user.isBlocked, isDemo: await this.isDemoUser(user.email) };
  }

  async canTrade(userId: string, marketId: string): Promise<PolicyCheck> {
    const [user, market] = await Promise.all([this.userFacts(userId), this.prisma.market.findUnique({ where: { id: marketId } })]);
    if (!user) return deny('Utilisateur introuvable.');
    if (!market) return deny('Marché introuvable.');
    return ruleCanTrade(user, this.marketFacts(market));
  }

  async canOpenBrokerAccount(userId: string): Promise<PolicyCheck> {
    const user = await this.userFacts(userId);
    if (!user) return deny('Utilisateur introuvable.');
    return ruleCanOpenBrokerAccount(user);
  }

  /**
   * Order-level checks: instrument tradable, lot multiple, pilot cap, and
   * funds (AVAILABLE cash for a BUY, sellable settled quantity for a SELL).
   * Simulated orders skip the funds check (no ledger, no position reserve).
   */
  async canPlaceOrder(
    userId: string,
    draft: OrderDraftFacts & { instrumentId: string; simulated?: boolean },
    tx?: Prisma.TransactionClient,
  ): Promise<PolicyCheck> {
    const db = tx ?? this.prisma;
    const instrument = await db.instrument.findUnique({
      where: { id: draft.instrumentId },
      select: { isActive: true, lastPrice: true, lotSize: true },
    });
    if (!instrument) return deny('Valeur introuvable.');
    const facts: InstrumentFacts = { isActive: instrument.isActive, lastPrice: instrument.lastPrice, lotSize: instrument.lotSize };

    const orderCap = await this.orderCap();
    if (draft.simulated) {
      return ruleCanPlaceOrder(draft, facts, { available: D(draft.maxAmount), sellableQuantity: D(draft.quantity), orderCap });
    }

    const [balances, position] = await Promise.all([
      this.ledger.userBalances(userId, draft.currency, tx),
      db.position.findUnique({ where: { userId_instrumentId: { userId, instrumentId: draft.instrumentId } } }),
    ]);
    const sellable = position ? D(position.quantity).minus(position.reservedQuantity) : D(0);
    return ruleCanPlaceOrder(draft, facts, { available: balances.available, sellableQuantity: sellable, orderCap });
  }
}
