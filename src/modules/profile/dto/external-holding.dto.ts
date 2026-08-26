import { IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';

export class CreateExternalHoldingDto {
  @IsString()
  label: string;

  @IsString()
  assetType: string;

  @IsNumber()
  @IsPositive()
  quantity: number;

  @IsNumber()
  avgCost: number;

  @IsString()
  currency: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
