import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsEnum,
  IsNumberString,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { FeeType, LedgerAccountKind, LedgerOwnerType } from '@prisma/client';

const REASON = { message: 'Un motif (3 à 1000 caractères) est requis.' };

export class LiveTradingToggleDto {
  @IsBoolean()
  liveTrading: boolean;

  @IsString()
  @MinLength(3, REASON)
  @MaxLength(1000, REASON)
  reason: string;
}

export class LedgerAccountRefDto {
  @IsEnum(LedgerOwnerType)
  ownerType: LedgerOwnerType;

  @IsString()
  @MinLength(1)
  ownerId: string;

  @IsEnum(LedgerAccountKind)
  kind: LedgerAccountKind;
}

export class LedgerEntryDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => LedgerAccountRefDto)
  account: LedgerAccountRefDto;

  /** Signed decimal as a string (never a float). */
  @IsNumberString({ no_symbols: false }, { message: 'Le montant doit être un nombre décimal signé (chaîne).' })
  amount: string;
}

export class LedgerAdjustmentRequestDto {
  @IsString()
  @Length(3, 3, { message: 'La devise doit être un code ISO à 3 lettres.' })
  currency: string;

  @IsArray()
  @ArrayMinSize(2, { message: 'Un ajustement comporte au moins deux écritures.' })
  @ValidateNested({ each: true })
  @Type(() => LedgerEntryDto)
  entries: LedgerEntryDto[];

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  description: string;

  @IsString()
  @MinLength(3, REASON)
  @MaxLength(1000, REASON)
  reason: string;
}

export class LedgerReversalRequestDto {
  @IsString()
  @MinLength(1)
  txnId: string;

  @IsString()
  @MinLength(3, REASON)
  @MaxLength(1000, REASON)
  reason: string;
}

export class ConfigChangeRequestDto {
  /** Any JSON value (number, string, boolean, array, object). */
  @IsDefined({ message: 'Une valeur est requise.' })
  value: unknown;

  @IsString()
  @MinLength(3, REASON)
  @MaxLength(1000, REASON)
  reason: string;
}

export class FeeChangeRequestDto {
  @IsOptional()
  @IsString()
  marketId?: string;

  @IsEnum(FeeType)
  feeType: FeeType;

  @IsBoolean()
  isPercentage: boolean;

  @IsNumberString({}, { message: 'La valeur doit être un nombre décimal (chaîne).' })
  value: string;

  @IsOptional()
  @IsNumberString()
  minAmount?: string;

  @IsOptional()
  @IsNumberString()
  maxAmount?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  label: string;

  @IsString()
  @MinLength(3, REASON)
  @MaxLength(1000, REASON)
  reason: string;
}

export class PaymentForceCompleteRequestDto {
  @IsString()
  @MinLength(3, REASON)
  @MaxLength(1000, REASON)
  reason: string;
}
