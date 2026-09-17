import { Router } from 'express';
import { evaluateStreaks, evaluateLoyaltyCron } from '../controllers/cron.controller.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const cronRouter = Router();
cronRouter.get('/streak-evaluation', asyncHandler(evaluateStreaks));
cronRouter.get('/loyalty-evaluation', asyncHandler(evaluateLoyaltyCron));
