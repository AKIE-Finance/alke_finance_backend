import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { TicketAuthorType, TicketStatus, UserRole } from '@prisma/client';
import { SupportService } from './support.service';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { AddMessageDto } from './dto/add-message.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequestUser } from '../../common/types/request-user';

@ApiTags('support')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class SupportController {
  constructor(private support: SupportService) {}

  @Post('support/tickets')
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateTicketDto) {
    return this.support.createTicket(user.id, dto);
  }

  @Get('support/tickets/me')
  mine(@CurrentUser() user: RequestUser) {
    return this.support.listMine(user.id);
  }

  @Post('support/tickets/:id/messages')
  addMessage(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: AddMessageDto) {
    return this.support.addMessage(user.id, id, TicketAuthorType.USER, dto);
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPPORT)
  @Get('admin/support/tickets')
  listAll(@Query('status') status?: TicketStatus) {
    return this.support.listAll(status);
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPPORT)
  @Post('admin/support/tickets/:id/messages')
  addAgentMessage(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: AddMessageDto) {
    return this.support.addMessage(user.id, id, TicketAuthorType.AGENT, dto);
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPPORT)
  @Patch('admin/support/tickets/:id')
  update(@Param('id') id: string, @Body() dto: UpdateTicketDto) {
    return this.support.updateTicket(id, dto);
  }
}
