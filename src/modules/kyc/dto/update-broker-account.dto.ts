import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateBrokerAccountDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  externalAccountNo?: string;

  @IsOptional()
  @IsIn(['OPEN', 'SUSPENDED'], { message: 'L’état doit être OPEN ou SUSPENDED.' })
  state?: 'OPEN' | 'SUSPENDED';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
