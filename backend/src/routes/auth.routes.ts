import { Router } from 'express';
import { acceptInvite, changePassword, completeOwnerOnboarding, login, logout, me, refresh, registerOwner, requestPasswordReset, resetPassword } from '../controllers/auth.controller.js';
import { verifyJWT } from '../middlewares/verifyJWT.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const authRouter = Router();
authRouter.post('/login', asyncHandler(login));
authRouter.post('/register-owner', asyncHandler(registerOwner));
authRouter.post('/complete-owner-onboarding', asyncHandler(completeOwnerOnboarding));
authRouter.post('/refresh', asyncHandler(refresh));
authRouter.post('/accept-invite', asyncHandler(acceptInvite));
authRouter.post('/request-password-reset', asyncHandler(requestPasswordReset));
authRouter.post('/reset-password', asyncHandler(resetPassword));
authRouter.get('/me', verifyJWT, asyncHandler(me));
authRouter.put('/change-password', verifyJWT, asyncHandler(changePassword));
authRouter.post('/logout', asyncHandler(logout));
