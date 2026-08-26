import { Body, Controller, Get, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { OrderStatus, UserRole } from '@prisma/client';
import { OrdersService } from './orders.service';
import { PlaceOrderDto } from './dto/place-order.dto';
import { ReviewOrderDto } from './dto/review-order.dto';
import { CreateRecurringPlanDto, UpdateRecurringPlanDto } from './dto/recurring-plan.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('orders')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class OrdersController {
  constructor(private orders: OrdersService) {}

  @Post('orders')
  place(@CurrentUser() user: any, @Body() dto: PlaceOrderDto) {
    return this.orders.placeOrder(user.id, dto);
  }

  @Get('orders/me')
  mine(@CurrentUser() user: any) {
    return this.orders.listMine(user.id);
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.COMPLIANCE)
  @Get('orders')
  listAll(@Query('marketId') marketId?: string, @Query('status') status?: OrderStatus) {
    return this.orders.listAll({ marketId, status });
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.COMPLIANCE)
  @Patch('orders/:id/review')
  review(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: ReviewOrderDto) {
    return this.orders.reviewOrder(user.id, id, dto);
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.COMPLIANCE)
  @Get('markets/:marketId/orders/export')
  async exportCsv(@Param('marketId') marketId: string, @Res() res: Response) {
    const csv = await this.orders.exportTransmittedOrders(marketId);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ordres_${marketId}.csv"`);
    res.send(csv);
  }

  @Post('recurring-plans')
  createPlan(@CurrentUser() user: any, @Body() dto: CreateRecurringPlanDto) {
    return this.orders.createRecurringPlan(user.id, dto);
  }

  @Get('recurring-plans')
  listPlans(@CurrentUser() user: any) {
    return this.orders.listRecurringPlans(user.id);
  }

  @Patch('recurring-plans/:id')
  updatePlan(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: UpdateRecurringPlanDto) {
    return this.orders.updateRecurringPlan(user.id, id, dto);
  }
}
