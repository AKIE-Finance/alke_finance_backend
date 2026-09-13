import { KycStatus, OrderSide, Prisma } from '@prisma/client';
import { D } from '../../common/money';

/**
 * Pure eligibility rules (blueprint §4.13). No I/O: the service loads the
 * facts and these functions decide, which keeps them trivially unit-testable.
 */

export interface PolicyCheck {
  allow: boolean;
  reason?: string;
  /** True when the refusal should surface to compliance rather than only to the user. */
  review?: boolean;
}

export const ALLOW: PolicyCheck = { allow: true };
export const deny = (reason: string, review = false): PolicyCheck => ({ allow: false, reason, review });

export interface UserFacts {
  kycStatus: KycStatus;
  isBlocked: boolean;
  isDemo: boolean;
}

export interface MarketFacts {
  liveTrading: boolean;
  /** The process-level connector; a real market on a simulated connector is still simulated. */
  connectorSimulated: boolean;
}

export const isSimulatedTrading = (market: MarketFacts): boolean => !(market.liveTrading && !market.connectorSimulated);

export function ruleCanTrade(user: UserFacts, market: MarketFacts): PolicyCheck {
  if (user.isBlocked) return deny('Votre compte est suspendu. Contactez le support.', true);
  if (user.kycStatus !== KycStatus.VALIDATED) {
    return deny('Votre dossier KYC doit être validé avant de pouvoir passer un ordre.');
  }
  if (isSimulatedTrading(market) && !user.isDemo) {
    return deny('Ce marché n’est pas encore ouvert aux ordres réels.');
  }
  return ALLOW;
}

export function ruleCanOpenBrokerAccount(user: Pick<UserFacts, 'kycStatus' | 'isBlocked'>): PolicyCheck {
  if (user.isBlocked) return deny('Votre compte est suspendu. Contactez le support.', true);
  if (user.kycStatus !== KycStatus.VALIDATED) {
    return deny('Votre dossier KYC doit être validé avant l’ouverture d’un compte-titres.');
  }
  return ALLOW;
}

export interface OrderDraftFacts {
  side: OrderSide;
  quantity: Prisma.Decimal.Value;
  /** Cash needed for a BUY (estimated total + fees), in the instrument currency. */
  maxAmount: Prisma.Decimal.Value;
  currency: string;
}

export interface InstrumentFacts {
  isActive: boolean;
  lastPrice: Prisma.Decimal | null;
  lotSize: number;
}

export interface FundsFacts {
  available: Prisma.Decimal;
  /** Settled quantity held minus quantity already reserved by open sell orders. */
  sellableQuantity: Prisma.Decimal;
  /** Pilot cap per order (XAF); null disables the cap. */
  orderCap: Prisma.Decimal | null;
}

export function ruleCanPlaceOrder(draft: OrderDraftFacts, instrument: InstrumentFacts, funds: FundsFacts): PolicyCheck {
  const qty = D(draft.quantity);
  if (!instrument.isActive || instrument.lastPrice == null) {
    return deny('Valeur indisponible ou sans cours de référence.');
  }
  if (!qty.greaterThan(0)) return deny('La quantité doit être strictement positive.');
  const lot = Math.max(1, instrument.lotSize);
  if (!qty.mod(lot).isZero()) return deny(`La quantité doit être un multiple de ${lot}.`);

  if (funds.orderCap && draft.currency.toUpperCase() === 'XAF' && D(draft.maxAmount).greaterThan(funds.orderCap)) {
    return deny(`Plafond pilote dépassé : un ordre ne peut pas excéder ${funds.orderCap.toFixed(0)} XAF.`);
  }

  if (draft.side === OrderSide.BUY) {
    if (funds.available.lessThan(draft.maxAmount)) {
      return deny(
        `Solde ${draft.currency} insuffisant (disponible : ${funds.available.toFixed()}, requis : ${D(draft.maxAmount).toFixed()}).`,
      );
    }
  } else if (funds.sellableQuantity.lessThan(qty)) {
    return deny('Quantité insuffisante en portefeuille pour cette vente.');
  }
  return ALLOW;
}
