import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class SubmitNpsDto {
  @IsInt()
  @Min(0)
  @Max(10)
  score: number;

  @IsOptional()
  @IsString()
  comment?: string;
}
