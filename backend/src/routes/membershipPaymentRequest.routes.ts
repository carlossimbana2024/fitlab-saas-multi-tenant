import { Router } from 'express';
import { cancelMembershipPayment, getMembershipPaymentProof, getMembershipPaymentSettings, getMyMembershipPayments, listMembershipPaymentRequests, prepareMembershipPayment, reviewMembershipPayment, saveMembershipPaymentSettings, submitMembershipPayment } from '../controllers/membershipPaymentRequest.controller.js';
import { checkPermission } from '../middlewares/checkPermission.js';
import { databaseRateLimit } from '../middlewares/rateLimit.js';
import { tenantContext } from '../middlewares/tenantContext.js';
import { verifyJWT } from '../middlewares/verifyJWT.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../errors/AppError.js';

export const membershipPaymentRequestRouter = Router();
membershipPaymentRequestRouter.use(verifyJWT, tenantContext);
const writes = databaseRateLimit({ bucket: 'membership_payment_requests', maximumHits: 40, windowSeconds: 600, subject: (r) => `${r.tenant!.gymId}:${r.tenant!.gymUserId}` });
membershipPaymentRequestRouter.get('/me', asyncHandler(getMyMembershipPayments));
membershipPaymentRequestRouter.post('/me/prepare', writes, asyncHandler(prepareMembershipPayment));
membershipPaymentRequestRouter.post('/me/:id/submit', writes, asyncHandler(submitMembershipPayment));
membershipPaymentRequestRouter.post('/me/:id/cancel', writes, asyncHandler(cancelMembershipPayment));
membershipPaymentRequestRouter.get('/me/:id/proof', asyncHandler((r, s) => {
  if (r.tenant!.role !== 'member') throw new AppError(403, 'MEMBER_REQUIRED', 'Esta opción pertenece al portal del miembro.');
  return getMembershipPaymentProof(r, s);
}));
membershipPaymentRequestRouter.get('/settings', asyncHandler(getMembershipPaymentSettings));
membershipPaymentRequestRouter.put('/settings/:locationId', writes, asyncHandler(saveMembershipPaymentSettings));
membershipPaymentRequestRouter.get('/', checkPermission('payments.register'), asyncHandler(listMembershipPaymentRequests));
membershipPaymentRequestRouter.get('/:id/proof', checkPermission('payments.register'), asyncHandler(getMembershipPaymentProof));
membershipPaymentRequestRouter.post('/:id/review', writes, checkPermission('payments.register'), asyncHandler(reviewMembershipPayment));
