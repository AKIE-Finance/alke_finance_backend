import { IsBoolean, IsEnum, IsNumber, IsOptional, IsString } from 'class-validator';
import { FeeType } from '@prisma/client';

export class UpsertFeeDto {
  @IsOptional()
  @IsString()
  marketId?: string;

  @IsEnum(FeeType)
  feeType: FeeType;

  @IsBoolean()
  isPercentage: boolean;

  @IsNumber()
  value: number;

  @IsOptional()
  @IsNumber()
  minAmount?: number;

  @IsOptional()
  @IsNumber()
  maxAmount?: number;

  @IsString()
  label: string;
}
