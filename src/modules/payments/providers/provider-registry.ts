import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentIntent, PaymentProvider } from '@prisma/client';
import { PaymentProviderPort } from './payment-provider.port';
import { SimulatedProvider } from './simulated.provider';
import { MtnMomoProvider } from './mtn-momo.provider';
import { CinetPayProvider } from './cinetpay.provider';

/** Chooses the adapter: PAYMENTS_MODE=simulated → SimulatedProvider for everything; else by intent.provider. */
@Injectable()
export class PaymentProviderRegistry {
  private readonly adapters: Partial<Record<PaymentProvider, PaymentProviderPort>>;

  constructor(
    private readonly config: ConfigService,
    private readonly simulated: SimulatedProvider,
    momo: MtnMomoProvider,
    cinetpay: CinetPayProvider,
  ) {
    this.adapters = {
      [PaymentProvider.SIMULATED]: simulated,
      [PaymentProvider.MTN_MOMO]: momo,
      [PaymentProvider.CINETPAY]: cinetpay,
    };
  }

  get simulatedMode(): boolean {
    return this.config.get<string>('PAYMENTS_MODE', 'simulated') === 'simulated';
  }

  /** Throws (French, 400) when the provider cannot be used in the current mode. */
  for(intent: Pick<PaymentIntent, 'provider'>): PaymentProviderPort {
    if (this.simulatedMode) return this.simulated;
    if (intent.provider === PaymentProvider.SIMULATED) {
      throw new BadRequestException('Le fournisseur simulé n’est pas disponible dans cet environnement.');
    }
    const adapter = this.adapters[intent.provider];
    if (!adapter) throw new BadRequestException(`Le fournisseur ${intent.provider} n’est pas encore disponible.`);
    return adapter;
  }

  /** Adapter for a webhook route (independent of the mode; used for signature checks). */
  byProvider(provider: PaymentProvider): PaymentProviderPort | undefined {
    return this.simulatedMode ? this.simulated : this.adapters[provider];
  }
}
