import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AssetClass, PartnerAgreementStatus, UserRole } from '@prisma/client';
import { MarketsService } from './markets.service';
import { UpdateMarketDto } from './dto/update-market.dto';
import { CreatePartnerDto } from './dto/create-partner.dto';
import { UpdatePartnerDto } from './dto/update-partner.dto';
import { CreateInstrumentDto } from './dto/create-instrument.dto';
import { UpdateInstrumentDto } from './dto/update-instrument.dto';
import { AddQuoteDto } from './dto/add-quote.dto';
import { BulkQuotesDto } from './dto/bulk-quotes.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('markets')
@Controller()
export class MarketsController {
  constructor(private markets: MarketsService) {}

  // ---- Markets (catalogue public + admin) ---------------------------------
  @Get('markets')
  listMarkets() {
    return this.markets.listMarkets();
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Patch('markets/:id')
  updateMarket(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: UpdateMarketDto) {
    return this.markets.updateMarket(id, user.id, dto);
  }

  // ---- Partenaires boursiers (SDB/SGI) — pipeline back-office -------------
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.COMPLIANCE)
  @Get('partners')
  listPartners(@Query('marketId') marketId?: string, @Query('agreementStatus') status?: PartnerAgreementStatus) {
    return this.markets.listPartners(marketId, status);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Post('partners')
  createPartner(@CurrentUser() user: any, @Body() dto: CreatePartnerDto) {
    return this.markets.createPartner(user.id, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Patch('partners/:id')
  updatePartner(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: UpdatePartnerDto) {
    return this.markets.updatePartner(id, user.id, dto);
  }

  // ---- Catalogue (instruments) ---------------------------------------------
  @Get('instruments')
  listInstruments(
    @Query('marketId') marketId?: string,
    @Query('assetClass') assetClass?: AssetClass,
    @Query('search') search?: string,
  ) {
    return this.markets.listInstruments({ marketId, assetClass, search });
  }

  @Get('instruments/:id')
  getInstrument(@Param('id') id: string) {
    return this.markets.getInstrument(id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Post('instruments')
  createInstrument(@Body() dto: CreateInstrumentDto) {
    return this.markets.createInstrument(dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Patch('instruments/:id')
  updateInstrument(@Param('id') id: string, @Body() dto: UpdateInstrumentDto) {
    return this.markets.updateInstrument(id, dto);
  }

  // ---- Cotations (traitement du Bulletin Officiel de Cotation) ------------
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Post('instruments/:id/quotes')
  addQuote(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: AddQuoteDto) {
    return this.markets.addQuote(id, user.id, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Post('markets/:marketId/quotes/bulk')
  bulkQuotes(@CurrentUser() user: any, @Param('marketId') marketId: string, @Body() dto: BulkQuotesDto) {
    return this.markets.bulkQuotes(marketId, user.id, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get('market-data/ingestion-log')
  ingestionHistory(@Query('marketId') marketId?: string) {
    return this.markets.ingestionHistory(marketId);
  }

  // ---- Watchlist utilisateur -------------------------------------------
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('watchlist')
  watchlist(@CurrentUser() user: any) {
    return this.markets.watchlist(user.id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('watchlist/:instrumentId')
  toggleWatch(@CurrentUser() user: any, @Param('instrumentId') instrumentId: string) {
    return this.markets.toggleWatch(user.id, instrumentId);
  }
}
