import { createHash } from 'node:crypto';

export function paymentProofHash(bytes: Buffer): string | null {
  if (bytes.length === 0 || bytes.length > 5 * 1024 * 1024) return null;
  const pdf = bytes.subarray(0,5).toString() === '%PDF-';
  const png = bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return pdf || png || jpeg ? createHash('sha256').update(bytes).digest('hex') : null;
}
