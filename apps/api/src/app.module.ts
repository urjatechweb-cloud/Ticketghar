import { Module } from '@nestjs/common';
import { AppConfig, CONFIG, loadConfig } from './config';
import { DbService } from './db/db.service';
import { LedgerService } from './ledger/ledger.service';
import { BookingsService } from './bookings/bookings.service';
import { CatalogService } from './catalog/catalog.service';
import { PAYMENT_PROVIDERS, PaymentsService, ProviderSet } from './payments/payments.service';
import { EsewaProvider, KhaltiProvider, MockProvider } from './payments/providers';
import { NOTIFIER, WhatsAppClient } from './notify/notifier';
import { OperatorsService } from './operators/operators.service';
import { WeatherService } from './weather/weather.service';
import { WhatsAppService } from './whatsapp/whatsapp.service';
import { ApiKeyGuard } from './common/api-key.guard';
import { AdminController, PaymentsController, PublicController, WhatsAppController } from './controllers';
import { Jobs } from './jobs';

@Module({
  controllers: [PublicController, PaymentsController, WhatsAppController, AdminController],
  providers: [
    { provide: CONFIG, useFactory: () => loadConfig() },
    {
      provide: PAYMENT_PROVIDERS,
      inject: [CONFIG],
      useFactory: (c: AppConfig): ProviderSet => ({
        khalti: new KhaltiProvider(c.khalti),
        esewa: new EsewaProvider(c.esewa),
        mock: new MockProvider(c.webUrl),
      }),
    },
    WhatsAppClient,
    { provide: NOTIFIER, useExisting: WhatsAppClient },
    DbService,
    LedgerService,
    BookingsService,
    CatalogService,
    PaymentsService,
    OperatorsService,
    WeatherService,
    WhatsAppService,
    ApiKeyGuard,
    Jobs,
  ],
})
export class AppModule {}
