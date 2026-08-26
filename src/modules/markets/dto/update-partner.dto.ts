import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';
import { PartnerAgreementStatus, IntegrationTier } from '@prisma/client';

export class UpdatePartnerDto {
  @IsOptional()
  @IsEnum(PartnerAgreementStatus)
  agreementStatus?: PartnerAgreementStatus;

  @IsOptional()
  @IsEnum(IntegrationTier)
  integrationTier?: IntegrationTier;

  @IsOptional()
  @IsBoolean()
  aelpParticipant?: boolean;

  @IsOptional()
  @IsString()
  contactName?: string;

  @IsOptional()
  @IsString()
  contactEmail?: string;

  @IsOptional()
  @IsString()
  contactPhone?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  agreementNumber?: string;
}
