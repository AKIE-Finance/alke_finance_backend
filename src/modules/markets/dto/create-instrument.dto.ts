import { IsEnum, IsInt, IsNumber, IsOptional, IsPositive, IsString, IsUUID, Length, Matches, MaxLength } from 'class-validator';
import { AssetClass } from '@prisma/client';

/** ISIN : 12 caractères alphanumériques (ISO 6166), ex. CM0000035113. */
export const ISIN_REGEX = /^[A-Z0-9]{12}$/;

export class CreateInstrumentDto {
  @IsUUID()
  marketId: string;

  @IsString()
  @Length(1, 20)
  symbol: string;

  @IsOptional()
  @Matches(ISIN_REGEX, { message: "L'ISIN doit comporter 12 caractères alphanumériques." })
  isin?: string;

  @IsString()
  @Length(1, 120)
  name: string;

  @IsEnum(AssetClass)
  assetClass: AssetClass;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  sector?: string;

  @IsString()
  @Length(3, 3)
  currency: string;

  @IsOptional()
  @IsInt()
  @IsPositive()
  lotSize?: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  tickSize?: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  lastPrice?: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  couponRate?: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  nominalPrice?: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  minSubscription?: number;
}
