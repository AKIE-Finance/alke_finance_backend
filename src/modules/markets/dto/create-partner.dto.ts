import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';
import { PartnerType } from '@prisma/client';

export class CreatePartnerDto {
  @IsString()
  marketId: string;

  @IsString()
  name: string;

  @IsEnum(PartnerType)
  type: PartnerType;

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
}
