import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  BrokerAccountState,
  KycStatus,
  KycSubmission,
  MarketCode,
  PartnerAgreementStatus,
  Prisma,
  SupportedCountry,
  User,
} from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { EventBus } from '../../common/events/event-bus.service';
import { AuditService } from '../../common/services/audit.service';
import { ConfigValuesService } from '../config/config-values.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { DOCUMENT_CONTENT_TYPES, DOCUMENT_STORAGE, DocumentStoragePort } from '../storage/storage.types';
import { UpdateKycCaseDto } from './dto/update-case.dto';
import { AddKycDocumentDto } from './dto/add-document.dto';
import {
  IN_PROGRESS_STATUSES,
  KYC_CONFIG_KEYS,
  KYC_DEFAULTS,
  KYC_PROVIDER,
  KycDecision,
  KycProviderPort,
  KycVerificationResult,
  REVIEWABLE_STATUSES,
  ScreeningHit,
} from './kyc.types';

const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

/** SupportedCountry (ISO-3 style enum) → ISO-2 used by the allow-list and the document country. */
const COUNTRY_ISO2: Record<SupportedCountry, string | null> = {
  CIV: 'CI', SEN: 'SN', TGO: 'TG', BEN: 'BJ', BFA: 'BF', MLI: 'ML',
  CMR: 'CM', GAB: 'GA', COG: 'CG', GNQ: 'GQ', INTL: null,
};

const CASE_USER_SELECT = { id: true, fullName: true, email: true, phone: true, country: true, kycStatus: true, kycResubmissions: true } as const;

export interface StoredScreening {
  providerRef: string;
  documentOk: boolean;
  livenessScore: number;
  hits: ScreeningHit[];
  countryAllowed: boolean;
  checkedAt: string;
  details?: Record<string, unknown>;
}

type CaseWithUser = KycSubmission & { user: { id: string; fullName: string; email: string; phone: string; country: SupportedCountry; kycStatus: KycStatus; kycResubmissions: number } };

/**
 * Cycle KYC (blueprint §4.7) : DRAFT → SUBMITTED → AUTO_APPROVED|MANUAL_REVIEW
 * → VALIDATED|REJECTED ; RE_KYC rouvre un dossier. Les pièces vivent dans le
 * stockage privé (clés sur KycSubmission), jamais en URL publique.
 */
