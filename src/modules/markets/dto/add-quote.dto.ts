import { IsDateString, IsNumber, IsOptional, IsString } from 'class-validator';

export class AddQuoteDto {
  @IsDateString()
  tradeDate: string;

  @IsNumber()
  open: number;

  @IsNumber()
  high: number;

  @IsNumber()
  low: number;

  @IsNumber()
  close: number;

  @IsOptional()
  @IsNumber()
  volume?: number;
}
