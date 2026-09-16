import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe,expect,it } from 'vitest';

const root=join(import.meta.dirname,'..','..');
const source=(path:string)=>readFileSync(join(root,path),'utf8');

describe('cobros manuales SaaS',()=>{
  it('mantiene comprobantes y activos fuera del acceso directo',()=>{
    const migration=source('supabase/migrations/0037_manual_saas_billing.sql');
    expect(migration).toContain("values ('saas-payment-proofs','saas-payment-proofs',false");
    expect(migration).toContain("values ('saas-billing-assets','saas-billing-assets',false");
    expect(migration).toContain('revoke all on public.saas_payment_requests from anon, authenticated');
    expect(migration).not.toContain('create policy');
  });

  it('exige administrador de plataforma con MFA para revisar y suspender',()=>{
    const migration=source('supabase/migrations/0037_manual_saas_billing.sql');
    const controller=source('backend/src/controllers/manualBilling.controller.ts');
    expect(migration.match(/PLATFORM_ADMIN_MFA_REQUIRED/g)?.length).toBe(2);
    expect(migration).toContain("auth.jwt()->>'aal','')<>'aal2'");
    expect(controller).toContain("'saas.proof_viewed'");
    expect(controller).toContain("createSignedUrl(data.proof_path,60");
    expect(controller).not.toContain('proof_path:');
  });

  it('aprueba de forma atómica, evita duplicados y conserva auditoría',()=>{
    const migration=source('supabase/migrations/0037_manual_saas_billing.sql');
    expect(migration).toContain('saas_request_proof_idx');
    expect(migration).toContain('saas_request_reference_idx');
    expect(migration).toContain("if req.status=decision then return");
    expect(migration).toContain("'saas.payment_'||decision");
    expect(migration).toContain("provider='manual',status='active'");
  });
});
