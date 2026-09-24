import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'kysely';
import { Public } from '../authz/decorators.js';
import { SkipTransaction } from '../context/skip-transaction.decorator.js';
import { KYSELY, type Database } from '../db/database.js';

export interface HealthStatus {
  status: 'ok';
  db: 'ok';
}

@Controller('health')
export class HealthController {
  constructor(@Inject(KYSELY) private readonly db: Database) {}

  @Get()
  @Public()
  @SkipTransaction()
  async check(): Promise<HealthStatus> {
    try {
      await sql`select 1`.execute(this.db);
    } catch {
      throw new ServiceUnavailableException('Database unavailable');
    }
    return { status: 'ok', db: 'ok' };
  }
}
