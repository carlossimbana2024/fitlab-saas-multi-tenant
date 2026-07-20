import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError } from '../errors/AppError.js';

export const notFoundHandler: RequestHandler = (_request, _response, next) => {
  next(new AppError(404, 'ROUTE_NOT_FOUND', 'La ruta solicitada no existe.'));
};

export const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  if (error instanceof AppError) {
    response.status(error.statusCode).json({
      error: { code: error.code, message: error.message, details: error.details },
    });
    return;
  }

  console.error(error);
  response.status(500).json({
    error: { code: 'INTERNAL_SERVER_ERROR', message: 'Ocurrió un error inesperado.' },
  });
};
