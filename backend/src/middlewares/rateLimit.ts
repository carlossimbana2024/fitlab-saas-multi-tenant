import type { Request, RequestHandler } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../errors/AppError.js';
import { hashRateLimitSubject } from '../security/rateLimitKey.js';
import { asyncHandler } from '../utils/asyncHandler.js';

type RateLimitOptions = {
  bucket: string;
  maximumHits: number;
  windowSeconds: number;
  subject: (request: Request) => string;
};

export function databaseRateLimit(options: RateLimitOptions): RequestHandler {
  return asyncHandler(async (request, _response, next) => {
    const subjectHash = hashRateLimitSubject(options.subject(request));
    const { data, error } = await supabaseAdmin.rpc('consume_api_rate_limit', {
      target_bucket: options.bucket,
      target_subject_hash: subjectHash,
      maximum_hits: options.maximumHits,
      window_seconds: options.windowSeconds,
    });
    if (error) throw new AppError(503, 'RATE_LIMIT_CHECK_FAILED', 'No se pudo validar el límite de solicitudes.');
    if (data !== true) throw new AppError(429, 'RATE_LIMIT_EXCEEDED', 'Demasiados intentos. Espera unos minutos y vuelve a intentarlo.');
    next();
  });
}

export function requestNetworkKey(request: Request): string {
  return request.ip || request.socket.remoteAddress || 'unknown-network';
}
