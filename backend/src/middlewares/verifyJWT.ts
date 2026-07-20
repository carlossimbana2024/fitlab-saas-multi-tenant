import type { RequestHandler } from 'express';
import { supabasePublic, createUserSupabaseClient } from '../config/supabase.js';
import { AppError } from '../errors/AppError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const verifyJWT: RequestHandler = asyncHandler(async (request, _response, next) => {
  const bearer = request.headers.authorization?.startsWith('Bearer ')
    ? request.headers.authorization.slice(7)
    : undefined;
  const accessToken = request.signedCookies?.fitlab_access_token ?? bearer;

  if (!accessToken) {
    throw new AppError(401, 'AUTH_REQUIRED', 'Debes iniciar sesión.');
  }

  const { data, error } = await supabasePublic.auth.getUser(accessToken);
  if (error || !data.user) {
    throw new AppError(401, 'INVALID_SESSION', 'La sesión no es válida o expiró.');
  }

  request.accessToken = accessToken;
  request.authUser = data.user;
  request.supabase = createUserSupabaseClient(accessToken);
  next();
});
