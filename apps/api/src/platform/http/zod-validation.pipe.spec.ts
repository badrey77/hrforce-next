import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ValidationProblemException } from './problem-details.js';
import { createZodDto, ZodValidationPipe } from './zod-validation.pipe.js';

class CreateThingDto extends createZodDto(
  z.object({ name: z.string().min(1), address: z.object({ city: z.string() }) }),
) {}

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe();

  it('passes through parameters without a zod DTO', () => {
    expect(pipe.transform('abc', { type: 'param', metatype: String, data: 'id' })).toBe('abc');
  });

  it('returns parsed data for valid input', () => {
    const value = { name: 'x', address: { city: 'Rabat' }, extra: true };
    expect(pipe.transform(value, { type: 'body', metatype: CreateThingDto })).toEqual({
      name: 'x',
      address: { city: 'Rabat' },
    });
  });

  it('throws a 422 with field/code/message errors', () => {
    let error: unknown;
    try {
      pipe.transform({ name: '', address: {} }, { type: 'body', metatype: CreateThingDto });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ValidationProblemException);
    const errors = (error as ValidationProblemException).errors;
    expect(errors.map((e) => [e.field, e.code])).toEqual([
      ['name', 'too_small'],
      ['address.city', 'invalid_type'],
    ]);
    expect(errors.every((e) => e.message.length > 0)).toBe(true);
  });

  it('a refine answers the code it names in params.code (else zod\'s `custom`)', () => {
    class TimeDto extends createZodDto(
      z.object({
        at: z.string().refine((v) => /^\d\d:\d\d$/.test(v), { message: 'HH:MM', params: { code: 'invalid_time' } }),
        note: z.string().refine((v) => v.length > 0, { message: 'empty' }),
      }),
    ) {}
    let error: unknown;
    try {
      pipe.transform({ at: '7h', note: '' }, { type: 'body', metatype: TimeDto });
    } catch (e) {
      error = e;
    }
    expect((error as ValidationProblemException).errors.map((e) => [e.field, e.code])).toEqual([
      ['at', 'invalid_time'],
      ['note', 'custom'],
    ]);
  });
});
