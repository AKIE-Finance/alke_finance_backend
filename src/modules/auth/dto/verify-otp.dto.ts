import { IsEnum, IsString } from 'class-validator';
import { OtpPurpose } from '@prisma/client';

export class VerifyOtpDto {
  @IsString()
  destination: string;

  @IsEnum(OtpPurpose)
  purpose: OtpPurpose;

  @IsString()
  code: string;
}
