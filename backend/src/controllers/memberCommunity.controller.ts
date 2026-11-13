import { communityPageSchema, parseAggregate } from '../services/memberAggregates.service.js';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../errors/AppError.js';
import { signAvatarUrl } from '../services/memberProfile.service.js';
import { fromSupabaseError } from '../utils/supabaseError.js';


const communityFilters = ['all', 'similar_goal', 'consistent', 'new', 'longest_streak', 'featured', 'progress'] as const;
const communityQuerySchema = z.object({
  filter: z.enum(communityFilters).default('all'),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(4096).optional(),
});
const reactionSchema = z.object({ targetMemberUserId: z.string().uuid(), reactionType: z.enum(['like', 'love']) });


function memberOnly(request: Request) {
  if (request.tenant?.role !== 'member') throw new AppError(403, 'MEMBER_ONLY_ENDPOINT', 'Esta sección está disponible solo para miembros.');
}

export async function listMemberCommunity(request: Request, response: Response) {
  memberOnly(request);
  const input = communityQuerySchema.safeParse(request.query);
  if (!input.success) throw new AppError(400, 'INVALID_COMMUNITY_PAGE', 'El filtro o la página de Comunidad no es válido.');
  let cursor: unknown = null;
  if (input.data.cursor) {
    try { cursor = JSON.parse(input.data.cursor); }
    catch { throw new AppError(400, 'INVALID_COMMUNITY_CURSOR', 'Vuelve a cargar Comunidad desde la primera página.'); }
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) throw new AppError(400, 'INVALID_COMMUNITY_CURSOR', 'El cursor no es válido.');
  }
  const { data, error } = await supabaseAdmin.rpc('list_member_community_weekly_page_backend', {
    target_gym_id: request.tenant!.gymId, actor_member_user_id: request.tenant!.gymUserId,
    requested_filter: input.data.filter, page_size: input.data.pageSize, after_cursor: cursor,
  });
  if (error) throw fromSupabaseError(error);
  const page = parseAggregate(communityPageSchema, data);
  const items = await Promise.all(page.items.map(async ({ avatarPath, ...item }) => ({
    ...item, avatarUrl: avatarPath ? await signAvatarUrl(avatarPath) : null,
  })));
  response.setHeader('Cache-Control', 'no-store');
  response.json({ items, nextCursor: page.nextCursor, hasMore: page.hasMore });
}

export async function toggleMemberCommunityReaction(request: Request, response: Response) {
  memberOnly(request);
  const input = reactionSchema.safeParse(request.body);
  if (!input.success) throw new AppError(400, 'INVALID_COMMUNITY_REACTION', 'La reacción no es válida.');
  const { data, error } = await supabaseAdmin.rpc('toggle_member_community_reaction_backend', {
    p_target_gym_id: request.tenant!.gymId,
    p_actor_member_user_id: request.tenant!.gymUserId,
    p_target_member_user_id: input.data.targetMemberUserId,
    p_supplied_reaction_type: input.data.reactionType,
  });
  if (error) throw fromSupabaseError(error);
  response.json({ reaction: data });
}
