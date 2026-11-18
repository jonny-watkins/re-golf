export type Result<T> = { data: T; error: { code?: string; message?: string } | null };

/** Unwraps a database result that is expected to succeed; a failure becomes a logged 500. */
export function must<T>(result: { data: T; error: unknown }, what: string): T {
  if (result.error) {
    const code = (result.error as { code?: string }).code;
    throw new Error(`${what} failed${code ? ` (${code})` : ''}`);
  }
  return result.data;
}

/** True when a database function, table or column from a not-yet-applied migration is missing. */
export const missing = (error: { code?: string } | null) =>
  Boolean(error && ['PGRST202', 'PGRST204', 'PGRST205', '42883', '42P01', '42703'].includes(error.code || ''));
