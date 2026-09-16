import express, { Router } from 'express';
import { createCheckout, getBillingStatus, stripeWebhook } from '../controllers/billing.controller.js';
import { tenantContext } from '../middlewares/tenantContext.js';
import { verifyJWT } from '../middlewares/verifyJWT.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { listOwnRequests,prepareProof,submitProof } from '../controllers/manualBilling.controller.js';
import { databaseRateLimit } from '../middlewares/rateLimit.js';

export const stripeWebhookRouter = Router();
stripeWebhookRouter.post('/', express.raw({ type: 'application/json' }), asyncHandler(stripeWebhook));

export const billingRouter = Router();
billingRouter.use(verifyJWT, tenantContext);
billingRouter.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
billingRouter.get('/status', asyncHandler(getBillingStatus));
billingRouter.use('/manual',databaseRateLimit({bucket:'billing.proofs',maximumHits:40,windowSeconds:600,subject:r=>r.authUser!.id}));
billingRouter.get('/manual',asyncHandler(listOwnRequests));
billingRouter.post('/manual',asyncHandler(prepareProof));
billingRouter.post('/manual/:id/submit',asyncHandler(submitProof));
billingRouter.post('/checkout', asyncHandler(createCheckout));
