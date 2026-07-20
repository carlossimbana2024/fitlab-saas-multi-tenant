import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../errors/AppError.js';
import { dateInTimezone } from '../utils/gymDate.js';

export async function evaluateStreaks(request: Request, response: Response) {
  if (!env.CRON_SECRET || request.get('authorization') !== `Bearer ${env.CRON_SECRET}`) {
    throw new AppError(401, 'INVALID_CRON_SECRET', 'Ejecución no autorizada.');
  }

  const yesterday = new Date(Date.now() - 86_400_000);
  const evaluationDate = dateInTimezone('America/Guayaquil', yesterday);
  const { error } = await supabaseAdmin.rpc('run_streak_evaluation', { evaluation_date: evaluationDate });
  if (error) throw new AppError(500, 'STREAK_EVALUATION_FAILED', error.message);

  response.json({ status: 'evaluated', evaluationDate, timestamp: new Date().toISOString() });
}
