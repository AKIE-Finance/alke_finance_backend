import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class ApproveDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class RejectDto {
  @IsString()
  @MinLength(3, { message: 'Un motif de refus est requis.' })
  @MaxLength(1000)
  note: string;
}
