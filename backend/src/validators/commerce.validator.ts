import { z } from 'zod';

const uuid = z.string().uuid();
const paymentMethod = z.enum(['cash', 'bank_transfer', 'external_card', 'external_deuna', 'other']);

export const productSchema = z.object({
  name: z.string().trim().min(2).max(150),
  sku: z.string().trim().min(1).max(80),
  description: z.string().trim().max(1000).nullish(),
  salePrice: z.coerce.number().min(0).max(9999999999),
  currency: z.string().trim().regex(/^[A-Z]{3}$/),
  minimumStock: z.coerce.number().int().min(0).max(1000000000),
  isActive: z.boolean().optional().default(true),
});

export const inventoryAdjustmentSchema = z.object({
  locationId: uuid,
  productId: uuid,
  movementType: z.enum(['purchase', 'return', 'adjustment', 'loss']),
  quantityDelta: z.coerce.number().int().min(-1000000000).max(1000000000).refine((value) => value !== 0),
  reason: z.string().trim().min(3).max(500),
});

export const productSaleSchema = z.object({
  locationId: uuid,
  memberUserId: uuid.nullish(),
  items: z.array(z.object({ productId: uuid, quantity: z.coerce.number().int().min(1).max(10000) })).min(1).max(100),
  discount: z.coerce.number().min(0).max(9999999999).default(0),
  paymentMethod,
  externalReference: z.string().trim().max(200).nullish(),
  notes: z.string().trim().max(1000).nullish(),
});

export const saleReversalSchema = z.object({ reason: z.string().trim().min(3).max(500) });

export const inventoryListSchema = z.object({
  locationId: uuid.optional(),
  includeInactive: z.union([z.literal('true'), z.literal('false')]).transform((value) => value === 'true').optional().default('false'),
});

export const salesListSchema = z.object({
  status: z.enum(['draft', 'completed', 'voided', 'refunded']).optional(),
  locationId: uuid.optional(),
});
