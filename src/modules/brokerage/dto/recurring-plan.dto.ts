import { IsBoolean, IsEnum, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';
import { RecurringFrequency } from '@prisma/client';

export class CreateRecurringPlanDto {
  @IsString()
  instrumentId!: string;

  @IsNumber()
  @IsPositive()
  amount!: number;

  @IsString()
  currency!: string;

  @IsEnum(RecurringFrequency)
  frequency!: RecurringFrequency;
}

export class UpdateRecurringPlanDto {
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
