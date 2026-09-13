import { ConflictException, ForbiddenException, INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { AlertSource, ApprovalState, BrokerAccountState, DocumentType, KycStatus, UserRole } from '@prisma/client';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { EventsModule } from '../src/common/events/events.module';
import { EventBus } from '../src/common/events/event-bus.service';
import { DomainEvent } from '../src/common/events/domain-events';
import { CommonModule } from '../src/common/common.module';
import { LedgerModule } from '../src/modules/ledger/ledger.module';
import { ConfigValuesModule } from '../src/modules/config/config-values.module';
import { ConfigValuesService } from '../src/modules/config/config-values.service';
import { StorageModule } from '../src/modules/storage/storage.module';
import { ApprovalsModule } from '../src/modules/approvals/approvals.module';
import { ApprovalsService } from '../src/modules/approvals/approvals.service';
import { KycModule } from '../src/modules/kyc/kyc.module';
import { KycService } from '../src/modules/kyc/kyc.service';
import { ComplianceModule } from '../src/modules/compliance/compliance.module';
import { resetDatabase } from './helpers/db';
import { createMarket, createPartner, createUser, setConfig } from './helpers/brokerage-fixtures';

const PNG = Buffer.from('\x89PNG fake image bytes for the kyc test');

describe('KYC (blueprint §4.7)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let kyc: KycService;
  let approvals: ApprovalsService;
  let configValues: ConfigValuesService;
  let baseUrl: string;
  const published: DomainEvent[] = [];
  let adminId: string;
  let complianceId: string;

  beforeAll(async () => {
    process.env.KYC_MODE = 'simulated';
    process.env.DOCUMENTS_DIR = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'alke-kyc-docs-'));
    process.env.API_BASE_URL = '';
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        EventsModule,
        CommonModule,
        LedgerModule,
        ConfigValuesModule,
        StorageModule,
        ApprovalsModule,
        KycModule,
        ComplianceModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
    kyc = app.get(KycService);
    approvals = app.get(ApprovalsService);
    configValues = app.get(ConfigValuesService);
    app.get(EventBus).subscribe('*', (e) => {
      published.push(e);
    });
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    configValues.invalidate();
    published.length = 0;
    adminId = (await createUser(prisma, { role: UserRole.ADMIN })).id;
    complianceId = (await createUser(prisma, { role: UserRole.COMPLIANCE })).id;
  });

  afterAll(async () => {
    await app.close();
  });

  /** Opens, fills and submits a complete case for `userId`. */
  async function submitCase(userId: string) {
    await kyc.openCase(userId);
    await kyc.updateCase(userId, { documentType: DocumentType.NATIONAL_ID, documentCountry: 'cm', questionnaire: { objective: 'epargne' } });
    await kyc.addDocument(userId, { kind: 'FRONT', contentType: 'image/png', base64: PNG.toString('base64') });
    await kyc.addDocument(userId, { kind: 'SELFIE', contentType: 'image/jpeg', base64: `data:image/jpeg;base64,${PNG.toString('base64')}` });
    return kyc.submit(userId);
  }

  it('a clean simulated user is auto-validated and gets a REQUESTED BrokerAccount at the ACTIVE BVMAC partner', async () => {
    const market = await createMarket(prisma);
    const partner = await createPartner(prisma, market.id);
    const user = await createUser(prisma, { kycStatus: KycStatus.NOT_STARTED, fullName: 'Aline Mbappe' });

    const draft = await kyc.openCase(user.id);
    expect(draft.status).toBe(KycStatus.DRAFT);
    expect(draft.documentCountry).toBe('CM');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).kycStatus).toBe(KycStatus.DRAFT);
    // Submitting an incomplete case is refused.
    await expect(kyc.submit(user.id)).rejects.toThrow('type de document');

    const done = await submitCase(user.id);
    expect(done.status).toBe(KycStatus.VALIDATED);
    expect(done.autoDecision).toBe(true);
    expect(done.providerRef).toMatch(/^SIM-/);
    expect(done.livenessScore?.toFixed(2)).toBe('0.95');
    const refreshed = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(refreshed.kycStatus).toBe(KycStatus.VALIDATED);
    expect(refreshed.kycValidatedAt).not.toBeNull();
    expect(await kyc.isTradingAllowed(user.id)).toBe(true);

    const account = await prisma.brokerAccount.findUniqueOrThrow({ where: { userId_partnerId: { userId: user.id, partnerId: partner.id } } });
    expect(account.state).toBe(BrokerAccountState.REQUESTED);
    expect(published.map((e) => e.name)).toEqual(expect.arrayContaining(['KYCSubmitted', 'KYCAutoApproved', 'KYCValidated', 'BrokerAccountRequested']));
    expect(await prisma.complianceAlert.count()).toBe(0);
    // A validated user cannot open another case.
    await expect(kyc.openCase(user.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it('without an ACTIVE BVMAC partner the validation still succeeds and the account request is deferred', async () => {
    const market = await createMarket(prisma);
    await createPartner(prisma, market.id, { agreementStatus: 'SIGNED' });
    const user = await createUser(prisma, { kycStatus: KycStatus.NOT_STARTED });
    const done = await submitCase(user.id);
    expect(done.status).toBe(KycStatus.VALIDATED);
    expect(await prisma.brokerAccount.count()).toBe(0);
  });

  it('a PEP hit goes to MANUAL_REVIEW with a ComplianceAlert; the decision is a COMPLIANCE_DECISION approval', async () => {
    const market = await createMarket(prisma);
    await createPartner(prisma, market.id);
    const user = await createUser(prisma, { kycStatus: KycStatus.NOT_STARTED, fullName: 'Paul PEP Ondoa' });
    const submitted = await submitCase(user.id);
    expect(submitted.status).toBe(KycStatus.MANUAL_REVIEW);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).kycStatus).toBe(KycStatus.MANUAL_REVIEW);
    expect(await kyc.isTradingAllowed(user.id)).toBe(false);

    const alert = await prisma.complianceAlert.findFirstOrThrow({ where: { source: AlertSource.KYC_SCREENING } });
    expect(alert.entityId).toBe(submitted.id);
    expect(alert.userId).toBe(user.id);
    expect(alert.summary).toContain('Criblage KYC positif');
    expect((await kyc.queue()).map((c) => c.id)).toEqual([submitted.id]);

    // Maker: the decision does not apply yet.
    const decision = await kyc.decide(adminId, submitted.id, KycStatus.VALIDATED);
    expect(decision.pendingApproval?.actionType).toBe('COMPLIANCE_DECISION');
    expect((await prisma.kycSubmission.findUniqueOrThrow({ where: { id: submitted.id } })).status).toBe(KycStatus.MANUAL_REVIEW);

    // Checker: the compliance module's executor applies it through KycService.
    const done = await approvals.approve(decision.pendingApproval!.id, complianceId, 'Source de revenus documentée');
    expect(done.state).toBe(ApprovalState.EXECUTED);
    const validated = await prisma.kycSubmission.findUniqueOrThrow({ where: { id: submitted.id } });
    expect(validated.status).toBe(KycStatus.VALIDATED);
    expect(validated.autoDecision).toBe(false);
    expect(validated.reviewedByAdminId).toBe(complianceId);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).kycStatus).toBe(KycStatus.VALIDATED);
    expect(await prisma.brokerAccount.count({ where: { userId: user.id } })).toBe(1);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'KYC_APPROVED', entityId: submitted.id } });
    expect((audit.afterJson as { approvalId: string }).approvalId).toBe(done.id);
  });

  it('rejections count towards the resubmission cap (kyc.max_resubmissions)', async () => {
    await setConfig(prisma, 'kyc.max_resubmissions', 1);
    const user = await createUser(prisma, { kycStatus: KycStatus.NOT_STARTED });
    const first = await submitCase(user.id);
    // Clean file → auto-validated; force it back to manual review to exercise a human rejection.
    await prisma.$transaction([
      prisma.kycSubmission.update({ where: { id: first.id }, data: { status: KycStatus.MANUAL_REVIEW, autoDecision: false } }),
      prisma.user.update({ where: { id: user.id }, data: { kycStatus: KycStatus.MANUAL_REVIEW, kycValidatedAt: null } }),
    ]);
    await expect(kyc.decide(adminId, first.id, KycStatus.REJECTED)).rejects.toThrow('motif');
    const rejected = await kyc.decide(adminId, first.id, KycStatus.REJECTED, 'Pièce illisible');
    expect(rejected.pendingApproval).toBeNull();
    expect(rejected.case.status).toBe(KycStatus.REJECTED);
    const afterReject = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(afterReject.kycStatus).toBe(KycStatus.REJECTED);
    expect(afterReject.kycRejectionReason).toBe('Pièce illisible');
    expect(afterReject.kycResubmissions).toBe(1);
    expect(published.map((e) => e.name)).toContain('KYCRejected');

    // Cap reached (1): no new case.
    await expect(kyc.openCase(user.id)).rejects.toBeInstanceOf(ForbiddenException);

    // Raising the cap re-opens the door; the rejected case is not decidable any more.
    await setConfig(prisma, 'kyc.max_resubmissions', 3);
    configValues.invalidate();
    const second = await kyc.openCase(user.id);
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe(KycStatus.DRAFT);
    await expect(kyc.decide(adminId, first.id, KycStatus.VALIDATED)).rejects.toBeInstanceOf(ConflictException);
  });

  it('documents are served only through a valid signed URL', async () => {
    const user = await createUser(prisma, { kycStatus: KycStatus.NOT_STARTED });
    await kyc.openCase(user.id);
    await kyc.addDocument(user.id, { kind: 'FRONT', contentType: 'image/png', base64: PNG.toString('base64') });
    const mine = await kyc.myCase(user.id);
    expect(mine?.documentFrontKey).toMatch(/-front-[0-9a-f]{12}\.png$/);
    const url = mine!.documentFrontUrl!;
    expect(url).toMatch(/^\/kyc\/documents\/.+\?exp=\d+&sig=[0-9a-f]{64}$/);

    const ok = await fetch(`${baseUrl}${url}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await ok.arrayBuffer()).equals(PNG)).toBe(true);

    // Tampered signature, tampered expiry and unknown key are all refused.
    const tampered = url.replace(/sig=([0-9a-f])/, (_m, c: string) => `sig=${c === 'a' ? 'b' : 'a'}`);
    expect((await fetch(`${baseUrl}${tampered}`)).status).toBe(403);
    const extended = url.replace(/exp=(\d+)/, (_m, e: string) => `exp=${Number(e) + 3600}`);
    expect((await fetch(`${baseUrl}${extended}`)).status).toBe(403);
    expect((await fetch(`${baseUrl}/kyc/documents/${mine!.documentFrontKey}`)).status).toBe(403);
    const otherKey = url.replace(mine!.documentFrontKey!, 'unknown-front-000000000000.png');
    expect((await fetch(`${baseUrl}${otherKey}`)).status).toBe(403);

    // Replacing a document deletes the previous file.
    await kyc.addDocument(user.id, { kind: 'FRONT', contentType: 'image/png', base64: PNG.toString('base64') });
    expect((await fetch(`${baseUrl}${url}`)).status).toBe(404);
  });
});
