import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { NotificationChannel, NotificationStatus, UserRole } from '@prisma/client';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { EventsModule } from '../src/common/events/events.module';
import { EventBus } from '../src/common/events/event-bus.service';
import { CommonModule } from '../src/common/common.module';
import { NotificationsModule } from '../src/modules/notifications/notifications.module';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { resetDatabase } from './helpers/db';
import { createUser } from './helpers/brokerage-fixtures';

describe('Notifications (blueprint §4.19)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let events: EventBus;
  let notifications: NotificationsService;

  beforeAll(async () => {
    delete process.env.AFRICAS_TALKING_API_KEY;
    delete process.env.SENDGRID_API_KEY;
    delete process.env.FCM_SERVER_KEY;
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, EventsModule, CommonModule, NotificationsModule],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    events = moduleRef.get(EventBus);
    notifications = moduleRef.get(NotificationsService);
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    delete process.env.SENDGRID_API_KEY;
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  async function userWithDevice(overrides: Parameters<typeof createUser>[1] = {}) {
    const user = await createUser(prisma, overrides);
    await prisma.userDevice.create({ data: { userId: user.id, label: 'Pixel', platform: 'android', pushToken: `tok-${user.id.slice(0, 8)}` } });
    return user;
  }

  it('DepositConfirmed → one in-app Notification and one SENT log per channel (simulated providers)', async () => {
    const user = await userWithDevice();
    await events.publish('DepositConfirmed', {
      entityType: 'PaymentIntent', entityId: 'pi-1', actor: 'PROVIDER:SIMULATED',
      payload: { userId: user.id, amount: '25000', currency: 'XAF', provider: 'SIMULATED' },
    });

    const inApp = await prisma.notification.findMany({ where: { userId: user.id } });
    expect(inApp).toHaveLength(1);
    expect(inApp[0].type).toBe('DepositConfirmed');
    expect(inApp[0].title).toBe('Dépôt confirmé');
    expect(inApp[0].body).toContain('25000 XAF');

    const logs = await prisma.notificationLog.findMany({ where: { userId: user.id }, orderBy: { channel: 'asc' } });
    expect(logs.map((l) => l.channel).sort()).toEqual([NotificationChannel.IN_APP, NotificationChannel.PUSH, NotificationChannel.SMS].sort());
    for (const log of logs) {
      expect(log.status).toBe(NotificationStatus.SENT);
      expect(log.attempts).toBe(1);
      expect(log.eventName).toBe('DepositConfirmed');
      expect(log.sentAt).not.toBeNull();
    }
    const sms = logs.find((l) => l.channel === NotificationChannel.SMS)!;
    expect(sms.recipient).toBe(user.phone);
    expect(sms.providerRef).toBe('SIMULATED');
    const push = logs.find((l) => l.channel === NotificationChannel.PUSH)!;
    expect(push.recipient).toMatch(/^tok-/);
  });

  it('a preference switched off suppresses that channel but never the in-app row', async () => {
    const user = await userWithDevice();
    await prisma.notificationPreference.create({ data: { userId: user.id, push: false, email: true } });
    await events.publish('KYCValidated', {
      entityType: 'KycSubmission', entityId: 'k-1', actor: 'SYSTEM', payload: { userId: user.id, kycCaseId: 'k-1', auto: true },
    });
    const logs = await prisma.notificationLog.findMany({ where: { userId: user.id } });
    expect(logs.map((l) => l.channel).sort()).toEqual([NotificationChannel.EMAIL, NotificationChannel.IN_APP].sort());
    expect(await prisma.notification.count({ where: { userId: user.id } })).toBe(1);

    // orders=false silences every outbound channel of order events.
    await prisma.notificationPreference.update({ where: { userId: user.id }, data: { push: true, orders: false } });
    await events.publish('OrderExecuted', {
      entityType: 'Order', entityId: 'o-1', actor: 'SDB_FILE', payload: { userId: user.id, filledQuantity: '10', avgExecutedPrice: '5000' },
    });
    const orderLogs = await prisma.notificationLog.findMany({ where: { userId: user.id, eventName: 'OrderExecuted' } });
    expect(orderLogs.map((l) => l.channel)).toEqual([NotificationChannel.IN_APP]);
    expect(await prisma.notification.count({ where: { userId: user.id, type: 'OrderExecuted' } })).toBe(1);
  });

  it('a configured provider key without a client fails the log line; the retry job re-sends it once the key is gone', async () => {
    const user = await userWithDevice();
    process.env.SENDGRID_API_KEY = 'SG.test-key';
    await events.publish('KYCRejected', {
      entityType: 'KycSubmission', entityId: 'k-2', actor: 'SYSTEM', payload: { userId: user.id, reason: 'Document illisible' },
    });
    const failed = await prisma.notificationLog.findFirstOrThrow({ where: { userId: user.id, channel: NotificationChannel.EMAIL } });
    expect(failed.status).toBe(NotificationStatus.FAILED);
    expect(failed.attempts).toBe(1);
    expect(failed.error).toContain('non implémenté');
    expect(failed.recipient).toBe(user.email);

    // Still failing: attempts climb, status stays FAILED.
    let result = await notifications.retryFailed();
    expect(result).toEqual({ retried: 1, sent: 0 });
    expect((await prisma.notificationLog.findUniqueOrThrow({ where: { id: failed.id } })).attempts).toBe(2);

    delete process.env.SENDGRID_API_KEY;
    result = await notifications.retryFailed();
    expect(result).toEqual({ retried: 1, sent: 1 });
    const sent = await prisma.notificationLog.findUniqueOrThrow({ where: { id: failed.id } });
    expect(sent.status).toBe(NotificationStatus.SENT);
    expect(sent.attempts).toBe(3);
    expect(sent.providerRef).toBe('SIMULATED');
    expect(sent.error).toBeNull();

    // Exhausted lines are left alone.
    process.env.SENDGRID_API_KEY = 'SG.test-key';
    await events.publish('KYCRejected', { entityType: 'KycSubmission', entityId: 'k-3', actor: 'SYSTEM', payload: { userId: user.id, reason: 'x' } });
    await notifications.retryFailed();
    await notifications.retryFailed();
    const exhausted = await prisma.notificationLog.findFirstOrThrow({ where: { userId: user.id, channel: NotificationChannel.EMAIL, status: NotificationStatus.FAILED } });
    expect(exhausted.attempts).toBe(3);
    expect(await notifications.retryFailed()).toEqual({ retried: 0, sent: 0 });
  });

  it('ApprovalRequested notifies every ADMIN / COMPLIANCE user in-app; events without userId are ignored', async () => {
    const admin = await createUser(prisma, { role: UserRole.ADMIN });
    const compliance = await createUser(prisma, { role: UserRole.COMPLIANCE });
    const support = await createUser(prisma, { role: UserRole.SUPPORT });
    await createUser(prisma);
    await events.publish('ApprovalRequested', {
      entityType: 'PendingApproval', entityId: 'a-1', actor: admin.id,
      payload: { approvalId: 'a-1', actionType: 'LIVE_TRADING_TOGGLE', reason: 'Ouverture BVMAC', makerId: admin.id },
    });
    const rows = await prisma.notification.findMany({ where: { type: 'ApprovalRequested' } });
    expect(rows.map((r) => r.userId).sort()).toEqual([admin.id, compliance.id].sort());
    expect(rows[0].body).toContain('LIVE_TRADING_TOGGLE');
    expect(await prisma.notification.count({ where: { userId: support.id } })).toBe(0);

    await events.publish('OrderExpired', { entityType: 'Order', entityId: 'o-9', actor: 'SYSTEM', payload: { quantity: '1' } });
    expect(await prisma.notificationLog.count({ where: { eventName: 'OrderExpired' } })).toBe(0);

    const page = await notifications.listLog({ status: NotificationStatus.SENT, page: 1, pageSize: 500 });
    expect(page.pageSize).toBe(100);
    expect(page.total).toBe(2);
  });
});
