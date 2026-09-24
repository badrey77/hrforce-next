import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.schema.js';
import { createDatabase, KYSELY, type Database } from './database.js';

@Injectable()
export class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(KYSELY) private readonly db: Database) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: KYSELY,
      inject: [ENV],
      useFactory: (env: Env): Database =>
        createDatabase({ connectionString: env.DATABASE_URL, maxConnections: env.DB_POOL_MAX }),
    },
    DatabaseLifecycle,
  ],
  exports: [KYSELY],
})
export class DbModule {}
