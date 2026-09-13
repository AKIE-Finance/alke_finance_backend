import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { KycProviderPort, KycVerificationInput, KycVerificationResult, ScreeningHit } from '../kyc.types';

/**
 * Fournisseur simulé (KYC_MODE=simulated, interdit en pilote/production par
 * env.validation). Document toujours conforme, vivacité 0,95 ; un nom
 * contenant « PEP » ou « SANCTION » déclenche un hit de criblage pour tester
 * le parcours de revue manuelle.
 */
@Injectable()
export class SimulatedKycProvider implements KycProviderPort {
  readonly name = 'SIMULATED';

  async verify(input: KycVerificationInput): Promise<KycVerificationResult> {
    const upper = input.fullName.toUpperCase();
    const hits: ScreeningHit[] = [];
    if (upper.includes('PEP')) hits.push({ list: 'PEP', name: input.fullName, score: 0.92 });
    if (upper.includes('SANCTION')) hits.push({ list: 'UN_SANCTIONS', name: input.fullName, score: 0.97 });
    return {
      providerRef: `SIM-${randomUUID()}`,
      documentOk: true,
      livenessScore: 0.95,
      hits,
      details: { provider: this.name, documentType: input.documentType, documentCountry: input.documentCountry },
    };
  }
}
