import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../errors/AppError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const healthRouter = Router();
healthRouter.get('/', (_request, response) => {
  response.json({ status: 'ok', service: 'fitlab-api', timestamp: new Date().toISOString() });
});
healthRouter.get('/ready', asyncHandler(async (_request, response) => {
  const { error } = await supabaseAdmin.from('gyms').select('id', { head: true, count: 'exact' });
  if (error) throw new AppError(503, 'DATABASE_NOT_READY', 'No se pudo conectar con Supabase.');
  response.json({ status: 'ready', database: 'supabase' });
}));
