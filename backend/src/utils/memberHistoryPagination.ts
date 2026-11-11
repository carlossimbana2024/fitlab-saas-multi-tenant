import { z } from 'zod';
import { AppError } from '../errors/AppError.js';

export const MEMBER_HISTORY_PAGE_SIZE = 25;
// Keep the database's full fractional precision for the keyset boundary.
export const historyTimestamp = z.string().datetime({ offset: true })
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/);
const cursorSchema = z.object({ at: historyTimestamp, id: z.string().uuid() }).strict();

export function parseHistoryInput<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError(400, 'INVALID_HISTORY_FILTERS', 'Los filtros del historial no son válidos.');
  return parsed.data;
}

export function historyCursorFilter(raw: string, column: 'starts_at' | 'paid_at' | 'created_at', ascending = false) {
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { /* invalid cursor */ }
  const { at, id } = parseHistoryInput(cursorSchema, decoded);
  const op = ascending ? 'gt' : 'lt';
  return `${column}.${op}.${at},and(${column}.eq.${at},id.${op}.${id})`;
}

export const historyCursorParam = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/).optional();

export function historyPage<T extends { id: string }>(rows: T[], timestamp: (row: T) => string, size = MEMBER_HISTORY_PAGE_SIZE) {
  const items = rows.slice(0, size);
  const last = items.at(-1);
  const nextCursor = rows.length > size && last
    ? Buffer.from(JSON.stringify({ at: timestamp(last), id: last.id })).toString('base64url')
    : null;
  return { items, nextCursor };
}
