import { Router } from 'express';
import { getPaymentReceipt, listPayments, refundPayment, verifyPaymentReceipt, voidPayment } from '../controllers/payment.controller.js';
import { checkPermission } from '../middlewares/checkPermission.js';
import { databaseRateLimit, requestNetworkKey } from '../middlewares/rateLimit.js';
import { tenantContext } from '../middlewares/tenantContext.js';
import { verifyJWT } from '../middlewares/verifyJWT.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const paymentRouter = Router();
paymentRouter.get('/verify/:token', databaseRateLimit({
  bucket: 'receipt.verify',
  maximumHits: 60,
  windowSeconds: 300,
  subject: (request) => `${requestNetworkKey(request)}:${String(request.params.token ?? '')}`,
}), asyncHandler(verifyPaymentReceipt));
paymentRouter.use(verifyJWT, tenantContext);
paymentRouter.get('/', checkPermission('finances.view'), asyncHandler(listPayments));
paymentRouter.get('/:id/receipt', checkPermission('finances.view'), asyncHandler(getPaymentReceipt));
paymentRouter.patch('/:id/void', checkPermission('payments.void'), asyncHandler(voidPayment));
paymentRouter.patch('/:id/refund', checkPermission('payments.void'), asyncHandler(refundPayment));
