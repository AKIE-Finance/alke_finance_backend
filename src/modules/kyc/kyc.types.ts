import { DocumentType, KycStatus } from '@prisma/client';

/**
 * Fournisseur de vérification d'identité (blueprint §4.7) : contrôle
 * documentaire, vivacité (liveness) et criblage sanctions / PEP.
 */
export interface KycVerificationInput {
  submissionId: string;
  userId: string;
  fullName: string;
  documentType: DocumentType;
  documentCountry: string;
  documentKeys: { front: string; back?: string | null; selfie: string };
}

export interface ScreeningHit {
  list: string; // e.g. UN_SANCTIONS | OFAC | PEP
  name: string;
  score: number; // 0..1
}

export interface KycVerificationResult {
  providerRef: string;
  documentOk: boolean;
  livenessScore: number; // 0..1
  hits: ScreeningHit[];
  /** Free-form provider details, persisted in KycSubmission.screeningResult. */
  details?: Record<string, unknown>;
}

export interface KycProviderPort {
  readonly name: string;
  verify(input: KycVerificationInput): Promise<KycVerificationResult>;
}

export const KYC_PROVIDER = Symbol('KYC_PROVIDER');

export type KycDecision = Extract<KycStatus, 'VALIDATED' | 'REJECTED'>;
export type KycDocumentKind = 'FRONT' | 'BACK' | 'SELFIE';

export const KYC_CONFIG_KEYS = {
  allowedCountries: 'kyc.allowed_countries',
  maxResubmissions: 'kyc.max_resubmissions',
  minLiveness: 'kyc.min_liveness',
} as const;

export const KYC_DEFAULTS = {
  allowedCountries: ['CM', 'GA', 'CG', 'GQ'],
  maxResubmissions: 3,
  minLiveness: 0.8,
} as const;

/** Statuses an admin can still decide on. */
export const REVIEWABLE_STATUSES: readonly KycStatus[] = [KycStatus.SUBMITTED, KycStatus.MANUAL_REVIEW];

/** Statuses that count as "a case is in progress" (no new case may be opened). */
export const IN_PROGRESS_STATUSES: readonly KycStatus[] = [KycStatus.SUBMITTED, KycStatus.AUTO_APPROVED, KycStatus.MANUAL_REVIEW];
