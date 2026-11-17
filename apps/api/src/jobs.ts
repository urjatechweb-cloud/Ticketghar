import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { BookingsService } from './bookings/bookings.service';
import { OperatorsService } from './operators/operators.service';
import { WeatherService } from './weather/weather.service';

/**
 * In-process background jobs. Each is safe to run on several instances at
 * once because every job is a guarded, idempotent database update.
 */
@Injectable()
export class Jobs implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('Jobs');
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly bookings: BookingsService,
    private readonly weather: WeatherService,
    private readonly operators: OperatorsService,
  ) {}

  onApplicationBootstrap() {
    if (process.env.DISABLE_JOBS === 'true') return;
    this.every(60_000, 'release expired holds', () => this.bookings.releaseExpiredHolds());
    this.every(60 * 60_000, 'refund unanswered weather offers', () => this.weather.refundUnanswered());
    this.every(24 * 60 * 60_000, 'refresh operator badges', () => this.operators.refreshAll());
  }

  private every(ms: number, name: string, fn: () => Promise<unknown>) {
    const run = () => fn().catch((err) => this.log.error(`${name}: ${err}`));
    this.timers.push(setInterval(run, ms));
  }

  onApplicationShutdown() {
    this.timers.forEach(clearInterval);
  }
}
