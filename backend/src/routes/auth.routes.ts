import { Router } from 'express';
import { acceptInvite, changePassword, completeOwnerOnboarding, login, logout, me, refresh, registerOwner, requestPasswordReset, resetPassword } from '../controllers/auth.controller.js';
import { verifyJWT } from '../middlewares/verifyJWT.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { databaseRateLimit, requestNetworkKey } from '../middlewares/rateLimit.js';
import { normalizedEmail } from '../security/rateLimitKey.js';

export const authRouter = Router();
authRouter.post('/login', databaseRateLimit({
  bucket: 'auth.login', maximumHits: 8, windowSeconds: 900,
  subject: (request) => `${requestNetworkKey(request)}:${normalizedEmail(request.body?.email)}`,
}), asyncHandler(login));
authRouter.post('/register-owner', databaseRateLimit({
  bucket: 'auth.register_owner', maximumHits: 5, windowSeconds: 3600,
  subject: (request) => `${requestNetworkKey(request)}:${normalizedEmail(request.body?.email)}`,
}), asyncHandler(registerOwner));
authRouter.post('/complete-owner-onboarding', asyncHandler(completeOwnerOnboarding));
authRouter.post('/refresh', asyncHandler(refresh));
authRouter.post('/accept-invite', databaseRateLimit({
  bucket: 'auth.accept_invite', maximumHits: 10, windowSeconds: 900,
  subject: requestNetworkKey,
}), asyncHandler(acceptInvite));
authRouter.post('/request-password-reset', databaseRateLimit({
  bucket: 'auth.password_reset_request', maximumHits: 5, windowSeconds: 3600,
  subject: (request) => `${requestNetworkKey(request)}:${normalizedEmail(request.body?.email)}`,
}), asyncHandler(requestPasswordReset));
authRouter.post('/reset-password', databaseRateLimit({
  bucket: 'auth.password_reset', maximumHits: 10, windowSeconds: 900,
  subject: requestNetworkKey,
}), asyncHandler(resetPassword));
authRouter.get('/me', verifyJWT, asyncHandler(me));
authRouter.put('/change-password', verifyJWT, asyncHandler(changePassword));
authRouter.post('/logout', asyncHandler(logout));
