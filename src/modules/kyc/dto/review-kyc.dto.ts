import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/** Legacy console contract (POST /kyc/submissions/:id/review): VERIFIED maps to VALIDATED. */
export class ReviewKycDto {
  @IsIn(['VERIFIED', 'VALIDATED', 'REJECTED'], { message: 'Le statut de revue doit être VERIFIED/VALIDATED ou REJECTED.' })
  status: 'VERIFIED' | 'VALIDATED' | 'REJECTED';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  rejectionReason?: string;
}
