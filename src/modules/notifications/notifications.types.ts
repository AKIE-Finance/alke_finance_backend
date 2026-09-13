import { NotificationChannel, Prisma } from '@prisma/client';

/**
 * Notifications (blueprint §4.19). Every user-facing event becomes one in-app
 * Notification row plus one NotificationLog row per outbound channel. Channel
 * adapters never reach the network in v1.0: with no provider key configured
 * they record a simulated send; with a key present they fail explicitly
 * ("non implémenté") so a misconfigured pilot is visible in the log.
 */

export interface RenderedMessage {
  title: string;
  body: string;
}

export interface ChannelSendInput {
  recipient: string;
  template: string;
  message: RenderedMessage;
  payload: Prisma.JsonValue | null;
}

export interface ChannelSendResult {
  providerRef: string | null;
}

export interface NotificationChannelAdapter {
  readonly channel: NotificationChannel;
  send(input: ChannelSendInput): Promise<ChannelSendResult>;
}

export const NOTIFICATION_ADAPTERS = Symbol('NOTIFICATION_ADAPTERS');

export interface DispatchInput {
  userId: string;
  channels: NotificationChannel[];
  template: string;
  payload: Record<string, unknown>;
  eventName?: string;
  /** Override the template's rendering (used for ad-hoc admin notices). */
  message?: RenderedMessage;
}

export interface DispatchResult {
  notificationId: string | null;
  logIds: string[];
}

export const MAX_ATTEMPTS = 3;
export const SIMULATED_PROVIDER_REF = 'SIMULATED';
export const NOT_IMPLEMENTED_ERROR = 'non implémenté';

/** Provider key that switches an adapter from simulated to "real" (not implemented in v1.0). */
export const PROVIDER_KEY_ENV: Record<Exclude<NotificationChannel, 'IN_APP'>, string> = {
  SMS: 'AFRICAS_TALKING_API_KEY',
  EMAIL: 'SENDGRID_API_KEY',
  PUSH: 'FCM_SERVER_KEY',
};
