import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { NotificationChannel, NotificationLog, NotificationPreference, NotificationStatus, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { DomainEvent } from '../../common/events/domain-events';
import { normalizePaging } from '../users/users.service';
import {
  DispatchInput,
  DispatchResult,
  MAX_ATTEMPTS,
  NOTIFICATION_ADAPTERS,
  NotificationChannelAdapter,
  RenderedMessage,
} from './notifications.types';
import { NotificationCategory, templateFor } from './templates';

const STAFF_ROLES: readonly UserRole[] = [UserRole.ADMIN, UserRole.COMPLIANCE];

/** Preference defaults for users without a NotificationPreference row (mirrors the Prisma defaults). */
const DEFAULT_PREFS: Pick<NotificationPreference, 'push' | 'email' | 'orders' | 'priceAlerts' | 'news' | 'promo' | 'community'> = {
  push: true, email: true, orders: true, priceAlerts: true, news: true, promo: false, community: true,
};

type Recipient = { id: string; email: string; phone: string; notificationPref: NotificationPreference | null; devices: { pushToken: string | null }[] };

/**
 * Notifications (blueprint §4.19) : une ligne Notification (in-app) + une
 * ligne NotificationLog par canal, envoyée par l'adaptateur du canal ;
 * les échecs sont rejoués toutes les 5 minutes (3 tentatives au plus).
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly adapters: Map<NotificationChannel, NotificationChannelAdapter>;

  constructor(private readonly prisma: PrismaService, @Inject(NOTIFICATION_ADAPTERS) adapters: NotificationChannelAdapter[]) {
    this.adapters = new Map(adapters.map((a) => [a.channel, a]));
  }

  // ---------------------------------------------------------------- dispatch

  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    const template = templateFor(input.template);
    const message: RenderedMessage = input.message ?? template?.render(input.payload) ?? { title: input.template, body: '' };
    const user = await this.prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true, email: true, phone: true, notificationPref: true, devices: { select: { pushToken: true }, where: { pushToken: { not: null } }, take: 1 } },
    });
    if (!user) {
      this.logger.warn(`Notification ${input.template} ignorée : utilisateur ${input.userId} introuvable.`);
      return { notificationId: null, logIds: [] };
    }
    const payload = toJson(input.payload);
    const channels = this.allowedChannels(user, dedupe(input.channels), template?.category ?? 'admin');

    let notificationId: string | null = null;
    if (channels.includes(NotificationChannel.IN_APP)) {
      const row = await this.prisma.notification.create({
        data: { userId: user.id, title: message.title, body: message.body, type: input.eventName ?? input.template },
      });
      notificationId = row.id;
    }

    const logIds: string[] = [];
    for (const channel of channels) {
      const log = await this.prisma.notificationLog.create({
        data: {
          userId: user.id,
          channel,
          recipient: this.recipientFor(channel, user),
          template: input.template,
          payload: { ...payload, title: message.title, body: message.body },
          eventName: input.eventName ?? null,
          status: NotificationStatus.QUEUED,
        },
      });
      logIds.push((await this.attempt(log, message)).id);
    }
    return { notificationId, logIds };
  }

  /** Runs one delivery attempt and records the outcome on the log line. */
  private async attempt(log: NotificationLog, message: RenderedMessage): Promise<NotificationLog> {
    const adapter = this.adapters.get(log.channel);
    try {
      if (!adapter) throw new Error(`Aucun adaptateur pour le canal ${log.channel}.`);
      const result = await adapter.send({ recipient: log.recipient, template: log.template, message, payload: log.payload });
      return this.prisma.notificationLog.update({
        where: { id: log.id },
        data: { status: NotificationStatus.SENT, attempts: { increment: 1 }, providerRef: result.providerRef, error: null, sentAt: new Date() },
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Envoi ${log.channel} (${log.template}) échoué : ${error}`);
      return this.prisma.notificationLog.update({
        where: { id: log.id },
        data: { status: NotificationStatus.FAILED, attempts: { increment: 1 }, error: error.slice(0, 1000) },
      });
    }
  }

  private allowedChannels(user: Recipient, channels: NotificationChannel[], category: NotificationCategory): NotificationChannel[] {
    const prefs = user.notificationPref ?? DEFAULT_PREFS;
    const categoryOn = category !== 'orders' || prefs.orders;
    return channels.filter((c) => {
      if (c === NotificationChannel.IN_APP) return true;
      if (!categoryOn) return false;
      if (c === NotificationChannel.PUSH) return prefs.push && user.devices.length > 0;
      if (c === NotificationChannel.EMAIL) return prefs.email;
      return true; // SMS: no opt-out flag in v1.0 (transactional)
    });
  }

  private recipientFor(channel: NotificationChannel, user: Recipient): string {
    switch (channel) {
      case NotificationChannel.SMS:
        return user.phone;
      case NotificationChannel.EMAIL:
        return user.email;
      case NotificationChannel.PUSH:
        return user.devices[0]?.pushToken ?? `user:${user.id}`;
      default:
        return `user:${user.id}`;
    }
  }

  // ------------------------------------------------------------------ events

  /** Bus handler for user-facing events: the payload's `userId` is the recipient, the event name the template. */
  async onUserEvent(event: DomainEvent): Promise<void> {
    const template = templateFor(event.name);
    if (!template) return;
    const userId = typeof event.payload.userId === 'string' ? event.payload.userId : null;
    if (!userId) {
      this.logger.debug(`Événement ${event.name} sans userId : aucune notification.`);
      return;
    }
    await this.dispatch({
      userId,
      channels: template.channels,
      template: event.name,
      payload: { ...event.payload, entityType: event.entityType, entityId: event.entityId },
      eventName: event.name,
    });
  }

  /** ApprovalRequested: in-app notice to every active ADMIN / COMPLIANCE user (maker-checker, §4.17). */
  async onApprovalRequested(event: DomainEvent): Promise<void> {
    const staff = await this.prisma.user.findMany({ where: { role: { in: [...STAFF_ROLES] }, isBlocked: false }, select: { id: true } });
    for (const { id } of staff) {
      await this.dispatch({
        userId: id,
        channels: [NotificationChannel.IN_APP],
        template: 'ApprovalRequested',
        payload: { ...event.payload, entityType: event.entityType, entityId: event.entityId },
        eventName: event.name,
      });
    }
  }

  // ------------------------------------------------------------------- retry

  @Cron(CronExpression.EVERY_5_MINUTES)
  async retryFailedJob(): Promise<void> {
    const result = await this.retryFailed();
    if (result.retried) this.logger.log(`Relance notifications : ${result.sent}/${result.retried} envoyée(s).`);
  }

  async retryFailed(limit = 200): Promise<{ retried: number; sent: number }> {
    const failed = await this.prisma.notificationLog.findMany({
      where: { status: NotificationStatus.FAILED, attempts: { lt: MAX_ATTEMPTS } },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    let sent = 0;
    for (const log of failed) {
      const message = messageFromPayload(log.payload, log.template);
      const done = await this.attempt(log, message);
      if (done.status === NotificationStatus.SENT) sent++;
    }
    return { retried: failed.length, sent };
  }

  // -------------------------------------------------------------------- admin

  async listLog(filter: { status?: NotificationStatus; page?: number; pageSize?: number }) {
    const { page, pageSize } = normalizePaging(filter.page, filter.pageSize, 50);
    const where: Prisma.NotificationLogWhereInput = filter.status ? { status: filter.status } : {};
    const [items, total] = await Promise.all([
      this.prisma.notificationLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.notificationLog.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }
}

function dedupe(channels: NotificationChannel[]): NotificationChannel[] {
  return [...new Set(channels)];
}

function toJson(value: Record<string, unknown>): Prisma.JsonObject {
  return JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))) as Prisma.JsonObject;
}

function messageFromPayload(payload: Prisma.JsonValue | null, template: string): RenderedMessage {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const rec = payload as Record<string, unknown>;
    return { title: typeof rec.title === 'string' ? rec.title : template, body: typeof rec.body === 'string' ? rec.body : '' };
  }
  return { title: template, body: '' };
}
