import { Injectable } from '@nestjs/common';
import { PaymentIntent, PaymentProvider } from '@prisma/client';
import { D } from '../../../common/money';
import { CollectionResult, PaymentProviderPort, StatusResult } from './payment-provider.port';

/**
 * PAYMENTS_MODE=simulated. Deterministic: an amount equal to 13 or ending in
 * .99 fails, everything else is paid at once. Never used on pilot/production
 * (env.validation.ts refuses the mode there).
 */
@Injectable()
export class SimulatedProvider implements PaymentProviderPort {
  readonly provider = PaymentProvider.SIMULATED;

  static shouldFail(amount: PaymentIntent['amount']): boolean {
    const a = D(amount);
    return a.equals(13) || a.toFixed(2).endsWith('.99');
  }

  async requestCollection(intent: PaymentIntent): Promise<CollectionResult> {
    const failed = SimulatedProvider.shouldFail(intent.amount);
    return { providerRef: `SIM-${intent.reference}`, status: failed ? 'FAILED' : 'PAID', raw: { simulated: true } };
  }

  async queryStatus(intent: PaymentIntent): Promise<StatusResult> {
    const failed = SimulatedProvider.shouldFail(intent.amount);
    return {
      status: failed ? 'FAILED' : 'PAID',
      providerRef: `SIM-${intent.reference}`,
      providerStatus: failed ? 'SIMULATED_FAILED' : 'SIMULATED_SUCCESSFUL',
      reason: failed ? 'Simulation : paiement refusé.' : undefined,
      raw: { simulated: true },
    };
  }
}
