import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentIntent, PaymentProvider } from '@prisma/client';
import { D } from '../../../common/money';
import { CollectionResult, PaymentProviderPort, StatusResult } from './payment-provider.port';

interface MomoTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface MomoRequestToPayStatus {
  status: 'PENDING' | 'SUCCESSFUL' | 'FAILED';
  financialTransactionId?: string;
  externalId?: string;
  reason?: string | { code?: string; message?: string };
}

/**
 * MTN MoMo Collections API (skeleton with the real endpoint paths).
 *  - POST /collection/token/                       Basic apiUser:apiKey
 *  - POST /collection/v1_0/requesttopay            X-Reference-Id = intent.reference (UUID v4)
 *  - GET  /collection/v1_0/requesttopay/{ref}
 * MoMo callbacks carry NO signature, hence no `verifyCallback`: the callback
 * only triggers a `queryStatus`.
 *
 * Env: MTN_MOMO_BASE_URL (default sandbox), MTN_MOMO_SUBSCRIPTION_KEY,
 * MTN_MOMO_API_USER, MTN_MOMO_API_KEY, MTN_MOMO_TARGET_ENV (sandbox|mtncameroon…),
 * MTN_MOMO_CALLBACK_URL, MTN_MOMO_CURRENCY (sandbox only accepts EUR).
 */
@Injectable()
export class MtnMomoProvider implements PaymentProviderPort {
  readonly provider = PaymentProvider.MTN_MOMO;
  private readonly logger = new Logger(MtnMomoProvider.name);
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly config: ConfigService) {}

  private get baseUrl(): string {
    return (this.config.get<string>('MTN_MOMO_BASE_URL') || 'https://sandbox.momodeveloper.mtn.com').replace(/\/$/, '');
  }

  private get targetEnv(): string {
    return this.config.get<string>('MTN_MOMO_TARGET_ENV') || 'sandbox';
  }

  private baseHeaders(): Record<string, string> {
    const key = this.config.get<string>('MTN_MOMO_SUBSCRIPTION_KEY');
    if (!key) throw new BadGatewayException('MTN MoMo n’est pas configuré (clé d’abonnement absente).');
    return { 'Ocp-Apim-Subscription-Key': key, 'X-Target-Environment': this.targetEnv };
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const user = this.config.get<string>('MTN_MOMO_API_USER');
    const key = this.config.get<string>('MTN_MOMO_API_KEY');
    if (!user || !key) throw new BadGatewayException('MTN MoMo n’est pas configuré (identifiants API absents).');
    const res = await fetch(`${this.baseUrl}/collection/token/`, {
      method: 'POST',
      headers: { ...this.baseHeaders(), Authorization: `Basic ${Buffer.from(`${user}:${key}`).toString('base64')}` },
    });
    if (!res.ok) throw new BadGatewayException(`MTN MoMo : échec d’authentification (${res.status}).`);
    const body = (await res.json()) as MomoTokenResponse;
    this.token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  async requestCollection(intent: PaymentIntent): Promise<CollectionResult> {
    if (!intent.msisdn) throw new BadGatewayException('Numéro Mobile Money requis pour MTN MoMo.');
    const token = await this.accessToken();
    const headers: Record<string, string> = {
      ...this.baseHeaders(),
      Authorization: `Bearer ${token}`,
      'X-Reference-Id': intent.reference,
      'Content-Type': 'application/json',
    };
    const callback = this.config.get<string>('MTN_MOMO_CALLBACK_URL');
    if (callback) headers['X-Callback-Url'] = callback;
    const res = await fetch(`${this.baseUrl}/collection/v1_0/requesttopay`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        amount: D(intent.amount).toFixed(),
        currency: this.config.get<string>('MTN_MOMO_CURRENCY') || intent.currency,
        externalId: intent.reference,
        payer: { partyIdType: 'MSISDN', partyId: intent.msisdn.replace(/^\+/, '') },
        payerMessage: 'Dépôt AlKÉ Finance',
        payeeNote: `Intent ${intent.reference}`,
      }),
    });
    // 202 Accepted: the request is queued; 409 means the reference was already submitted (idempotent retry).
    if (res.status === 202 || res.status === 409) return { providerRef: intent.reference, status: 'PENDING', raw: { httpStatus: res.status } };
    const text = await res.text().catch(() => '');
    this.logger.warn(`requesttopay ${intent.reference} → ${res.status} ${text}`);
    if (res.status >= 500) throw new BadGatewayException('MTN MoMo est indisponible pour le moment.');
    return { providerRef: intent.reference, status: 'FAILED', raw: { httpStatus: res.status, body: text } };
  }

  async queryStatus(intent: PaymentIntent): Promise<StatusResult> {
    const token = await this.accessToken();
    const res = await fetch(`${this.baseUrl}/collection/v1_0/requesttopay/${encodeURIComponent(intent.reference)}`, {
      headers: { ...this.baseHeaders(), Authorization: `Bearer ${token}` },
    });
    if (res.status === 404) return { status: 'PENDING', providerStatus: 'NOT_FOUND', raw: { httpStatus: 404 } };
    if (!res.ok) throw new BadGatewayException(`MTN MoMo : statut indisponible (${res.status}).`);
    const body = (await res.json()) as MomoRequestToPayStatus;
    const reason = typeof body.reason === 'string' ? body.reason : body.reason?.message ?? body.reason?.code;
    return {
      status: body.status === 'SUCCESSFUL' ? 'PAID' : body.status === 'FAILED' ? 'FAILED' : 'PENDING',
      providerRef: body.financialTransactionId ?? intent.reference,
      providerStatus: body.status,
      reason,
      raw: body,
    };
  }
}
