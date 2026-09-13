import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { OrderStatus, UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequestUser } from '../../common/types/request-user';
import { OrdersService } from './orders.service';
import { PlaceOrderDto } from './dto/place-order.dto';
import { ReviewOrderDto } from './dto/review-order.dto';
import { CreateRecurringPlanDto, UpdateRecurringPlanDto } from './dto/recurring-plan.dto';

const STAFF: readonly UserRole[] = [UserRole.ADMIN, UserRole.COMPLIANCE];

@ApiTags('orders')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post('orders/preview')
  preview(@CurrentUser() user: RequestUser, @Body() dto: PlaceOrderDto) {
    return this.orders.preview(user.id, dto);
  }

  @Post('orders')
  place(@CurrentUser() user: RequestUser, @Body() dto: PlaceOrderDto) {
    return this.orders.placeOrder(user.id, dto);
  }

  @Get('orders/me')
  mine(@CurrentUser() user: RequestUser, @Query('limit') limit?: string) {
    return this.orders.listMine(user.id, limit ? Number(limit) : undefined);
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.COMPLIANCE)
  @Get('orders')
  listAll(
    @Query('marketId') marketId?: string,
    @Query('status') status?: OrderStatus,
    @Query('batchId') batchId?: string,
    @Query('userId') userId?: string,
  ) {
    return this.orders.listAll({ marketId, status, batchId, userId });
  }

  @Get('orders/:id')
  get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.orders.getForUser(user.id, id, STAFF.includes(user.role));
  }

  @Delete('orders/:id')
  cancel(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.orders.cancel(user.id, id);
  }

  /** Maker step of a back-office correction; the checker approves via /admin/approvals. */
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.COMPLIANCE)
  @Patch('orders/:id/review')
  review(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: ReviewOrderDto) {
    return this.orders.requestReview(user.id, id, dto);
  }

  // ---------------------------------------------------------- recurring plans

  @Post('recurring-plans')
  createPlan(@CurrentUser() user: RequestUser, @Body() dto: CreateRecurringPlanDto) {
    return this.orders.createRecurringPlan(user.id, dto);
  }

  @Get('recurring-plans')
  listPlans(@CurrentUser() user: RequestUser) {
    return this.orders.listRecurringPlans(user.id);
  }

  @Patch('recurring-plans/:id')
  updatePlan(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: UpdateRecurringPlanDto) {
    return this.orders.updateRecurringPlan(user.id, id, dto);
  }
}
