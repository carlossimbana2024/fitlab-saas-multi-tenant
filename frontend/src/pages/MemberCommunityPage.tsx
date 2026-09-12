import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Dumbbell, Flame, Heart, LoaderCircle, Sparkles, ThumbsUp, UsersRound } from 'lucide-react';
import { useState } from 'react';
import { api, apiErrorMessage } from '../services/api';

type CommunityFilter = 'all' | 'similar_goal' | 'consistent' | 'new' | 'longest_streak' | 'featured' | 'progress';
type CommunityMember = {
  id: string;
  name: string;
  avatarUrl: string | null;
  currentStreak: number | null;
  longestStreak: number | null;
  monthlyAttendances: number | null;
  goalType: string | null;
  progressPercent: number | null;
  publicMessage: string | null;
  reactions: { like: number; love: number; mine: 'like' | 'love' | null };
};
type CommunityResponse = { members: CommunityMember[]; viewer: { goalType: string | null }; filter: CommunityFilter; period: { from: string; to: string } };

const filters: Array<{ value: CommunityFilter; label: string }> = [
  { value: 'all', label: 'Todos' },
  { value: 'similar_goal', label: 'Objetivos similares' },
  { value: 'consistent', label: 'Más constantes' },
  { value: 'new', label: 'Nuevas personas' },
  { value: 'longest_streak', label: 'Rachas más largas' },
  { value: 'featured', label: 'Destacados' },
  { value: 'progress', label: 'Mayor progreso' },
];

const goalLabels: Record<string, string> = {
  lose_weight: 'Perder peso',
  gain_weight: 'Ganar peso',
  build_muscle: 'Ganar masa muscular',
  improve_fitness: 'Mejorar condición física',
  maintain_weight: 'Mantener peso',
  general_wellness: 'Bienestar general',
};

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'AT';
}

export function MemberCommunityPage() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<CommunityFilter>('all');
  const community = useQuery({
    queryKey: ['member-community', filter],
    queryFn: async () => (await api.get<CommunityResponse>('/members/me/community', { params: { filter } })).data,
  });
  const react = useMutation({
    mutationFn: async ({ targetMemberUserId, reactionType }: { targetMemberUserId: string; reactionType: 'like' | 'love' }) => api.post('/members/me/community/reactions', { targetMemberUserId, reactionType }),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['member-community'] }),
  });
  const members = community.data?.members ?? [];

  return <>
    <div className="portal-view-heading"><div><p className="eyebrow">ENTRENA EN COMUNIDAD</p><h1>Comunidad</h1><p>Reconoce el esfuerzo de otros miembros de tu gimnasio.</p></div><div className="community-heading-icon"><UsersRound /></div></div>
    <section className="community-intro"><Sparkles /><div><strong>Una comunidad positiva</strong><span>Solo se muestran perfiles que decidieron participar y las métricas que eligieron compartir.</span></div></section>
    <section className="panel community-panel"><div className="community-filter-row" role="group" aria-label="Filtrar Comunidad">{filters.map((item) => <button type="button" key={item.value} className={filter === item.value ? 'active' : undefined} onClick={() => setFilter(item.value)}>{item.label}</button>)}</div>{community.isError && <div className="alert error">{apiErrorMessage(community.error)}</div>}{community.isLoading ? <div className="empty compact"><LoaderCircle className="spin"/><strong>Cargando Comunidad…</strong></div> : members.length ? <div className="community-grid">{members.map((member) => <CommunityCard key={member.id} member={member} pending={react.isPending} onReact={(reactionType) => react.mutate({ targetMemberUserId: member.id, reactionType })}/>)}</div> : <div className="empty compact"><UsersRound/><strong>Aún no hay perfiles para mostrar</strong><span>Cuando otros miembros habiliten su perfil, aparecerán aquí.</span></div>}</section>
    {react.isError && <div className="alert error community-action-error">{apiErrorMessage(react.error)}</div>}
  </>;
}

function CommunityCard({ member, pending, onReact }: { member: CommunityMember; pending: boolean; onReact: (reactionType: 'like' | 'love') => void }) {
  return <article className="community-card"><div className="community-card-head">{member.avatarUrl ? <img src={member.avatarUrl} alt={`Foto de ${member.name}`} /> : <span className="avatar avatar-large">{initials(member.name)}</span>}<div><h2>{member.name}</h2>{member.goalType && <span className="community-goal"><Dumbbell />{goalLabels[member.goalType] ?? member.goalType}</span>}</div></div>{member.publicMessage && <p className="community-message">“{member.publicMessage}”</p>}<div className="community-metrics">{member.currentStreak !== null && <span><Flame />{member.currentStreak} días de racha</span>}{member.monthlyAttendances !== null && <span><Activity />{member.monthlyAttendances} este mes</span>}{member.progressPercent !== null && <span><Dumbbell />{member.progressPercent}% de avance</span>}{member.longestStreak !== null && <small>Mejor racha: {member.longestStreak}</small>}</div><div className="community-reactions"><button type="button" className={member.reactions.mine === 'like' ? 'selected' : undefined} disabled={pending} onClick={() => onReact('like')}><ThumbsUp />Me gusta <b>{member.reactions.like}</b></button><button type="button" className={member.reactions.mine === 'love' ? 'selected love' : undefined} disabled={pending} onClick={() => onReact('love')}><Heart />Me encanta <b>{member.reactions.love}</b></button></div></article>;
}
