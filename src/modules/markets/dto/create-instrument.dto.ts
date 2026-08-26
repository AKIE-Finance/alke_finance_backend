import { IsEnum, IsNumber, IsOptional, IsString } from 'class-validator';
import { AssetClass } from '@prisma/client';

export class CreateInstrumentDto {
  @IsString()
  marketId: string;

  @IsString()
  symbol: string;

  @IsString()
  name: string;

  @IsEnum(AssetClass)
  assetClass: AssetClass;

  @IsOptional()
  @IsString()
  sector?: string;

  @IsString()
  currency: string;

  @IsOptional()
  @IsNumber()
  lastPrice?: number;

  @IsOptional()
  @IsNumber()
  couponRate?: number;

  @IsOptional()
  @IsNumber()
  nominalPrice?: number;
}
