import { Router } from 'express';
import { chatWithAssistant } from '../controllers/chat.controller.js';
import { tenantContext } from '../middlewares/tenantContext.js';
import { verifyJWT } from '../middlewares/verifyJWT.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const chatRouter = Router();
chatRouter.use(verifyJWT, tenantContext);
chatRouter.post('/', asyncHandler(chatWithAssistant));
