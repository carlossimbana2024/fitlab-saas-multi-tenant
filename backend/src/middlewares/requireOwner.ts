import type { RequestHandler } from 'express';
import { AppError } from '../errors/AppError.js';

export const requireOwner: RequestHandler = (request, _response, next) => {
  if (request.tenant?.role !== 'owner') {
    throw new AppError(403, 'OWNER_REQUIRED', 'Solo el owner puede administrar el personal.');
  }
  next();
};
