import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class OpenComplianceCaseDto {
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title: string;

  @IsOptional()
  @IsUUID()
  subjectUserId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID(undefined, { each: true })
  alertIds?: string[];
}

export class AddComplianceNoteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body: string;
}

export const COMPLIANCE_DECISIONS = ['CLEARED', 'REPORTED', 'REPORTED_TO_ANIF', 'ACCOUNT_BLOCKED', 'CLOSED'] as const;
export type ComplianceDecisionCode = (typeof COMPLIANCE_DECISIONS)[number];

export class ComplianceCaseDecisionDto {
  @IsIn(COMPLIANCE_DECISIONS, { message: 'Décision inconnue.' })
  decision: ComplianceDecisionCode;

  @IsString()
  @MinLength(3, { message: 'Un motif (3 à 1000 caractères) est requis.' })
  @MaxLength(1000)
  reason: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  regulatoryReportRef?: string;
}
