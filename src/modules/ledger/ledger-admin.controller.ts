import { BadRequestException, Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { LedgerOwnerType, UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { toApi } from '../../common/money';
import { LedgerService } from './ledger.service';

@ApiTags('admin/ledger')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/ledger')
export class LedgerAdminController {
  constructor(private readonly ledger: LedgerService) {}

  /** Invariants (zero-sum per txn / per currency, no negative user account) + mirror total per currency. */
  @Roles(UserRole.ADMIN, UserRole.COMPLIANCE)
  @Get('invariants')
  async invariants() {
    const report = await this.ledger.verifyInvariants();
    const currencies = await this.ledger.currencies();
    const mirror: Record<string, string | null> = {};
    for (const c of currencies) mirror[c] = toApi(await this.ledger.mirrorTotal(c));
    return { ...report, mirrorTotals: mirror, checkedAt: new Date() };
  }

  @Roles(UserRole.ADMIN, UserRole.COMPLIANCE)
  @Get('accounts/:ownerType/:ownerId')
  async accounts(
    @Param('ownerType') ownerType: string,
    @Param('ownerId') ownerId: string,
    @Query('currency') currency?: string,
  ) {
    if (!(Object.values(LedgerOwnerType) as string[]).includes(ownerType)) {
      throw new BadRequestException(`Type de propriétaire inconnu : ${ownerType}.`);
    }
    const balances = await this.ledger.ownerBalances(ownerType as LedgerOwnerType, ownerId, currency || undefined);
    return balances.map((b) => ({ ...b, balance: toApi(b.balance) }));
  }
}
