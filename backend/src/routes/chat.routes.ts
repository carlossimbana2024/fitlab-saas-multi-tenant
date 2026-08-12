import { Router } from 'express';
import { chatWithAssistant } from '../controllers/chat.controller.js';
import { tenantContext } from '../middlewares/tenantContext.js';
import { verifyJWT } from '../middlewares/verifyJWT.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { databaseRateLimit } from '../middlewares/rateLimit.js';

export const chatRouter = Router();
chatRouter.use(verifyJWT, tenantContext);
chatRouter.post('/', databaseRateLimit({
  bucket: 'chat.assistant', maximumHits: 20, windowSeconds: 3600,
  subject: (request) => `${request.tenant!.gymId}:${request.tenant!.gymUserId}`,
}), asyncHandler(chatWithAssistant));
