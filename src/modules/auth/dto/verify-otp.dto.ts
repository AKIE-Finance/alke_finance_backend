import { IsEnum, IsOptional, IsString } from 'class-validator';
import { OtpPurpose } from '@prisma/client';

export class VerifyOtpDto {
  @IsString()
  destination: string;

  @IsEnum(OtpPurpose)
  purpose: OtpPurpose;

  @IsString()
  code: string;

  @IsOptional()
  @IsString()
  deviceId?: string;

  @IsOptional()
  @IsString()
  deviceLabel?: string;
}
