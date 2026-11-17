import {
  Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res, UnauthorizedException, UseGuards,
  ForbiddenException, Inject,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsArray, IsIn, IsInt, IsISO8601, IsObject, IsOptional, IsString, IsUUID, Length, Max, Min, ValidateNested,
} from 'class-validator';
import type { Request, Response } from 'express';
import { AppConfig, CONFIG } from './config';
import { ApiKeyGuard } from './common/api-key.guard';
import { BookingsService } from './bookings/bookings.service';
import { CatalogService } from './catalog/catalog.service';
import { PaymentsService } from './payments/payments.service';
import { ProviderName } from './payments/providers';
import { DocType, OperatorsService, REQUIRED_DOCS } from './operators/operators.service';
import { WeatherService } from './weather/weather.service';
import { WhatsAppService } from './whatsapp/whatsapp.service';

// ---------------------------------------------------------------- DTOs

class HoldDto {
  @IsUUID() slotId!: string;
  @IsInt() @Min(1) @Max(20) qty!: number;
  @IsString() @Length(8, 20) phone!: string;
  @IsOptional() @IsString() @Length(1, 80) name?: string;
  @IsOptional() @IsIn(['web', 'app', 'partner']) channel?: 'web' | 'app' | 'partner';
}

class PayDto {
  @IsIn(['khalti', 'esewa', 'mock']) provider!: ProviderName;
}

class VendorDto {
  @IsString() @Length(2, 120) name!: string;
  @IsString() @Length(8, 20) phone!: string;
  @IsOptional() @IsInt() @Min(0) @Max(5000) commissionBps?: number;
}

class ListingDto {
  @IsUUID() vendorId!: string;
  @IsIn(['bungee', 'zipline', 'paragliding', 'rafting', 'ultralight', 'boating', 'flight', 'transfer', 'other'])
  category!: string;
  @IsString() @Length(3, 140) title!: string;
  @IsString() @Length(2, 140) location!: string;
  @IsOptional() @IsString() description?: string;
  @IsInt() @Min(1000) pricePaisa!: number;
  @IsOptional() @IsObject() attributes?: Record<string, unknown>;
}

class SlotItem {
  @IsISO8601() startsAt!: string;
  @IsInt() @Min(1) @Max(500) capacity!: number;
}
class SlotsDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => SlotItem) slots!: SlotItem[];
}

class DocumentDto {
  @IsIn(REQUIRED_DOCS as unknown as string[]) docType!: DocType;
  @IsString() @Length(1, 80) docNumber!: string;
  @IsOptional() @IsISO8601() expiresOn?: string;
}

class VerifyDto {
  @IsString() @Length(2, 80) verifiedBy!: string;
}

class RebookDto {
  @IsUUID() slotId!: string;
}

// ---------------------------------------------------------------- public

@Controller()
export class PublicController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly bookings: BookingsService,
    private readonly payments: PaymentsService,
    private readonly weather: WeatherService,
  ) {}

  @Get('health') health() {
    return { ok: true };
  }

  @Get('listings') listings(@Query('category') category?: string) {
    return this.catalog.list(category);
  }

  @Get('listings/:id') listing(@Param('id', ParseUUIDPipe) id: string) {
    return this.catalog.get(id);
  }

  @Get('listings/:id/slots') slots(@Param('id', ParseUUIDPipe) id: string) {
    return this.catalog.slots(id);
  }

  @Post('holds') hold(@Body() dto: HoldDto) {
    return this.bookings.createHold(dto);
  }

  @Get('bookings/:id') booking(@Param('id', ParseUUIDPipe) id: string) {
    return this.bookings.getBooking(id);
  }

  @Post('bookings/:id/pay') pay(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PayDto) {
    return this.payments.start(id, dto.provider);
  }

  @Get('tickets/:code') ticket(@Param('code') code: string) {
    return this.bookings.getTicket(code);
  }

  @Get('rebook/:id') offer(@Param('id', ParseUUIDPipe) id: string) {
    return this.weather.getOffer(id);
  }

  @Post('rebook/:id/accept') accept(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RebookDto) {
    return this.weather.accept(id, dto.slotId);
  }

  @Post('rebook/:id/refund') refund(@Param('id', ParseUUIDPipe) id: string) {
    return this.weather.decline(id);
  }
}

