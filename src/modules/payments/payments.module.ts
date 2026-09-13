import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { PaymentsAdminController } from './payments-admin.controller';
import { PaymentsWebhookController } from './payments-webhook.controller';
import { PaymentsExpiryJob } from './payments-expiry.job';
import { PaymentProviderRegistry } from './providers/provider-registry';
import { SimulatedProvider } from './providers/simulated.provider';
import { MtnMomoProvider } from './providers/mtn-momo.provider';
import { CinetPayProvider } from './providers/cinetpay.provider';

/**
 * Depends on the global LedgerModule, ConfigValuesModule, EventsModule,
 * CommonModule (AuditService) and PrismaModule.
 */
@Module({
  providers: [PaymentsService, PaymentsExpiryJob, PaymentProviderRegistry, SimulatedProvider, MtnMomoProvider, CinetPayProvider],
  controllers: [PaymentsController, PaymentsAdminController, PaymentsWebhookController],
  exports: [PaymentsService, PaymentProviderRegistry],
})
export class PaymentsModule {}
