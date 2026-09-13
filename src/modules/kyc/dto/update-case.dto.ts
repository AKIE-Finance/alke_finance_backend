import { IsEnum, IsObject, IsOptional, IsString, Length, Matches } from 'class-validator';
import { DocumentType } from '@prisma/client';

export class UpdateKycCaseDto {
  @IsOptional()
  @IsEnum(DocumentType)
  documentType?: DocumentType;

  /** ISO 3166-1 alpha-2 (CM, GA, CG, GQ…). */
  @IsOptional()
  @IsString()
  @Length(2, 2, { message: 'Le pays du document doit être un code ISO à 2 lettres.' })
  @Matches(/^[A-Za-z]{2}$/)
  documentCountry?: string;

  @IsOptional()
  @IsObject()
  questionnaire?: Record<string, unknown>;
}
