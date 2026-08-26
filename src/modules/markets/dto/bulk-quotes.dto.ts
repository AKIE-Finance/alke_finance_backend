import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsDateString, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';

class BulkQuoteRow {
  @IsString()
  symbol: string;

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

export class BulkQuotesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BulkQuoteRow)
  rows: BulkQuoteRow[];
}
