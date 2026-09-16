import { describe,expect,it } from 'vitest';
import { paymentProofHash } from '../src/security/paymentProof.js';

describe('paymentProofHash',()=>{
  it('acepta únicamente firmas reales de los formatos permitidos',()=>{
    expect(paymentProofHash(Buffer.from('%PDF-1.7 comprobante'))).toMatch(/^[a-f0-9]{64}$/);
    expect(paymentProofHash(Buffer.from([0xff,0xd8,0xff,1,2,3]))).toMatch(/^[a-f0-9]{64}$/);
    expect(paymentProofHash(Buffer.from([137,80,78,71,13,10,26,10,1]))).toMatch(/^[a-f0-9]{64}$/);
    expect(paymentProofHash(Buffer.from('archivo renombrado.pdf'))).toBeNull();
  });

  it('rechaza archivos vacíos o mayores a 5 MB',()=>{
    expect(paymentProofHash(Buffer.alloc(0))).toBeNull();
    const oversized=Buffer.alloc(5*1024*1024+1); oversized.write('%PDF-');
    expect(paymentProofHash(oversized)).toBeNull();
  });
});
