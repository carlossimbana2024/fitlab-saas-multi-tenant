import { Router } from 'express';
import { adjustInventory, createProduct, getSaleReceipt, listInventoryMovements, listProducts, listSales, refundSale, registerProductSale, updateProduct, voidSale } from '../controllers/commerce.controller.js';
import { checkPermission } from '../middlewares/checkPermission.js';
import { checkAnyPermission } from '../middlewares/checkAnyPermission.js';
import { tenantContext } from '../middlewares/tenantContext.js';
import { verifyJWT } from '../middlewares/verifyJWT.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const inventoryRouter = Router();
inventoryRouter.use(verifyJWT, tenantContext);
inventoryRouter.get('/products', checkAnyPermission(['products.manage', 'sales.register', 'inventory.adjust']), asyncHandler(listProducts));
inventoryRouter.post('/products', checkPermission('products.manage'), asyncHandler(createProduct));
inventoryRouter.patch('/products/:id', checkPermission('products.manage'), asyncHandler(updateProduct));
inventoryRouter.get('/movements', checkAnyPermission(['products.manage', 'inventory.adjust', 'reports.view']), asyncHandler(listInventoryMovements));
inventoryRouter.post('/adjustments', checkPermission('inventory.adjust'), asyncHandler(adjustInventory));

export const salesRouter = Router();
salesRouter.use(verifyJWT, tenantContext);
salesRouter.get('/', checkAnyPermission(['sales.register', 'finances.view', 'sales.void']), asyncHandler(listSales));
salesRouter.post('/', checkPermission('sales.register'), asyncHandler(registerProductSale));
salesRouter.get('/:id/receipt', checkAnyPermission(['sales.register', 'finances.view', 'sales.void']), asyncHandler(getSaleReceipt));
salesRouter.patch('/:id/void', checkPermission('sales.void'), asyncHandler(voidSale));
salesRouter.patch('/:id/refund', checkPermission('sales.void'), asyncHandler(refundSale));
