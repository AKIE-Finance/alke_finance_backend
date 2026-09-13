import { Body, Controller, Get, Header, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AlertSeverity, AlertStatus, ComplianceCaseState, UserRole } from '@prisma/client';
import { ComplianceService } from './compliance.service';
import { AddComplianceNoteDto, ComplianceCaseDecisionDto, OpenComplianceCaseDto } from './dto/compliance.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequestUser } from '../../common/types/request-user';

function asEnum<T extends string>(values: readonly T[], v?: string): T | undefined {
  return v && (values as readonly string[]).includes(v) ? (v as T) : undefined;
}

@ApiTags('admin / conformité')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.COMPLIANCE)
@Controller('admin/compliance')
export class ComplianceController {
  constructor(private readonly compliance: ComplianceService) {}

  @Get('alerts')
  alerts(@Query('status') status?: string, @Query('severity') severity?: string) {
    return this.compliance.listAlerts({
      status: asEnum(Object.values(AlertStatus), status),
      severity: asEnum(Object.values(AlertSeverity), severity),
    });
  }

  @Post('cases')
  openCase(@CurrentUser() user: RequestUser, @Body() dto: OpenComplianceCaseDto) {
    return this.compliance.openCase(user.id, dto);
  }

  @Get('cases')
  cases(@Query('state') state?: string) {
    return this.compliance.listCases(asEnum(Object.values(ComplianceCaseState), state));
  }

  @Get('cases/:id')
  caseDetail(@Param('id') id: string) {
    return this.compliance.getCase(id);
  }

  @Post('cases/:id/notes')
  addNote(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: AddComplianceNoteDto) {
    return this.compliance.addNote(id, user.id, dto.body);
  }

  @Post('cases/:id/decision')
  decide(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: ComplianceCaseDecisionDto) {
    return this.compliance.requestDecision(user.id, id, dto.decision, dto.reason, dto.regulatoryReportRef);
  }

  @Get('export.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="compliance-export.csv"')
  exportCsv(@Query('month') month?: string) {
    return this.compliance.exportCsv(month);
  }
}