@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBus,
    private readonly audit: AuditService,
    private readonly config: ConfigValuesService,
    private readonly approvals: ApprovalsService,
    @Inject(KYC_PROVIDER) private readonly provider: KycProviderPort,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStoragePort,
  ) {}

  // ------------------------------------------------------------- contract

  /** ARCHITECTURE.md: the one question other modules ask KYC. */
  async isTradingAllowed(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { kycStatus: true, isBlocked: true } });
    return !!user && !user.isBlocked && user.kycStatus === KycStatus.VALIDATED;
  }

  // --------------------------------------------------------------- user side

  async openCase(userId: string): Promise<KycSubmission> {
    const user = await this.getUser(userId);
    const latest = await this.latestCase(userId);
    if (latest) {
      if (latest.status === KycStatus.DRAFT) return latest;
      if (IN_PROGRESS_STATUSES.includes(latest.status)) {
        throw new ConflictException('Un dossier KYC est déjà en cours de traitement.');
      }
      if (latest.status === KycStatus.VALIDATED && user.kycStatus !== KycStatus.RE_KYC) {
        throw new ConflictException('Votre identité est déjà vérifiée.');
      }
      if (latest.status === KycStatus.REJECTED) {
        const max = await this.config.get<number>(KYC_CONFIG_KEYS.maxResubmissions, KYC_DEFAULTS.maxResubmissions);
        if (user.kycResubmissions >= max) {
          throw new ForbiddenException('Nombre maximal de soumissions KYC atteint. Contactez le support.');
        }
      }
    }
    const created = await this.prisma.$transaction(async (tx) => {
      const c = await tx.kycSubmission.create({
        data: { userId, status: KycStatus.DRAFT, documentCountry: COUNTRY_ISO2[user.country] ?? null },
      });
      if (user.kycStatus !== KycStatus.RE_KYC) {
        await tx.user.update({ where: { id: userId }, data: { kycStatus: KycStatus.DRAFT } });
      }
      return c;
    });
    return created;
  }

  async updateCase(userId: string, dto: UpdateKycCaseDto): Promise<KycSubmission> {
    const kycCase = await this.draftOrThrow(userId);
    return this.prisma.kycSubmission.update({
      where: { id: kycCase.id },
      data: {
        ...(dto.documentType !== undefined && { documentType: dto.documentType }),
        ...(dto.documentCountry !== undefined && { documentCountry: dto.documentCountry.toUpperCase() }),
        ...(dto.questionnaire !== undefined && { questionnaire: dto.questionnaire as Prisma.InputJsonValue }),
      },
    });
  }

  async addDocument(userId: string, dto: AddKycDocumentDto): Promise<KycSubmission> {
    const kycCase = await this.draftOrThrow(userId);
    const content = decodeBase64(dto.base64);
    if (content.length === 0) throw new BadRequestException('Fichier vide.');
    if (content.length > MAX_DOCUMENT_BYTES) throw new BadRequestException('La pièce dépasse 5 Mo.');
    const ext = DOCUMENT_CONTENT_TYPES[dto.contentType];
    if (!ext) throw new BadRequestException('Format accepté : JPEG, PNG, WebP ou PDF.');

    const key = `${kycCase.id}-${dto.kind.toLowerCase()}-${randomBytes(6).toString('hex')}.${ext}`;
    await this.storage.put(key, content, dto.contentType);

    const field = dto.kind === 'FRONT' ? 'documentFrontKey' : dto.kind === 'BACK' ? 'documentBackKey' : 'selfieKey';
    const previous = kycCase[field];
    const updated = await this.prisma.kycSubmission.update({ where: { id: kycCase.id }, data: { [field]: key } });
    if (previous) await this.storage.delete(previous).catch(() => undefined);
    return updated;
  }

  async submit(userId: string): Promise<KycSubmission> {
    const kycCase = await this.draftOrThrow(userId);
    const user = await this.getUser(userId);
    if (!kycCase.documentType) throw new BadRequestException('Le type de document est requis.');
    if (!kycCase.documentCountry) throw new BadRequestException('Le pays du document est requis.');
    if (!kycCase.documentFrontKey) throw new BadRequestException('Le recto de la pièce d’identité est requis.');
    if (!kycCase.selfieKey) throw new BadRequestException('Le selfie est requis.');

    const submittedAt = new Date();
    await this.prisma.$transaction([
      this.prisma.kycSubmission.update({ where: { id: kycCase.id }, data: { status: KycStatus.SUBMITTED, submittedAt } }),
      this.prisma.user.update({ where: { id: userId }, data: { kycStatus: KycStatus.SUBMITTED } }),
    ]);
    await this.events.publish('KYCSubmitted', {
      entityType: 'KycSubmission', entityId: kycCase.id, actor: userId,
      payload: { userId, kycCaseId: kycCase.id, documentType: kycCase.documentType, documentCountry: kycCase.documentCountry },
    });

    let result: KycVerificationResult;
    try {
      result = await this.provider.verify({
        submissionId: kycCase.id,
        userId,
        fullName: user.fullName,
        documentType: kycCase.documentType,
        documentCountry: kycCase.documentCountry,
        documentKeys: { front: kycCase.documentFrontKey, back: kycCase.documentBackKey, selfie: kycCase.selfieKey },
      });
    } catch (err) {
      // Provider down: keep the case for a human, never lose the submission.
      this.logger.error(`Fournisseur KYC indisponible : ${(err as Error).message}`);
      return this.toManualReview(kycCase.id, userId, null, [`Fournisseur indisponible : ${(err as Error).message}`]);
    }

    const allowed = await this.allowedCountries();
    const countryAllowed = allowed.includes(kycCase.documentCountry.toUpperCase());
    const minLiveness = await this.config.get<number>(KYC_CONFIG_KEYS.minLiveness, KYC_DEFAULTS.minLiveness);
    const screening: StoredScreening = {
      providerRef: result.providerRef,
      documentOk: result.documentOk,
      livenessScore: result.livenessScore,
      hits: result.hits,
      countryAllowed,
      checkedAt: new Date().toISOString(),
      details: result.details,
    };
    await this.prisma.kycSubmission.update({
      where: { id: kycCase.id },
      data: {
        providerRef: result.providerRef,
        livenessScore: new Prisma.Decimal(result.livenessScore).toDecimalPlaces(2),
        screeningResult: screening as unknown as Prisma.InputJsonValue,
      },
    });

    const reasons: string[] = [];
    if (!result.documentOk) reasons.push('Document non conforme');
    if (result.hits.length > 0) reasons.push(`Criblage : ${result.hits.map((h) => h.list).join(', ')}`);
    if (result.livenessScore < minLiveness) reasons.push(`Vivacité insuffisante (${result.livenessScore})`);
    if (!countryAllowed) reasons.push(`Pays non couvert (${kycCase.documentCountry})`);

    if (reasons.length === 0) {
      await this.prisma.kycSubmission.update({ where: { id: kycCase.id }, data: { status: KycStatus.AUTO_APPROVED, autoDecision: true } });
      await this.events.publish('KYCAutoApproved', {
        entityType: 'KycSubmission', entityId: kycCase.id, actor: 'SYSTEM',
        payload: { userId, kycCaseId: kycCase.id, providerRef: result.providerRef, livenessScore: result.livenessScore },
      });
      return this.validate(kycCase.id, userId, null, null, true);
    }
    return this.toManualReview(kycCase.id, userId, screening, reasons);
  }

  async myCase(userId: string) {
    const latest = await this.latestCase(userId);
    if (!latest) return null;
    return this.withUrls(latest);
  }

  async listMine(userId: string) {
    const rows = await this.prisma.kycSubmission.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
    return Promise.all(rows.map((r) => this.withUrls(r)));
  }

  // -------------------------------------------------------------- admin side

  queue(status?: KycStatus) {
    return this.prisma.kycSubmission.findMany({
      where: status ? { status } : { status: { in: [...REVIEWABLE_STATUSES] } },
      include: { user: { select: CASE_USER_SELECT } },
      orderBy: [{ submittedAt: 'asc' }, { createdAt: 'asc' }],
      take: 200,
    });
  }

  async adminCase(id: string) {
    const kycCase = await this.prisma.kycSubmission.findUnique({
      where: { id },
      include: { user: { select: CASE_USER_SELECT }, reviewedByAdmin: { select: { id: true, fullName: true, email: true } } },
    });
    if (!kycCase) throw new NotFoundException('Dossier KYC introuvable.');
    return this.withUrls(kycCase);
  }

  /**
   * Admin decision. Cases with screening hits go through maker-checker
   * (COMPLIANCE_DECISION, executed by the compliance module); the rest apply
   * immediately.
   */
  async decide(adminId: string, caseId: string, decision: KycDecision, reason?: string) {
    const kycCase = await this.reviewableOrThrow(caseId);
    if (decision === KycStatus.REJECTED && !reason?.trim()) {
      throw new BadRequestException('Un motif est requis pour un refus.');
    }
    if (hitsOf(kycCase).length > 0) {
      const approval = await this.approvals.request({
        actionType: 'COMPLIANCE_DECISION',
        entityType: 'KycSubmission',
        entityId: caseId,
        payload: { kycCaseId: caseId, userId: kycCase.userId, decision, reason: reason ?? null, hits: hitsOf(kycCase) as unknown as Prisma.InputJsonValue },
        reason: reason?.trim() || `Décision KYC ${decision} sur un dossier avec alerte de criblage`,
        makerId: adminId,
      });
      return { pendingApproval: approval, case: kycCase };
    }
    const updated = await this.applyDecision(caseId, decision, reason ?? null, adminId, null);
    return { pendingApproval: null, case: updated };
  }

  /** Final write for a decision — called directly or by the COMPLIANCE_DECISION executor. */
  async applyDecision(caseId: string, decision: KycDecision, reason: string | null, reviewerId: string, approvalId: string | null): Promise<KycSubmission> {
    const kycCase = await this.reviewableOrThrow(caseId);
    if (decision === KycStatus.VALIDATED) return this.validate(caseId, kycCase.userId, reviewerId, approvalId, false);
    return this.reject(kycCase, reason ?? 'Dossier refusé', reviewerId, approvalId);
  }

  // ---------------------------------------------------------------- internals

  private async validate(caseId: string, userId: string, reviewerId: string | null, approvalId: string | null, auto: boolean): Promise<KycSubmission> {
    const now = new Date();
    const [updated] = await this.prisma.$transaction([
      this.prisma.kycSubmission.update({
        where: { id: caseId },
        data: { status: KycStatus.VALIDATED, decidedAt: now, autoDecision: auto, reviewedByAdminId: reviewerId, rejectionReason: null },
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: { kycStatus: KycStatus.VALIDATED, kycValidatedAt: now, kycRejectionReason: null },
      }),
    ]);
    await this.audit.log({
      actorUserId: reviewerId,
      action: auto ? 'KYC_AUTO_APPROVED' : 'KYC_APPROVED',
      entityType: 'KycSubmission',
      entityId: caseId,
      after: { status: KycStatus.VALIDATED, userId, approvalId, auto },
    });
    await this.events.publish('KYCValidated', {
      entityType: 'KycSubmission', entityId: caseId, actor: reviewerId ?? 'SYSTEM',
      payload: { userId, kycCaseId: caseId, auto, approvalId },
    });
    await this.requestBrokerAccount(userId, reviewerId ?? 'SYSTEM');
    return updated;
  }

  private async reject(kycCase: KycSubmission, reason: string, reviewerId: string, approvalId: string | null): Promise<KycSubmission> {
    const now = new Date();
    const [updated] = await this.prisma.$transaction([
      this.prisma.kycSubmission.update({
        where: { id: kycCase.id },
        data: { status: KycStatus.REJECTED, decidedAt: now, autoDecision: false, reviewedByAdminId: reviewerId, rejectionReason: reason },
      }),
      this.prisma.user.update({
        where: { id: kycCase.userId },
        data: { kycStatus: KycStatus.REJECTED, kycRejectionReason: reason, kycResubmissions: { increment: 1 } },
      }),
    ]);
    await this.audit.log({
      actorUserId: reviewerId,
      action: 'KYC_REJECTED',
      entityType: 'KycSubmission',
      entityId: kycCase.id,
      before: { status: kycCase.status },
      after: { status: KycStatus.REJECTED, reason, approvalId },
    });
    await this.events.publish('KYCRejected', {
      entityType: 'KycSubmission', entityId: kycCase.id, actor: reviewerId,
      payload: { userId: kycCase.userId, kycCaseId: kycCase.id, reason, approvalId },
    });
    return updated;
  }

  private async toManualReview(caseId: string, userId: string, screening: StoredScreening | null, reasons: string[]): Promise<KycSubmission> {
    const [updated] = await this.prisma.$transaction([
      this.prisma.kycSubmission.update({ where: { id: caseId }, data: { status: KycStatus.MANUAL_REVIEW, autoDecision: false } }),
      this.prisma.user.update({ where: { id: userId }, data: { kycStatus: KycStatus.MANUAL_REVIEW } }),
    ]);
    await this.events.publish('KYCManualReview', {
      entityType: 'KycSubmission', entityId: caseId, actor: 'SYSTEM',
      payload: { userId, kycCaseId: caseId, reasons, hits: screening?.hits ?? [], livenessScore: screening?.livenessScore ?? null },
    });
    return updated;
  }

  /** First ACTIVE BVMAC partner gets an account request (A4: one KYC file opens the SDB account). */
  private async requestBrokerAccount(userId: string, actor: string): Promise<void> {
    const partner = await this.prisma.marketPartner.findFirst({
      where: { agreementStatus: PartnerAgreementStatus.ACTIVE, market: { code: MarketCode.BVMAC } },
      orderBy: { createdAt: 'asc' },
    });
    if (!partner) {
      this.logger.warn('Aucun partenaire BVMAC ACTIVE : ouverture de compte-titres différée.');
      return;
    }
    const existing = await this.prisma.brokerAccount.findUnique({ where: { userId_partnerId: { userId, partnerId: partner.id } } });
    if (existing) return;
    const account = await this.prisma.brokerAccount.create({ data: { userId, partnerId: partner.id, state: BrokerAccountState.REQUESTED } });
    await this.events.publish('BrokerAccountRequested', {
      entityType: 'BrokerAccount', entityId: account.id, actor,
      payload: { userId, partnerId: partner.id, partnerName: partner.name, brokerAccountId: account.id },
    });
  }

  private async allowedCountries(): Promise<string[]> {
    const raw = await this.config.get<unknown>(KYC_CONFIG_KEYS.allowedCountries, [...KYC_DEFAULTS.allowedCountries]);
    const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [...KYC_DEFAULTS.allowedCountries];
    return list.map((c) => String(c).trim().toUpperCase()).filter(Boolean).map((c) => (c in COUNTRY_ISO2 ? COUNTRY_ISO2[c as SupportedCountry] ?? c : c));
  }

  private async getUser(userId: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Utilisateur introuvable.');
    return user;
  }

  private latestCase(userId: string): Promise<KycSubmission | null> {
    return this.prisma.kycSubmission.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
  }

  private async draftOrThrow(userId: string): Promise<KycSubmission> {
    const latest = await this.latestCase(userId);
    if (!latest || latest.status !== KycStatus.DRAFT) {
      throw new ConflictException('Aucun dossier KYC en brouillon. Ouvrez d’abord un dossier (POST /kyc/case).');
    }
    return latest;
  }

  private async reviewableOrThrow(caseId: string): Promise<CaseWithUser> {
    const kycCase = await this.prisma.kycSubmission.findUnique({ where: { id: caseId }, include: { user: { select: CASE_USER_SELECT } } });
    if (!kycCase) throw new NotFoundException('Dossier KYC introuvable.');
    if (!REVIEWABLE_STATUSES.includes(kycCase.status)) {
      throw new ConflictException(`Ce dossier n’est plus en attente de décision (statut ${kycCase.status}).`);
    }
    const latest = await this.latestCase(kycCase.userId);
    if (latest && latest.id !== kycCase.id) {
      throw new ConflictException('Un dossier plus récent existe pour cet utilisateur.');
    }
    return kycCase;
  }

  /** Adds short-lived signed URLs next to the stored keys (owner or back-office view). */
  async withUrls<T extends KycSubmission>(kycCase: T): Promise<T & { documentFrontUrl: string | null; documentBackUrl: string | null; selfieUrl: string | null }> {
    const url = async (key: string | null) => {
      if (!key) return null;
      try {
        return await this.storage.getSignedUrl(key);
      } catch {
        return null;
      }
    };
    return {
      ...kycCase,
      documentFrontUrl: await url(kycCase.documentFrontKey),
      documentBackUrl: await url(kycCase.documentBackKey),
      selfieUrl: await url(kycCase.selfieKey),
    };
  }
}

export function hitsOf(kycCase: KycSubmission): ScreeningHit[] {
  const screening = kycCase.screeningResult;
  if (!screening || typeof screening !== 'object' || Array.isArray(screening)) return [];
  const hits = (screening as Record<string, unknown>).hits;
  return Array.isArray(hits) ? (hits as ScreeningHit[]) : [];
}

function decodeBase64(input: string): Buffer {
  const raw = input.includes(',') && input.trim().startsWith('data:') ? input.slice(input.indexOf(',') + 1) : input;
  const clean = raw.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new BadRequestException('Contenu base64 invalide.');
  return Buffer.from(clean, 'base64');
}
