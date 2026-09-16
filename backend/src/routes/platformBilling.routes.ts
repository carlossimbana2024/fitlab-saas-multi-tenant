import { Router } from 'express';
import { verifyJWT } from '../middlewares/verifyJWT.js';
import { databaseRateLimit } from '../middlewares/rateLimit.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { platformAccess,setupMfa,verifyMfa,listPlatformRequests,downloadProof,reviewProof,suspendSubscription } from '../controllers/manualBilling.controller.js';

export const platformBillingRouter=Router();
platformBillingRouter.use(verifyJWT);
platformBillingRouter.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
platformBillingRouter.use(databaseRateLimit({bucket:'platform.billing',maximumHits:120,windowSeconds:300,subject:r=>r.authUser!.id}));
platformBillingRouter.get('/access',asyncHandler(platformAccess));
platformBillingRouter.post('/mfa/setup',asyncHandler(setupMfa));
platformBillingRouter.post('/mfa/verify',databaseRateLimit({bucket:'platform.mfa',maximumHits:8,windowSeconds:900,subject:r=>r.authUser!.id}),asyncHandler(verifyMfa));
platformBillingRouter.get('/requests',asyncHandler(listPlatformRequests));
platformBillingRouter.post('/requests/:id/proof',asyncHandler(downloadProof));
platformBillingRouter.post('/requests/:id/review',asyncHandler(reviewProof));
platformBillingRouter.post('/subscriptions/:id/suspend',asyncHandler(suspendSubscription));
