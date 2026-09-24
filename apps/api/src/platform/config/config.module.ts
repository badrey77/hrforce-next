import { Global, Module } from '@nestjs/common';
import { loadEnv } from './load-env.js';

/** DI token for the validated {@link Env}. */
export const ENV = Symbol.for('hrforce.env');

@Global()
@Module({
  providers: [{ provide: ENV, useFactory: () => loadEnv(process.env) }],
  exports: [ENV],
})
export class ConfigModule {}
