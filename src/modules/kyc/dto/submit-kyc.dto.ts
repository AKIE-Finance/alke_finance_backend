import { IsEnum, IsObject, IsOptional, IsString } from 'class-validator';
import { DocumentType } from '@prisma/client';

export class SubmitKycDto {
  @IsEnum(DocumentType)
  documentType: DocumentType;

  @IsString()
  documentFrontUrl: string;

  @IsOptional()
  @IsString()
  documentBackUrl?: string;

  @IsString()
  selfieUrl: string;

  @IsOptional()
  @IsObject()
  questionnaire?: Record<string, unknown>;
}
