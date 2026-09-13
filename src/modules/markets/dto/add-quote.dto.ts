import { IsDateString, IsInt, IsNumber, IsOptional, IsPositive, Min } from 'class-validator';

export class AddQuoteDto {
  /** Jour de bourse (ISO 8601) ; l'heure éventuelle est ignorée. */
  @IsDateString()
  tradeDate: string;

  @IsNumber()
  @IsPositive()
  open: number;

  @IsNumber()
  @IsPositive()
  high: number;

  @IsNumber()
  @IsPositive()
  low: number;

  @IsNumber()
  @IsPositive()
  close: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  volume?: number;
}
