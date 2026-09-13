import { IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { ReconciliationState } from '@prisma/client';

export class UpdateReconciliationDto {
  /** INVESTIGATING or RESOLVED — WRITTEN_OFF goes through the maker-checker. */
  @IsEnum(ReconciliationState)
  state!: ReconciliationState;

  @IsString()
  @MinLength(3)
  reason!: string;

  @IsOptional()
  @IsString()
  matchedTxnId?: string;
}

export class WriteOffDto {
  @IsString()
  @MinLength(5)
  reason!: string;
}