// ---------------------------------------------------------------- payment returns

@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService, @Inject(CONFIG) private readonly config: AppConfig) {}

  private finish(res: Response, r: { bookingId: string; status: string; ticketCode: string | null }) {
    const url = r.status === 'confirmed'
      ? `${this.config.webUrl}/tickets/${r.ticketCode}`
      : `${this.config.webUrl}/bookings/${r.bookingId}?payment=${r.status}`;
    res.redirect(302, url);
  }

  /** Khalti redirects the customer here with ?pidx=...; we confirm via the lookup API. */
  @Get('khalti/return')
  async khalti(@Query('pidx') pidx: string, @Res() res: Response) {
    this.finish(res, await this.payments.khaltiReturn(pidx));
  }

  /** eSewa redirects here with ?data=<base64 signed JSON>; we check signature and status API. */
  @Get('esewa/return')
  async esewa(@Query('data') data: string, @Res() res: Response) {
    this.finish(res, await this.payments.esewaReturn(data));
  }

  /** Development only: stands in for a real payment page. */
  @Post('mock/:paymentId/complete')
  mock(@Param('paymentId', ParseUUIDPipe) paymentId: string) {
    if (!this.config.enableMockPayments) throw new ForbiddenException();
    return this.payments.mockComplete(paymentId);
  }
}

// ---------------------------------------------------------------- WhatsApp webhook

@Controller('webhooks/whatsapp')
export class WhatsAppController {
  constructor(private readonly wa: WhatsAppService, @Inject(CONFIG) private readonly config: AppConfig) {}

  /** Meta's one-time subscription check. */
  @Get()
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ) {
    if (mode === 'subscribe' && token === this.config.whatsapp.verifyToken) return challenge;
    throw new ForbiddenException();
  }

  @Post()
  @HttpCode(200)
  async receive(@Req() req: Request & { rawBody?: Buffer }, @Headers('x-hub-signature-256') sig: string, @Body() body: any) {
    if (!this.wa.verifySignature(req.rawBody ?? JSON.stringify(body), sig)) throw new UnauthorizedException('bad signature');
    await this.wa.handleWebhook(body);
    return { ok: true };
  }
}

// ---------------------------------------------------------------- admin / operator

@Controller('admin')
@UseGuards(ApiKeyGuard)
export class AdminController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly operators: OperatorsService,
    private readonly bookings: BookingsService,
    private readonly weather: WeatherService,
  ) {}

  @Post('vendors') vendor(@Body() dto: VendorDto) {
    return this.catalog.createVendor(dto);
  }

  @Post('vendors/:id/documents') doc(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DocumentDto) {
    return this.operators.addDocument(id, dto);
  }

  @Post('documents/:id/verify') verify(@Param('id', ParseUUIDPipe) id: string, @Body() dto: VerifyDto) {
    return this.operators.verifyDocument(id, dto.verifiedBy);
  }

  @Get('vendors/:id/badge') badge(@Param('id', ParseUUIDPipe) id: string) {
    return this.operators.badge(id);
  }

  @Post('listings') listing(@Body() dto: ListingDto) {
    return this.catalog.createListing(dto);
  }

  @Post('listings/:id/slots') slots(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SlotsDto) {
    return this.catalog.createSlots(id, dto.slots);
  }

  @Post('vendors/:vendorId/slots/:slotId/weather-cancel')
  cancel(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('slotId', ParseUUIDPipe) slotId: string) {
    return this.weather.cancelSlot(slotId, vendorId);
  }

  @Post('vendors/:vendorId/tickets/:code/redeem')
  redeem(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('code') code: string) {
    return this.bookings.redeem(code, vendorId);
  }
}
