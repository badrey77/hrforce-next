import { SetMetadata } from '@nestjs/common';

export const SKIP_TRANSACTION_KEY = 'hrforce:skipTransaction';

/** The route runs without a request transaction (e.g. health). `currentTx()` will throw inside it. */
export const SkipTransaction = (): MethodDecorator & ClassDecorator => SetMetadata(SKIP_TRANSACTION_KEY, true);
