import type { Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../errors/AppError.js';
import { fromSupabaseError } from '../utils/supabaseError.js';
import { inventoryAdjustmentSchema, inventoryListSchema, productSaleSchema, productSchema, saleReversalSchema, salesListSchema } from '../validators/commerce.validator.js';

const uuid = z.string().uuid();

function relatedOne<T>(value: T | T[] | null | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : value ?? undefined;
}

function userName(user: { managed_full_name?: string | null; profiles?: { full_name?: string | null } | Array<{ full_name?: string | null }> | null } | undefined) {
  return relatedOne(user?.profiles)?.full_name ?? user?.managed_full_name ?? 'Sin nombre';
}

export async function listProducts(request: Request, response: Response) {
  const input = inventoryListSchema.safeParse(request.query);
  if (!input.success) throw new AppError(400, 'INVALID_INVENTORY_FILTERS', 'Los filtros de inventario no son válidos.');
  let productsQuery = supabaseAdmin.from('products').select('id,gym_id,name,sku,description,sale_price,currency,minimum_stock,is_active,created_at,updated_at')
    .eq('gym_id', request.tenant!.gymId).order('name').limit(500);
  if (!input.data.includeInactive) productsQuery = productsQuery.eq('is_active', true);
  const [productsResult, locationsResult] = await Promise.all([
    productsQuery,
    supabaseAdmin.from('gym_locations').select('id,name,is_active,is_main').eq('gym_id', request.tenant!.gymId).order('is_main', { ascending: false }).order('name'),
  ]);
  if (productsResult.error || locationsResult.error) throw fromSupabaseError(productsResult.error ?? locationsResult.error!);
  const products = productsResult.data ?? [];
  const locations = locationsResult.data ?? [];
  const stockQuery = input.data.locationId
    ? supabaseAdmin.from('product_stock_levels_by_location').select('product_id,location_id,current_stock').eq('gym_id', request.tenant!.gymId).eq('location_id', input.data.locationId)
    : supabaseAdmin.from('product_stock_levels').select('product_id,current_stock').eq('gym_id', request.tenant!.gymId);
  const stockResult = await stockQuery;
  if (stockResult.error) throw fromSupabaseError(stockResult.error);
  const stockByProduct = new Map<string, number>();
  for (const row of stockResult.data ?? []) stockByProduct.set(row.product_id, Number(row.current_stock ?? 0));
  response.json({
    products: products.map((product) => ({ ...product, current_stock: stockByProduct.get(product.id) ?? 0 })),
    locations,
    selectedLocationId: input.data.locationId ?? null,
  });
}

export async function createProduct(request: Request, response: Response) {
  const input = productSchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'INVALID_PRODUCT_INPUT', 'Revisa los datos del producto.', input.error.flatten());
  const { data, error } = await supabaseAdmin.rpc('create_product_backend', {
    target_gym_id: request.tenant!.gymId,
    target_actor_gym_user_id: request.tenant!.gymUserId,
    supplied_name: input.data.name,
    supplied_sku: input.data.sku,
    supplied_description: input.data.description ?? null,
    supplied_sale_price: input.data.salePrice,
    supplied_currency: input.data.currency,
    supplied_minimum_stock: input.data.minimumStock,
  });
  if (error) throw fromSupabaseError(error);
  response.status(201).json({ product: Array.isArray(data) ? data[0] : data });
}

export async function updateProduct(request: Request, response: Response) {
  const productId = request.params.id;
  const input = productSchema.safeParse(request.body);
  if (!productId || !uuid.safeParse(productId).success || !input.success) throw new AppError(400, 'INVALID_PRODUCT_INPUT', 'Revisa los datos del producto.');
  const { data, error } = await supabaseAdmin.rpc('update_product_backend', {
    target_gym_id: request.tenant!.gymId,
    target_product_id: productId,
    target_actor_gym_user_id: request.tenant!.gymUserId,
    supplied_name: input.data.name,
    supplied_sku: input.data.sku,
    supplied_description: input.data.description ?? null,
    supplied_sale_price: input.data.salePrice,
    supplied_currency: input.data.currency,
    supplied_minimum_stock: input.data.minimumStock,
    supplied_is_active: input.data.isActive,
  });
  if (error) throw fromSupabaseError(error);
  response.json({ product: Array.isArray(data) ? data[0] : data });
}

