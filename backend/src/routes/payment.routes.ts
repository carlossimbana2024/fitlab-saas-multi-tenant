import { Router } from 'express';
import { getPaymentReceipt, listPayments, refundPayment, voidPayment } from '../controllers/payment.controller.js';
import { checkPermission } from '../middlewares/checkPermission.js';
import { tenantContext } from '../middlewares/tenantContext.js';
import { verifyJWT } from '../middlewares/verifyJWT.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const paymentRouter = Router();
paymentRouter.use(verifyJWT, tenantContext);
paymentRouter.get('/', checkPermission('finances.view'), asyncHandler(listPayments));
paymentRouter.get('/:id/receipt', checkPermission('finances.view'), asyncHandler(getPaymentReceipt));
paymentRouter.patch('/:id/void', checkPermission('payments.void'), asyncHandler(voidPayment));
paymentRouter.patch('/:id/refund', checkPermission('payments.void'), asyncHandler(refundPayment));
