import { Injectable } from '@nestjs/common';
import { KycProviderPort, KycVerificationInput, KycVerificationResult } from '../kyc.types';

/**
 * Espace réservé Smile ID (KYC_MODE=smileid). L'intégration (jobs Enhanced
 * KYC + Document Verification, callbacks signés) nécessite SMILE_ID_PARTNER_ID /
 * SMILE_ID_API_KEY et le SDK ; hors périmètre de ce lot.
 */
@Injectable()
export class SmileIdProvider implements KycProviderPort {
  readonly name = 'SMILE_ID';

  async verify(_input: KycVerificationInput): Promise<KycVerificationResult> {
    throw new Error('Fournisseur Smile ID non configuré');
  }
}
