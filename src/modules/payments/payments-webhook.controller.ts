import { Body, Controller, Headers, HttpCode, Logger, Post, UnauthorizedException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PaymentDirection, PaymentIntentState, PaymentProvider } from '@prisma/client';
import { PaymentsService } from './payments.service';
import { PaymentProviderRegistry } from './providers/provider-registry';
import { headerValue, WebhookHeaders } from './providers/payment-provider.port';

/** Body/header fields that may carry our reference, per provider. */
const REFERENCE_FIELDS = ['reference', 'referenceId', 'externalId', 'external_id', 'cpm_trans_id', 'transaction_id', 'order_id', 'txnid'];

/**
 * Provider callbacks (public, no JWT). A callback is a hint, never a proof:
 * the payload is stored, the signature is checked when the provider has one,
 * and the intent is settled by re-querying the provider. Always answers 200
 * at once so the provider stops retrying.
 */
@ApiTags('webhooks')
@Controller('webhooks')
export class PaymentsWebhookController {
  private readonly logger = new Logger(PaymentsWebhookController.name);

  constructor(private readonly payments: PaymentsService, private readonly providers: PaymentProviderRegistry) {}

  @Post('momo')
  @HttpCode(200)
  momo(@Headers() headers: WebhookHeaders, @Body() body: unknown) {
    return this.handle(PaymentProvider.MTN_MOMO, headers, body);
  }

  @Post('cinetpay')
  @HttpCode(200)
  cinetpay(@Headers() headers: WebhookHeaders, @Body() body: unknown) {
    return this.handle(PaymentProvider.CINETPAY, headers, body);
  }

  @Post('orange')
  @HttpCode(200)
  orange(@Headers() headers: WebhookHeaders, @Body() body: unknown) {
    return this.handle(PaymentProvider.ORANGE_MONEY, headers, body);
  }

  private async handle(provider: PaymentProvider, headers: WebhookHeaders, body: unknown) {
    const reference = extractReference(headers, body);
    const intent = await this.payments.recordWebhook(provider, reference, body);
    if (!intent) {
      this.logger.warn(`${provider} callback without a matching intent (reference=${reference ?? 'none'})`);
      return { received: true, matched: false };
    }

    const adapter = this.providers.byProvider(provider);
    if (adapter?.verifyCallback && !adapter.verifyCallback(headers, body)) {
      this.logger.warn(`${provider} callback with an invalid signature for intent ${intent.id}`);
      throw new UnauthorizedException('Signature de notification invalide.');
    }

    if (intent.direction === PaymentDirection.IN && intent.state !== PaymentIntentState.PAID) {
      // Fire-and-forget: the provider gets its 200 now; the status re-query
      // decides the outcome. An unlucky crash is healed by recheck/expiry.
      void this.payments
        .confirmDeposit(intent.id, 'PAYMENT_WEBHOOK')
        .catch((err: Error) => this.logger.error(`confirmDeposit ${intent.id} failed: ${err.message}`, err.stack));
    }
    return { received: true, matched: true };
  }
}

export function extractReference(headers: WebhookHeaders, body: unknown): string | undefined {
  const fromHeader = headerValue(headers, 'x-reference-id');
  if (fromHeader) return fromHeader;
  if (typeof body !== 'object' || body === null) return undefined;
  const record = body as Record<string, unknown>;
  for (const field of REFERENCE_FIELDS) {
    const value = record[field];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}
