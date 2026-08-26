import { IsEnum, IsOptional, IsString, ValidateIf } from 'class-validator';
import { KycStatus } from '@prisma/client';

export class ReviewKycDto {
  @IsEnum(KycStatus)
  status: KycStatus; // VERIFIED ou REJECTED attendu ici

  @ValidateIf((o) => o.status === 'REJECTED')
  @IsString()
  @IsOptional()
  rejectionReason?: string;
}
