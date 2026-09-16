import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../errors/AppError.js';

export const GYM_RECEIPT_BRANDING_BUCKET = 'gym-receipt-branding';
export const GYM_RECEIPT_LOGO_MAX_BYTES = 5 * 1024 * 1024;

const logoExtensions: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const logoPathPattern = /^[0-9a-f-]{36}\/receipt-logo\.(jpg|png|webp)$/i;

export function receiptLogoExtension(contentType: string) {
  const extension = logoExtensions[contentType.toLowerCase()];
  if (!extension) throw new AppError(400, 'UNSUPPORTED_RECEIPT_LOGO_TYPE', 'El logotipo debe ser JPG, PNG o WEBP.');
  return extension;
}

export function createReceiptLogoPath(gymId: string, contentType: string) {
  return `${gymId}/receipt-logo.${receiptLogoExtension(contentType)}`;
}

export function isReceiptLogoPath(path: string, gymId: string) {
  return path.startsWith(`${gymId}/`) && logoPathPattern.test(path);
}

export function publicReceiptLogoUrl(path: string) {
  const { data } = supabaseAdmin.storage.from(GYM_RECEIPT_BRANDING_BUCKET).getPublicUrl(path);
  return `${data.publicUrl}?v=${Date.now()}`;
}
