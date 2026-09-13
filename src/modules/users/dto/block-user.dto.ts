import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class BlockUserDto {
  @IsBoolean({ message: 'isBlocked doit être un booléen.' })
  isBlocked!: boolean;

  /** Reason for the block, or the justification of the unblock request. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  blockedReason?: string;
}
