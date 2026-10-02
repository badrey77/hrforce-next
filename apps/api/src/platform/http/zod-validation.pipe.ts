import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { ValidationProblemException, type FieldError } from './problem-details.js';

const ZOD_SCHEMA = Symbol.for('hrforce.zodSchema');

export interface ZodDtoClass<S extends z.ZodType = z.ZodType> {
  new (): z.output<S>;
  readonly [ZOD_SCHEMA]: S;
}

/**
 * Creates a DTO class backed by a zod schema:
 *   export class CreateOrgUnitDto extends createZodDto(z.object({ code: z.string().min(1) })) {}
 * The global {@link ZodValidationPipe} validates (and replaces) any @Body/@Query/@Param typed with it.
 */
export function createZodDto<S extends z.ZodType>(schema: S): ZodDtoClass<S> {
  // oxlint-disable-next-line typescript/no-extraneous-class -- the class only carries the schema for the pipe
  class ZodDto {
    static readonly [ZOD_SCHEMA] = schema;
  }
  return ZodDto as unknown as ZodDtoClass<S>;
}

function schemaOf(metatype: unknown): z.ZodType | undefined {
  if (typeof metatype !== 'function') return undefined;
  const schema = (metatype as Partial<Record<typeof ZOD_SCHEMA, z.ZodType>>)[ZOD_SCHEMA];
  return schema;
}

/**
 * The contract code of an issue: zod's own code, or — for a `.refine()` — the `params.code` it names
 * (`refine(check, { message, params: { code: 'invalid_time' } })`), so custom rules answer a real code, not `custom`.
 */
function issueCode(issue: z.core.$ZodIssue): string {
  if (issue.code === 'custom') {
    const code: unknown = issue.params?.['code'];
    if (typeof code === 'string') return code;
  }
  return issue.code;
}

export function toFieldErrors(issues: readonly z.core.$ZodIssue[], prefix?: string): FieldError[] {
  return issues.map((issue) => {
    const path = issue.path.map(String);
    if (prefix) path.unshift(prefix);
    return { field: path.join('.'), code: issueCode(issue), message: issue.message };
  });
}

/** Validates parameters whose declared type is a {@link createZodDto} class; leaves others untouched. */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const schema = schemaOf(metadata.metatype);
    if (!schema) return value;
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    // For @Param('id') / @Query('x') the field is the parameter name; for whole-body DTOs it is the property path.
    throw new ValidationProblemException(toFieldErrors(result.error.issues, metadata.data));
  }
}
