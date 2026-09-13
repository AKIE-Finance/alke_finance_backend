import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentIntent, PaymentProvider } from '@prisma/client';
import { createHmac, timingSafeEqual } from 'crypto';
import { D } from '../../../common/money';
import { CollectionResult, headerValue, PaymentProviderPort, StatusResult, WebhookHeaders } from './payment-provider.port';

interface CinetPayInitResponse {
  code: string;
  message?: string;
  data?: { payment_token?: string; payment_url?: string };
}

interface CinetPayCheckResponse {
  code: string;
  message?: string;
  data?: { status?: string; payment_method?: string; operator_id?: string; description?: string };
}

/** Fields concatenated (in this order) to compute the x-token HMAC-SHA256 of a CinetPay notification. */
export const CINETPAY_SIGNED_FIELDS = [
  'cpm_site_id',
  'cpm_trans_id',
  'cpm_trans_date',
  'cpm_amount',
  'cpm_currency',
  'signature',
  'payment_method',
  'cel_phone_num',
] as const;

/**
 * CinetPay checkout API (skeleton with the real endpoint paths).
 *  - POST /v2/payment        creates the hosted checkout (transaction_id = intent.reference)
 *  - POST /v2/payment/check  authoritative status
 * Notifications carry an `x-token` header: HMAC-SHA256 over the concatenated
 * signed fields, keyed with CINETPAY_SECRET_KEY.
 *
 * Env: CINETPAY_BASE_URL (default https://api-checkout.cinetpay.com),
 * CINETPAY_API_KEY, CINETPAY_SITE_ID, CINETPAY_SECRET_KEY, CINETPAY_NOTIFY_URL, CINETPAY_RETURN_URL.
 */
@Injectable()
export class CinetPayProvider implements PaymentProviderPort {
  readonly provider = PaymentProvider.CINETPAY;
  private readonly logger = new Logger(CinetPayProvider.name);

  constructor(private readonly config: ConfigService) {}

  private get baseUrl(): string {
    return (this.config.get<string>('CINETPAY_BASE_URL') || 'https://api-checkout.cinetpay.com').replace(/\/$/, '');
  }

  private credentials(): { apikey: string; site_id: string } {
    const apikey = this.config.get<string>('CINETPAY_API_KEY');
    const site_id = this.config.get<string>('CINETPAY_SITE_ID');
    if (!apikey || !site_id) throw new BadGatewayException('CinetPay n’est pas configuré.');
    return { apikey, site_id };
  }

  async requestCollection(intent: PaymentIntent): Promise<CollectionResult> {
    const res = await fetch(`${this.baseUrl}/v2/payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...this.credentials(),
        transaction_id: intent.reference,
        amount: D(intent.amount).toFixed(),
        currency: intent.currency,
        description: 'Dépôt AlKÉ Finance',
        channels: 'MOBILE_MONEY',
        customer_phone_number: intent.msisdn ?? undefined,
        notify_url: this.config.get<string>('CINETPAY_NOTIFY_URL'),
        return_url: this.config.get<string>('CINETPAY_RETURN_URL'),
        metadata: intent.id,
      }),
    });
    if (res.status >= 500) throw new BadGatewayException('CinetPay est indisponible pour le moment.');
    const body = (await res.json()) as CinetPayInitResponse;
    if (body.code !== '201' || !body.data?.payment_url) {
      this.logger.warn(`payment init ${intent.reference} → ${body.code} ${body.message ?? ''}`);
      return { status: 'FAILED', raw: body };
    }
    return { providerRef: body.data.payment_token, status: 'PENDING', paymentUrl: body.data.payment_url, raw: body };
  }

  async queryStatus(intent: PaymentIntent): Promise<StatusResult> {
    const res = await fetch(`${this.baseUrl}/v2/payment/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...this.credentials(), transaction_id: intent.reference }),
    });
    if (res.status >= 500) throw new BadGatewayException('CinetPay est indisponible pour le moment.');
    const body = (await res.json()) as CinetPayCheckResponse;
    const status = body.data?.status;
    return {
      status: body.code === '00' && status === 'ACCEPTED' ? 'PAID' : status === 'REFUSED' ? 'FAILED' : 'PENDING',
      providerRef: body.data?.operator_id ?? intent.providerRef ?? undefined,
      providerStatus: status ?? body.code,
      reason: status === 'REFUSED' ? body.data?.description ?? body.message : undefined,
      raw: body,
    };
  }

  verifyCallback(headers: WebhookHeaders, body: unknown): boolean {
    const secret = this.config.get<string>('CINETPAY_SECRET_KEY');
    const token = headerValue(headers, 'x-token');
    if (!secret || !token || typeof body !== 'object' || body === null) return false;
    const fields = body as Record<string, unknown>;
    const data = CINETPAY_SIGNED_FIELDS.map((f) => (fields[f] == null ? '' : String(fields[f]))).join('');
    const expected = createHmac('sha256', secret).update(data).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(token.trim().toLowerCase(), 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
