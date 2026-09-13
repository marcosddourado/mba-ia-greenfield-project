import { QueryFailedError } from 'typeorm';

/** PostgreSQL SQLSTATE for a unique-constraint violation. */
export const PG_UNIQUE_VIOLATION = '23505';

/**
 * Narrows an unknown error to a PostgreSQL unique-constraint violation on a
 * specific column. pg surfaces the SQLSTATE `code` and `detail` on the driver
 * error, which TypeORM copies onto `QueryFailedError` but does not type — so we
 * read them through a typed cast (not `any`) to keep the access type-safe.
 */
export function isPgUniqueViolationOnColumn(
  err: unknown,
  column: string,
): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const { code, detail } = err as QueryFailedError & {
    code?: string;
    detail?: string;
  };
  return (
    code === PG_UNIQUE_VIOLATION &&
    typeof detail === 'string' &&
    detail.includes(column)
  );
}
