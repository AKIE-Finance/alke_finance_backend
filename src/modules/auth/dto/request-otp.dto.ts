import { IsEnum, IsString } from 'class-validator';
import { OtpPurpose } from '@prisma/client';

export class RequestOtpDto {
  @IsString()
  destination: string;

  @IsEnum(OtpPurpose)
  purpose: OtpPurpose;
}
