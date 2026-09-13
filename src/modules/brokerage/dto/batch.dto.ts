import { IsString, MinLength } from 'class-validator';

export class BuildBatchDto {
  @IsString()
  marketId!: string;

  @IsString()
  partnerId!: string;
}

export class BuildWdrBatchDto {
  @IsString()
  partnerId!: string;
}

/** Raw CSV text of an ACK / EXE / CSH file uploaded by the back-office. */
export class FileContentDto {
  @IsString()
  @MinLength(1)
  content!: string;
}
