import { Module } from '@nestjs/common';
import { MarketsService } from './markets.service';
import { MarketsController } from './markets.controller';

@Module({
  providers: [MarketsService],
  controllers: [MarketsController],
  exports: [MarketsService],
})
export class MarketsModule {}
