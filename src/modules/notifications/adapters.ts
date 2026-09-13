import { Injectable } from '@nestjs/common';
import { NotificationChannel } from '@prisma/client';
import {
  ChannelSendInput,
  ChannelSendResult,
  NOT_IMPLEMENTED_ERROR,
  NotificationChannelAdapter,
  PROVIDER_KEY_ENV,
  SIMULATED_PROVIDER_REF,
} from './notifications.types';

/** In-app: the Notification row is the delivery; the log line is always SENT. */
@Injectable()
export class InAppAdapter implements NotificationChannelAdapter {
  readonly channel = NotificationChannel.IN_APP;

  async send(_input: ChannelSendInput): Promise<ChannelSendResult> {
    return { providerRef: null };
  }
}

/**
 * Shared behaviour of the outbound channels (blueprint §4.19): no provider key
 * → simulated send (providerRef SIMULATED); key present → the real client is
 * not implemented in v1.0, so the send fails with a clear error and no network.
 */
abstract class ProviderBackedAdapter implements NotificationChannelAdapter {
  abstract readonly channel: Exclude<NotificationChannel, 'IN_APP'>;

  protected providerKey(): string | undefined {
    const value = process.env[PROVIDER_KEY_ENV[this.channel]];
    return value && value.trim() ? value : undefined;
  }

  async send(input: ChannelSendInput): Promise<ChannelSendResult> {
    if (!input.recipient) throw new Error('Destinataire manquant.');
    if (this.providerKey()) throw new Error(`${this.channel} : ${NOT_IMPLEMENTED_ERROR}`);
    return { providerRef: SIMULATED_PROVIDER_REF };
  }
}

/** Africa's Talking (AFRICAS_TALKING_API_KEY). */
@Injectable()
export class SmsAdapter extends ProviderBackedAdapter {
  readonly channel = NotificationChannel.SMS;
}

/** SendGrid (SENDGRID_API_KEY). */
@Injectable()
export class EmailAdapter extends ProviderBackedAdapter {
  readonly channel = NotificationChannel.EMAIL;
}

/** Firebase Cloud Messaging (FCM_SERVER_KEY). */
@Injectable()
export class PushAdapter extends ProviderBackedAdapter {
  readonly channel = NotificationChannel.PUSH;
}
