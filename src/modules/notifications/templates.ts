import { NotificationChannel } from '@prisma/client';
import { RenderedMessage } from './notifications.types';

/**
 * French user-facing templates (blueprint §4.19). `category` maps to the
 * NotificationPreference flag that can silence the outbound channels of the
 * template; the in-app row is always written.
 */
export type NotificationCategory = 'kyc' | 'wallet' | 'orders' | 'admin';

export interface NotificationTemplate {
  channels: NotificationChannel[];
  category: NotificationCategory;
  render(payload: Record<string, unknown>): RenderedMessage;
}

const str = (payload: Record<string, unknown>, key: string, fallback = ''): string => {
  const v = payload[key];
  return v === null || v === undefined ? fallback : String(v);
};

const money = (payload: Record<string, unknown>): string => {
  const amount = str(payload, 'amount');
  const currency = str(payload, 'currency', 'XAF');
  return amount ? `${amount} ${currency}` : '';
};

const { IN_APP, PUSH, EMAIL, SMS } = NotificationChannel;

export const TEMPLATES: Record<string, NotificationTemplate> = {
  KYCValidated: {
    channels: [IN_APP, PUSH, EMAIL],
    category: 'kyc',
    render: () => ({ title: 'Identité vérifiée', body: 'Votre dossier KYC a été validé. Vous pouvez maintenant alimenter votre compte et passer des ordres.' }),
  },
  KYCRejected: {
    channels: [IN_APP, PUSH, EMAIL],
    category: 'kyc',
    render: (p) => ({ title: 'Dossier KYC refusé', body: `Votre dossier a été refusé${str(p, 'reason') ? ` : ${str(p, 'reason')}` : '.'} Vous pouvez soumettre un nouveau dossier depuis l’application.` }),
  },
  KYCManualReview: {
    channels: [IN_APP, PUSH],
    category: 'kyc',
    render: () => ({ title: 'Dossier en cours d’examen', body: 'Votre dossier KYC est examiné par notre équipe. Vous recevrez une réponse sous 48 h ouvrées.' }),
  },
  DepositConfirmed: {
    channels: [IN_APP, PUSH, SMS],
    category: 'wallet',
    render: (p) => ({ title: 'Dépôt confirmé', body: `Votre dépôt de ${money(p)} a été crédité sur votre compte AlKÉ.` }),
  },
  DepositFailed: {
    channels: [IN_APP, PUSH, SMS],
    category: 'wallet',
    render: (p) => ({ title: 'Dépôt échoué', body: `Votre dépôt de ${money(p)} n’a pas abouti${str(p, 'reason') ? ` (${str(p, 'reason')})` : ''}. Aucun montant n’a été prélevé.` }),
  },
  WithdrawalPaid: {
    channels: [IN_APP, PUSH, SMS],
    category: 'wallet',
    render: (p) => ({ title: 'Retrait effectué', body: `Votre retrait de ${money(p)} a été versé.` }),
  },
  WithdrawalFailed: {
    channels: [IN_APP, PUSH, SMS],
    category: 'wallet',
    render: (p) => ({ title: 'Retrait échoué', body: `Votre retrait de ${money(p)} n’a pas pu être effectué${str(p, 'reason') ? ` : ${str(p, 'reason')}` : '.'} Les fonds sont de nouveau disponibles.` }),
  },
  OrderAcknowledged: {
    channels: [IN_APP, PUSH],
    category: 'orders',
    render: (p) => ({ title: 'Ordre reçu par la SDB', body: `Votre ordre a été pris en charge par la société de bourse${str(p, 'sdbRef') ? ` (réf. ${str(p, 'sdbRef')})` : ''}.` }),
  },
  OrderRejected: {
    channels: [IN_APP, PUSH],
    category: 'orders',
    render: (p) => ({ title: 'Ordre rejeté', body: `Votre ordre a été rejeté${str(p, 'reason') ? ` : ${str(p, 'reason')}` : '.'} Les fonds réservés ont été libérés.` }),
  },
  OrderExecuted: {
    channels: [IN_APP, PUSH],
    category: 'orders',
    render: (p) => ({
      title: 'Ordre exécuté',
      body: str(p, 'simulated') === 'true'
        ? 'Votre ordre simulé a été exécuté (aucun mouvement réel).'
        : `Votre ordre a été exécuté${str(p, 'filledQuantity') ? ` : ${str(p, 'filledQuantity')} titre(s)` : ''}${str(p, 'avgExecutedPrice') ? ` à ${str(p, 'avgExecutedPrice')} en moyenne` : ''}.`,
    }),
  },
  OrderPartiallyExecuted: {
    channels: [IN_APP, PUSH],
    category: 'orders',
    render: (p) => ({ title: 'Ordre partiellement exécuté', body: `${str(p, 'quantity')} titre(s) exécuté(s) à ${str(p, 'price')}. Le reste de l’ordre demeure en attente.` }),
  },
  OrderExpired: {
    channels: [IN_APP, PUSH],
    category: 'orders',
    render: () => ({ title: 'Ordre expiré', body: 'Votre ordre n’a pas été exécuté dans le délai de validité. Les fonds réservés ont été libérés.' }),
  },
  OrderCancelled: {
    channels: [IN_APP],
    category: 'orders',
    render: () => ({ title: 'Ordre annulé', body: 'Votre ordre a été annulé et les fonds réservés ont été libérés.' }),
  },
  SettlementConfirmed: {
    channels: [IN_APP, PUSH],
    category: 'orders',
    render: (p) => ({
      title: 'Règlement-livraison confirmé',
      body: str(p, 'side') === 'SELL'
        ? `Le produit de votre vente (${str(p, 'netAmount')} ${str(p, 'currency', 'XAF')}) est disponible.`
        : `Vos ${str(p, 'quantity')} titre(s) ont été livrés sur votre compte-titres.`,
    }),
  },
  ApprovalRequested: {
    channels: [IN_APP],
    category: 'admin',
    render: (p) => ({ title: 'Validation requise', body: `Action sensible ${str(p, 'actionType')} en attente de validation : ${str(p, 'reason')}` }),
  },
};

export function templateFor(name: string): NotificationTemplate | undefined {
  return TEMPLATES[name];
}
