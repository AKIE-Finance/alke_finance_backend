import { IsEnum, IsIn, IsNumberString, IsString, Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import { PaymentProvider } from '@prisma/client';
import { SUPPORTED_CURRENCIES } from './create-deposit.dto';

const amountTransform = ({ value }: { value: unknown }) =>
  typeof value === 'number' ? value.toString() : typeof value === 'string' ? value.trim() : value;

export class RequestWithdrawalDto {
  @Transform(amountTransform)
  @IsNumberString({ no_symbols: false }, { message: 'Le montant doit être un nombre.' })
  amount: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value))
  @IsIn(SUPPORTED_CURRENCIES, { message: 'Devise non prise en charge.' })
  currency: string;

  @IsString()
  @Matches(/^\+?[0-9]{8,15}$/, { message: 'Numéro Mobile Money invalide.' })
  msisdn: string;

  @IsEnum(PaymentProvider, { message: 'Fournisseur de paiement inconnu.' })
  provider: PaymentProvider;
}
