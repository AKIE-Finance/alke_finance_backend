import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsOptional, IsString, Length, MaxLength, ValidateNested } from 'class-validator';
import { AddQuoteDto } from './add-quote.dto';

export class BulkQuoteRow extends AddQuoteDto {
  @IsString()
  @Length(1, 20)
  symbol: string;
}

export class BulkQuotesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => BulkQuoteRow)
  rows: BulkQuoteRow[];

  /** Origine du fichier (BOC, SDB…) ; conservée dans le journal d'ingestion. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  notes?: string;
}
