import express, { Router } from 'express';
import { createCheckout, getBillingStatus, stripeWebhook } from '../controllers/billing.controller.js';
import { tenantContext } from '../middlewares/tenantContext.js';
import { verifyJWT } from '../middlewares/verifyJWT.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const stripeWebhookRouter = Router();
stripeWebhookRouter.post('/', express.raw({ type: 'application/json' }), asyncHandler(stripeWebhook));

export const billingRouter = Router();
billingRouter.use(verifyJWT, tenantContext);
billingRouter.get('/status', asyncHandler(getBillingStatus));
billingRouter.post('/checkout', asyncHandler(createCheckout));
