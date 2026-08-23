import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const source = (path: string) => readFileSync(join(root, path), 'utf8');

describe('stock y ventas', () => {
  it('mantiene las mutaciones comerciales detrás de RPC backend-only', () => {
    const migration = source('supabase/migrations/0028_inventory_sales_backend.sql');
    const controller = source('backend/src/controllers/commerce.controller.ts');
    for (const functionName of [
      'create_product_backend',
      'update_product_backend',
      'adjust_inventory_backend',
      'register_product_sale_backend',
      'reverse_product_sale_backend',
    ]) {
      expect(migration, functionName).toContain(`revoke all on function public.${functionName}`);
      expect(migration, functionName).toContain(`grant execute on function public.${functionName}`);
      expect(controller, functionName).toContain(`rpc('${functionName}'`);
    }
  });

  it('separa el inventario por sucursal y conserva el agregado global', () => {
    const migration = source('supabase/migrations/0028_inventory_sales_backend.sql');
    expect(migration).toContain('product_stock_levels_by_location');
    expect(migration).toContain('im.product_id = new.product_id and im.location_id = new.location_id');
    expect(migration).toContain('SALE_INVENTORY_LOCATION_MISMATCH');
    expect(migration).toContain('INSUFFICIENT_STOCK');
  });

  it('mantiene anulacion y reembolso como estados distintos y auditados', () => {
    const migration = source('supabase/migrations/0028_inventory_sales_backend.sql');
    const routes = source('backend/src/routes/commerce.routes.ts');
    expect(routes).toContain("salesRouter.patch('/:id/void'");
    expect(routes).toContain("salesRouter.patch('/:id/refund'");
    expect(migration).toContain("'sale.voided'");
    expect(migration).toContain("'sale.refunded'");
    expect(migration).toContain("'sale.completed'");
  });
});

