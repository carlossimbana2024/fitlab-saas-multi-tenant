import { Router } from 'express';
import { listPayments, voidPayment } from '../controllers/payment.controller.js';
import { checkPermission } from '../middlewares/checkPermission.js';
import { tenantContext } from '../middlewares/tenantContext.js';
import { verifyJWT } from '../middlewares/verifyJWT.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const paymentRouter = Router();
paymentRouter.use(verifyJWT, tenantContext);
paymentRouter.get('/', asyncHandler(listPayments));
paymentRouter.patch('/:id/void', checkPermission('payments.void'), asyncHandler(voidPayment));
