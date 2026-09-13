import { Body, Controller, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { BatchState, BatchType, UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequestUser } from '../../common/types/request-user';
import { BatchesService } from './batches.service';
import { SettlementService } from './settlement.service';
import { BuildBatchDto, BuildWdrBatchDto, FileContentDto } from './dto/batch.dto';
import { parseAck, parseCsh, parseExe } from './connectors/csv';
import { IsString, MinLength } from 'class-validator';

export class FailSettlementDto {
  @IsString()
  @MinLength(5)
  reason!: string;
}

@ApiTags('admin/batches')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.COMPLIANCE)
@Controller('admin')
export class BatchesAdminController {
  constructor(private readonly batches: BatchesService, private readonly settlement: SettlementService) {}

  @Post('batches/build')
  build(@CurrentUser() user: RequestUser, @Body() dto: BuildBatchDto) {
    return this.batches.buildBatch(dto.marketId, dto.partnerId, user.id);
  }

  @Post('batches/wdr/build')
  buildWdr(@CurrentUser() user: RequestUser, @Body() dto: BuildWdrBatchDto) {
    return this.batches.buildWdrBatch(dto.partnerId, user.id);
  }

  @Get('batches')
  list(@Query('marketId') marketId?: string, @Query('state') state?: BatchState, @Query('type') type?: BatchType) {
    return this.batches.list({ marketId, state, type });
  }

  @Get('batches/:id')
  get(@Param('id') id: string) {
    return this.batches.getBatchDetail(id);
  }

  @Get('batches/:id/file')
  async file(@Param('id') id: string, @Res() res: Response) {
    const file = await this.batches.batchFile(id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.setHeader('X-File-Sha256', file.hash);
    res.send(file.content);
  }

  @Post('batches/:id/sent')
  sent(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.batches.markSent(id, user.id);
  }

  @Post('batches/:id/ack')
  ack(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: FileContentDto) {
    return this.batches.processAck(id, parseAck(dto.content), user.id);
  }

  @Post('batches/:id/exe')
  exe(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: FileContentDto) {
    return this.batches.processExecutions(id, parseExe(dto.content), user.id);
  }

  @Post('partners/:partnerId/csh')
  csh(@CurrentUser() user: RequestUser, @Param('partnerId') partnerId: string, @Body() dto: FileContentDto) {
    return this.batches.processStatement(partnerId, parseCsh(dto.content), user.id);
  }

  @Post('settlement/run')
  settle(@CurrentUser() user: RequestUser) {
    return this.settlement.settleDue(new Date(), user.id);
  }

  @Post('executions/:id/fail-settlement')
  failSettlement(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: FailSettlementDto) {
    return this.settlement.failSettlement(id, dto.reason, user.id);
  }
}