export async function listInventoryMovements(request: Request, response: Response) {
  const locationId = typeof request.query.locationId === 'string' ? request.query.locationId : undefined;
  if (locationId && !uuid.safeParse(locationId).success) throw new AppError(400, 'INVALID_LOCATION_ID', 'La sucursal no es válida.');
  let query = supabaseAdmin.from('inventory_movements').select('id,product_id,location_id,movement_type,quantity_delta,stock_before,stock_after,performed_by,reason,created_at')
    .eq('gym_id', request.tenant!.gymId).order('created_at', { ascending: false }).limit(250);
  if (locationId) query = query.eq('location_id', locationId);
  const { data, error } = await query;
  if (error) throw fromSupabaseError(error);
  const movements = data ?? [];
  const productIds = [...new Set(movements.map((movement) => movement.product_id))];
  const actorIds = [...new Set(movements.map((movement) => movement.performed_by))];
  const [productsResult, actorsResult] = await Promise.all([
    productIds.length ? supabaseAdmin.from('products').select('id,name,sku').eq('gym_id', request.tenant!.gymId).in('id', productIds) : Promise.resolve({ data: [], error: null }),
    actorIds.length ? supabaseAdmin.from('gym_users').select('id,managed_full_name,profiles(full_name)').eq('gym_id', request.tenant!.gymId).in('id', actorIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (productsResult.error || actorsResult.error) throw fromSupabaseError(productsResult.error ?? actorsResult.error!);
  const products = new Map((productsResult.data ?? []).map((product) => [product.id, product]));
  const actors = new Map((actorsResult.data ?? []).map((actor) => [actor.id, userName(actor)]));
  response.json({ movements: movements.map((movement) => ({ ...movement, product: products.get(movement.product_id) ?? null, performed_by_name: actors.get(movement.performed_by) ?? 'Sin nombre' })) });
}

export async function adjustInventory(request: Request, response: Response) {
  const input = inventoryAdjustmentSchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'INVALID_INVENTORY_ADJUSTMENT', 'Revisa el movimiento de inventario.', input.error.flatten());
  const { data, error } = await supabaseAdmin.rpc('adjust_inventory_backend', {
    target_gym_id: request.tenant!.gymId,
    target_location_id: input.data.locationId,
    target_product_id: input.data.productId,
    target_actor_gym_user_id: request.tenant!.gymUserId,
    supplied_movement_type: input.data.movementType,
    supplied_quantity_delta: input.data.quantityDelta,
    supplied_reason: input.data.reason,
    supplied_used_pin_elevation: request.permissionContext?.usedPinElevation ?? false,
  });
  if (error) throw fromSupabaseError(error);
  response.status(201).json({ movement: Array.isArray(data) ? data[0] : data });
}

export async function listSales(request: Request, response: Response) {
  const input = salesListSchema.safeParse(request.query);
  if (!input.success) throw new AppError(400, 'INVALID_SALES_FILTERS', 'Los filtros de ventas no son válidos.');
  let query = supabaseAdmin.from('sales').select('id,gym_id,location_id,member_user_id,seller_user_id,subtotal,discount,total,currency,status,sold_at,voided_at,void_reason,created_at')
    .eq('gym_id', request.tenant!.gymId).order('created_at', { ascending: false }).limit(250);
  if (request.tenant!.role === 'staff') {
    const { data: financePermission, error: permissionError } = await request.supabase!
      .from('staff_permissions').select('access_mode').eq('gym_id', request.tenant!.gymId)
      .eq('staff_user_id', request.tenant!.gymUserId).eq('permission_key', 'finances.view').maybeSingle();
    if (permissionError) throw new AppError(500, 'PERMISSION_LOOKUP_FAILED', 'No se pudo comprobar el permiso.');
    if (financePermission?.access_mode === 'denied' || !financePermission) query = query.eq('seller_user_id', request.tenant!.gymUserId);
  }
  if (input.data.status) query = query.eq('status', input.data.status);
  if (input.data.locationId) query = query.eq('location_id', input.data.locationId);
  const { data, error } = await query;
  if (error) throw fromSupabaseError(error);
  const sales = data ?? [];
  const ids = sales.map((sale) => sale.id);
  const userIds = [...new Set(sales.flatMap((sale) => [sale.member_user_id, sale.seller_user_id]).filter(Boolean))] as string[];
  const [paymentsResult, itemsResult, usersResult, locationsResult] = await Promise.all([
    ids.length ? supabaseAdmin.from('member_payments').select('id,sale_id,receipt_number,status,payment_method,external_reference,amount,paid_at,voided_at,refunded_at,void_reason,refund_reason').eq('gym_id', request.tenant!.gymId).in('sale_id', ids) : Promise.resolve({ data: [], error: null }),
    ids.length ? supabaseAdmin.from('sale_items').select('sale_id,product_id,product_name_snapshot,unit_price,quantity,line_total').eq('gym_id', request.tenant!.gymId).in('sale_id', ids) : Promise.resolve({ data: [], error: null }),
    userIds.length ? supabaseAdmin.from('gym_users').select('id,managed_full_name,profiles(full_name)').eq('gym_id', request.tenant!.gymId).in('id', userIds) : Promise.resolve({ data: [], error: null }),
    supabaseAdmin.from('gym_locations').select('id,name').eq('gym_id', request.tenant!.gymId),
  ]);
  const relatedError = paymentsResult.error ?? itemsResult.error ?? usersResult.error ?? locationsResult.error;
  if (relatedError) throw fromSupabaseError(relatedError);
  const payments = new Map((paymentsResult.data ?? []).map((payment) => [payment.sale_id, payment]));
  const items = new Map<string, typeof itemsResult.data>();
  for (const item of itemsResult.data ?? []) items.set(item.sale_id, [...(items.get(item.sale_id) ?? []), item]);
  const users = new Map((usersResult.data ?? []).map((user) => [user.id, userName(user)]));
  const locations = new Map((locationsResult.data ?? []).map((location) => [location.id, location.name]));
  response.json({ sales: sales.map((sale) => ({ ...sale, member_name: sale.member_user_id ? users.get(sale.member_user_id) ?? 'Miembro' : 'Venta general', seller_name: users.get(sale.seller_user_id) ?? 'Sin nombre', location_name: locations.get(sale.location_id) ?? 'Sucursal', payment: payments.get(sale.id) ?? null, items: items.get(sale.id) ?? [] })), locations: locationsResult.data ?? [] });
}

export async function registerProductSale(request: Request, response: Response) {
  const input = productSaleSchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'INVALID_PRODUCT_SALE', 'Revisa los datos de la venta.', input.error.flatten());
  const { data, error } = await supabaseAdmin.rpc('register_product_sale_backend', {
    target_gym_id: request.tenant!.gymId,
    target_location_id: input.data.locationId,
    target_seller_user_id: request.tenant!.gymUserId,
    target_member_user_id: input.data.memberUserId ?? null,
    supplied_items: input.data.items.map((item) => ({ product_id: item.productId, quantity: item.quantity })),
    supplied_discount: input.data.discount,
    supplied_payment_method: input.data.paymentMethod,
    supplied_external_reference: input.data.externalReference ?? null,
    supplied_notes: input.data.notes ?? null,
    supplied_used_pin_elevation: request.permissionContext?.usedPinElevation ?? false,
  });
  if (error) throw fromSupabaseError(error);
  const sale = Array.isArray(data) ? data[0] : data;
  if (!sale) throw new AppError(500, 'SALE_EMPTY_RESULT', 'La venta no devolvió un resultado.');
  response.status(201).json({ sale });
}

async function reverseSale(request: Request, response: Response, status: 'voided' | 'refunded') {
  const saleId = request.params.id;
  const input = saleReversalSchema.safeParse(request.body);
  if (!saleId || !uuid.safeParse(saleId).success || !input.success) throw new AppError(400, 'INVALID_SALE_REVERSAL', 'Debes indicar un motivo válido.');
  const { data, error } = await supabaseAdmin.rpc('reverse_product_sale_backend', {
    target_gym_id: request.tenant!.gymId,
    target_sale_id: saleId,
    target_actor_gym_user_id: request.tenant!.gymUserId,
    target_reversal_status: status,
    supplied_reason: input.data.reason,
    supplied_used_pin_elevation: request.permissionContext?.usedPinElevation ?? false,
  });
  if (error) throw fromSupabaseError(error);
  const sale = Array.isArray(data) ? data[0] : data;
  if (!sale) throw new AppError(404, 'SALE_NOT_FOUND', 'La venta no existe o ya no puede revertirse.');
  response.json({ sale });
}

export async function voidSale(request: Request, response: Response) { return reverseSale(request, response, 'voided'); }
export async function refundSale(request: Request, response: Response) { return reverseSale(request, response, 'refunded'); }

export async function getSaleReceipt(request: Request, response: Response) {
  const saleId = request.params.id;
  if (!saleId || !uuid.safeParse(saleId).success) throw new AppError(400, 'INVALID_SALE_ID', 'La venta no es válida.');
  const { data: sale, error: saleError } = await supabaseAdmin.from('sales').select('id,location_id,member_user_id,seller_user_id,subtotal,discount,total,currency,status,sold_at,voided_at,void_reason').eq('id', saleId).eq('gym_id', request.tenant!.gymId).maybeSingle();
  if (saleError) throw fromSupabaseError(saleError);
  if (!sale) throw new AppError(404, 'SALE_NOT_FOUND', 'La venta no existe.');
  if (request.tenant!.role === 'staff') {
    const { data: financePermission, error: permissionError } = await request.supabase!
      .from('staff_permissions').select('access_mode').eq('gym_id', request.tenant!.gymId)
      .eq('staff_user_id', request.tenant!.gymUserId).eq('permission_key', 'finances.view').maybeSingle();
    if (permissionError) throw new AppError(500, 'PERMISSION_LOOKUP_FAILED', 'No se pudo comprobar el permiso.');
    if ((!financePermission || financePermission.access_mode === 'denied') && sale.seller_user_id !== request.tenant!.gymUserId) {
      throw new AppError(404, 'SALE_NOT_FOUND', 'La venta no existe.');
    }
  }
  const [paymentResult, itemsResult, gymResult, locationResult, memberResult, sellerResult] = await Promise.all([
    supabaseAdmin.from('member_payments').select('id,receipt_number,receipt_issued_at,receipt_verification_token,status,payment_method,external_reference,amount,currency,paid_at,voided_at,void_reason,refunded_at,refund_reason').eq('sale_id', saleId).eq('gym_id', request.tenant!.gymId).maybeSingle(),
    supabaseAdmin.from('sale_items').select('product_name_snapshot,unit_price,quantity,line_total').eq('sale_id', saleId).eq('gym_id', request.tenant!.gymId),
    supabaseAdmin.from('gyms').select('name,legal_name,email,phone,whatsapp_phone,logo_url').eq('id', request.tenant!.gymId).single(),
    supabaseAdmin.from('gym_locations').select('name,address,city,email,phone,whatsapp_phone').eq('id', sale.location_id).eq('gym_id', request.tenant!.gymId).single(),
    sale.member_user_id ? supabaseAdmin.from('gym_users').select('managed_full_name,managed_phone,profiles(full_name,phone)').eq('id', sale.member_user_id).eq('gym_id', request.tenant!.gymId).single() : Promise.resolve({ data: null, error: null }),
    supabaseAdmin.from('gym_users').select('managed_full_name,profiles(full_name)').eq('id', sale.seller_user_id).eq('gym_id', request.tenant!.gymId).single(),
  ]);
  const relatedError = paymentResult.error ?? itemsResult.error ?? gymResult.error ?? locationResult.error ?? memberResult.error ?? sellerResult.error;
  if (relatedError) throw fromSupabaseError(relatedError);
  if (!paymentResult.data || !gymResult.data || !locationResult.data || !sellerResult.data) throw new AppError(404, 'SALE_RECEIPT_CONTEXT_NOT_FOUND', 'No se pudo completar el recibo de la venta.');
  const member = memberResult.data;
  const memberProfile = relatedOne(member?.profiles);
  response.json({ receipt: {
    number: paymentResult.data.receipt_number,
    issuedAt: paymentResult.data.receipt_issued_at,
    verificationToken: paymentResult.data.receipt_verification_token,
    status: paymentResult.data.status,
    amount: paymentResult.data.amount,
    currency: paymentResult.data.currency,
    paymentMethod: paymentResult.data.payment_method,
    externalReference: paymentResult.data.external_reference,
    paidAt: paymentResult.data.paid_at,
    voidReason: paymentResult.data.void_reason ?? sale.void_reason,
    refundReason: paymentResult.data.refund_reason,
    reversedAt: paymentResult.data.voided_at ?? paymentResult.data.refunded_at,
    gym: gymResult.data,
    location: locationResult.data,
    customer: { name: memberProfile?.full_name ?? member?.managed_full_name ?? 'Venta general', phone: memberProfile?.phone ?? member?.managed_phone ?? null },
    registeredBy: { name: userName(sellerResult.data) },
    items: itemsResult.data ?? [],
    sale: { ...sale, sold_at: sale.sold_at },
  } });
}
