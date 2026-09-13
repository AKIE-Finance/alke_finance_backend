import { IsEnum, IsIn, IsNumberString, IsOptional, IsString, Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import { PaymentProvider } from '@prisma/client';

export const SUPPORTED_CURRENCIES = ['XAF', 'XOF', 'USD', 'EUR'] as const;

/** Amounts travel as decimal strings; a JSON number is accepted and stringified. */
const amountTransform = ({ value }: { value: unknown }) =>
  typeof value === 'number' ? value.toString() : typeof value === 'string' ? value.trim() : value;

export class CreateDepositDto {
  @Transform(amountTransform)
  @IsNumberString({ no_symbols: false }, { message: 'Le montant doit être un nombre.' })
  amount: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value))
  @IsIn(SUPPORTED_CURRENCIES, { message: 'Devise non prise en charge.' })
  currency: string;

  @IsEnum(PaymentProvider, { message: 'Fournisseur de paiement inconnu.' })
  provider: PaymentProvider;

  @IsOptional()
  @IsString()
  @Matches(/^\+?[0-9]{8,15}$/, { message: 'Numéro Mobile Money invalide.' })
  msisdn?: string;
}
