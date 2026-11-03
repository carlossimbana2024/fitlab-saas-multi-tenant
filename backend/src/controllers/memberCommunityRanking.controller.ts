import type { Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../errors/AppError.js';
import { communityRankingsSchema, parseAggregate } from '../services/memberAggregates.service.js';
import { signAvatarUrl } from '../services/memberProfile.service.js';
import { dateInTimezone } from '../utils/gymDate.js';
import { fromSupabaseError } from '../utils/supabaseError.js';

const rankingQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
});

function memberOnly(request: Request) {
  if (request.tenant?.role !== 'member') throw new AppError(403, 'MEMBER_ONLY_ENDPOINT', 'Esta sección está disponible solo para miembros.');
}

function monthLabel(month: string) {
  return new Intl.DateTimeFormat('es-EC', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${month}-01T00:00:00Z`));
}

function availablePeriods(currentMonth: string) {
  const [year, month] = currentMonth.split('-').map(Number);
  return Array.from({ length: 24 }, (_, index) => {
    const date = new Date(Date.UTC(year!, month! - 1 - index, 1));
    const key = date.toISOString().slice(0, 7);
    return { key, label: monthLabel(key) };
  });
}

export async function getMemberCommunityRankings(request: Request, response: Response) {
  memberOnly(request);
  const input = rankingQuerySchema.safeParse({ month: typeof request.query.month === 'string' ? request.query.month : undefined });
  if (!input.success) throw new AppError(400, 'INVALID_COMMUNITY_RANKING_MONTH', 'El mes seleccionado no es válido.');

  const today = dateInTimezone(request.tenant!.timezone);
  const currentMonth = today.slice(0, 7);
  const selectedMonth = input.data.month ?? currentMonth;
  if (selectedMonth > currentMonth) throw new AppError(400, 'COMMUNITY_RANKING_FUTURE_MONTH', 'No puedes consultar un ranking futuro.');
  const from = `${selectedMonth}-01`;
  const { data, error } = await supabaseAdmin.rpc('get_member_community_rankings_backend', {
    target_gym_id: request.tenant!.gymId, actor_member_user_id: request.tenant!.gymUserId,
    requested_month: from,
  });
  if (error) throw fromSupabaseError(error);
  const result = parseAggregate(communityRankingsSchema, data);
  const ranked = result.categories;
  const to = result.to;
  const avatarByMember = new Map<string, string | null>();
  const winners = new Map([...ranked.attendance, ...ranked.streak, ...ranked.progress].map(entry => [entry.memberUserId, entry]));
  await Promise.all([...winners.values()].map(async entry => {
    avatarByMember.set(entry.memberUserId, entry.avatarPath ? await signAvatarUrl(entry.avatarPath) : null);
  }));
  const entries = (values: typeof ranked.attendance, unit: 'attendance' | 'streak' | 'progress') => values.map(({ avatarPath: _path, ...entry }) => ({
    ...entry,
    avatarUrl: avatarByMember.get(entry.memberUserId) ?? null,
    displayValue: unit === 'attendance' ? `${entry.value} asistencias` : unit === 'streak' ? `${entry.value} días consecutivos` : `${entry.value}% de avance`,
  }));

  response.json({
    ranking: {
      period: { key: selectedMonth, label: monthLabel(selectedMonth), from, to, isCurrent: selectedMonth === currentMonth },
      availablePeriods: availablePeriods(currentMonth),
      historyMode: 'reconstructed',
      categories: {
        attendance: {
          title: 'Más asistencias del mes',
          explanation: 'Cuenta únicamente asistencias válidas registradas durante el mes.',
          entries: entries(ranked.attendance, 'attendance'),
        },
        streak: {
          title: 'Mayor racha del mes',
          explanation: 'Mayor secuencia de días calendario consecutivos con una asistencia válida dentro del mes.',
          entries: entries(ranked.streak, 'streak'),
        },
        progress: {
          title: 'Mayor progreso hacia su meta',
          explanation: 'Porcentaje de la distancia al peso objetivo cerrada durante el mes. Requiere una medición base y otra posterior; nunca compara kilos absolutos.',
          entries: entries(ranked.progress, 'progress'),
        },
      },
    },
  });
}
