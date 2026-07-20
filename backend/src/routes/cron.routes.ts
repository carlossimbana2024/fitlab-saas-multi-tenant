import { Router } from 'express';
import { evaluateStreaks } from '../controllers/cron.controller.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const cronRouter = Router();
cronRouter.get('/streak-evaluation', asyncHandler(evaluateStreaks));
