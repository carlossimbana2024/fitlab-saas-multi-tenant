import { z } from 'zod';

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const optionalEmail = z.union([z.string().trim().email(), z.literal(''), z.null()]).optional();

export const gymSettingsSchema = z.object({
  name: z.string().trim().min(2).max(150),
  email: optionalEmail,
  phone: optionalText(30),
  whatsappPhone: optionalText(30),
});

export const locationSettingsSchema = z.object({
  name: z.string().trim().min(2).max(150),
  address: optionalText(300),
  city: z.string().trim().min(2).max(100),
  email: optionalEmail,
  phone: optionalText(30),
  whatsappPhone: optionalText(30),
});
