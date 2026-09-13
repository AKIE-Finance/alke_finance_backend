import { IsIn, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

export class KycDecisionDto {
  @IsIn(['VALIDATED', 'REJECTED'], { message: 'La décision doit être VALIDATED ou REJECTED.' })
  decision: 'VALIDATED' | 'REJECTED';

  @ValidateIf((o: KycDecisionDto) => o.decision === 'REJECTED')
  @IsString({ message: 'Un motif est requis pour un refus.' })
  @MaxLength(1000)
  @IsOptional()
  reason?: string;
}
