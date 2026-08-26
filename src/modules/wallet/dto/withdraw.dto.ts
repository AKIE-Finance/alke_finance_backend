import { IsEnum, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';
import { PaymentProvider } from '@prisma/client';

export class WithdrawDto {
  @IsString()
  currency: string;

  @IsNumber()
  @IsPositive()
  amount: number;

  @IsOptional()
  @IsEnum(PaymentProvider)
  provider?: PaymentProvider;
}
