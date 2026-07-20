import type { Request, Response } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { AppError } from '../errors/AppError.js';

const chatSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().trim().min(1).max(1200),
  })).min(1).max(10),
});

type HuggingFaceResponse = { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } | string };

const systemMessage = `Eres FitLab IA, un asistente breve, amable y motivador para miembros de gimnasio.
Responde siempre en español claro. Puedes orientar sobre hábitos, ejercicios generales, descanso,
alimentación general y uso del portal FitLab. No diagnostiques enfermedades, no prescribas tratamientos
ni reemplaces a médicos, nutricionistas o entrenadores. Ante dolor, lesión, embarazo, enfermedad o riesgo,
recomienda consultar a un profesional. No inventes datos de la cuenta del usuario.`;

export async function chatWithAssistant(request: Request, response: Response) {
  if (request.tenant?.role !== 'member') throw new AppError(403, 'MEMBER_CHAT_ONLY', 'El asistente está disponible en el portal de miembros.');
  if (!env.HF_TOKEN) throw new AppError(503, 'AI_NOT_CONFIGURED', 'El asistente todavía no está configurado.');
  const input = chatSchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'INVALID_CHAT_INPUT', 'Revisa el mensaje enviado.', input.error.flatten());

  const model = env.HF_PROVIDER === 'auto' ? env.HF_MODEL : `${env.HF_MODEL}:${env.HF_PROVIDER}`;
  let upstream: globalThis.Response;
  try {
    upstream = await fetch('https://router.huggingface.co/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.HF_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: systemMessage }, ...input.data.messages], max_tokens: 450, temperature: 0.65 }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new AppError(504, 'AI_PROVIDER_TIMEOUT', 'El asistente tardó demasiado. Inténtalo nuevamente.');
  }
  const result = await upstream.json() as HuggingFaceResponse;
  if (!upstream.ok) {
    const detail = typeof result.error === 'string' ? result.error : result.error?.message;
    throw new AppError(502, 'AI_PROVIDER_ERROR', detail ?? 'Hugging Face no pudo responder.');
  }
  const answer = result.choices?.[0]?.message?.content?.trim();
  if (!answer) throw new AppError(502, 'AI_EMPTY_RESPONSE', 'El asistente no generó una respuesta.');
  response.json({ answer, model: env.HF_MODEL });
}
