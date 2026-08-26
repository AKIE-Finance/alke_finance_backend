import { IsNumber, IsPositive, IsString } from 'class-validator';

export class ConvertFxDto {
  @IsString()
  fromCurrency: string;

  @IsString()
  toCurrency: string;

  @IsNumber()
  @IsPositive()
  amount: number;
}
