import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, CalendarDays, ChevronRight, Dumbbell, Flame, Heart, LoaderCircle, Medal, Sparkles, ThumbsUp, Trophy, UsersRound } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, apiErrorMessage } from '../services/api';
import '../community.css';

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
type RankingEntry = { position: number; memberUserId: string; name: string; avatarUrl: string | null; value: number; displayValue: string; goalType: string | null };
type RankingCategory = { title: string; explanation: string; entries: RankingEntry[] };
type RankingResponse = {
  ranking: {
    period: { key: string; label: string; from: string; to: string; isCurrent: boolean };
    availablePeriods: Array<{ key: string; label: string }>;
    historyMode: 'reconstructed';
    categories: { attendance: RankingCategory; streak: RankingCategory; progress: RankingCategory };
  };
};

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
  const [rankingMonth, setRankingMonth] = useState('');
  const [rankingTab, setRankingTab] = useState<'attendance' | 'streak' | 'progress'>('attendance');
  const community = useQuery({
    queryKey: ['member-community', filter],
    queryFn: async () => (await api.get<CommunityResponse>('/members/me/community', { params: { filter } })).data,
  });
  const rankings = useQuery({
    queryKey: ['member-community-rankings', rankingMonth || 'current'],
    queryFn: async () => (await api.get<RankingResponse>('/members/me/community/rankings', { params: rankingMonth ? { month: rankingMonth } : undefined })).data,
  });
  const react = useMutation({
    mutationFn: async ({ targetMemberUserId, reactionType }: { targetMemberUserId: string; reactionType: 'like' | 'love' }) => api.post('/members/me/community/reactions', { targetMemberUserId, reactionType }),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['member-community'] }),
  });
  const members = community.data?.members ?? [];
  const ranking = rankings.data?.ranking;

  return <div className="community-page">
    <div className="portal-view-heading"><div><p className="eyebrow">ENTRENA EN COMUNIDAD</p><h1>Comunidad</h1><p>Reconoce el esfuerzo de otros miembros de tu gimnasio.</p></div><div className="community-heading-icon"><UsersRound /></div></div>
    <section className="community-intro"><UsersRound /><div><strong>Una comunidad positiva</strong><span>Solo se muestran perfiles que decidieron participar y las métricas que eligieron compartir.</span></div></section>
    <section className="panel community-ranking-panel">
      <div className="community-ranking-heading"><div><p className="eyebrow">RECONOCIMIENTO MENSUAL</p><h2><Trophy /> Top 3 del mes</h2><span>Cada logro se evalúa por separado y comienza desde cero en cada período.</span></div>{ranking && <label><CalendarDays /><select value={rankingMonth || ranking.period.key} onChange={(event) => setRankingMonth(event.target.value)} aria-label="Mes del ranking">{ranking.availablePeriods.map((period) => <option key={period.key} value={period.key}>{period.label}</option>)}</select></label>}</div>
      {rankings.isError && <div className="alert error">{apiErrorMessage(rankings.error)}</div>}
      {rankings.isLoading ? <div className="empty compact" role="status"><LoaderCircle className="spin"/><strong>Calculando rankings…</strong></div> : ranking && <><div className="community-ranking-tabs" role="tablist" aria-label="Categorías del ranking">{([{id:'attendance',label:'Más asistencias',icon:<Activity/>},{id:'streak',label:'Mayor racha',icon:<Flame/>},{id:'progress',label:'Mayor progreso',icon:<Dumbbell/>}] as const).map((tab,index,tabs)=><button type="button" role="tab" id={`ranking-tab-${tab.id}`} aria-controls={`ranking-panel-${tab.id}`} aria-selected={rankingTab===tab.id} tabIndex={rankingTab===tab.id?0:-1} key={tab.id} onClick={()=>setRankingTab(tab.id)} onKeyDown={event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?2:(index+(event.key==='ArrowRight'?1:-1)+3)%3;setRankingTab(tabs[next].id);(event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();}}>{tab.icon}<span>{tab.label}</span></button>)}</div><div className="community-ranking-grid"><div id="ranking-panel-attendance" role="tabpanel" aria-labelledby="ranking-tab-attendance" hidden={rankingTab!=='attendance'}><RankingCategoryCard category={ranking.categories.attendance} icon={<Activity />}/></div><div id="ranking-panel-streak" role="tabpanel" aria-labelledby="ranking-tab-streak" hidden={rankingTab!=='streak'}><RankingCategoryCard category={ranking.categories.streak} icon={<Flame />}/></div><div id="ranking-panel-progress" role="tabpanel" aria-labelledby="ranking-tab-progress" hidden={rankingTab!=='progress'}><RankingCategoryCard category={ranking.categories.progress} icon={<Dumbbell />}/></div></div><p className="ranking-formula"><Sparkles />{ranking.categories.progress.explanation}</p></>}
    </section>
    <section className="panel community-panel"><div className="community-members-heading"><h2>Miembros de la comunidad</h2><p>Conecta, inspira y celebra juntos.</p></div><div className="community-filter-row" role="group" aria-label="Filtrar Comunidad">{filters.slice(0,3).map((item) => <button type="button" key={item.value} aria-pressed={filter===item.value} className={filter === item.value ? 'active' : undefined} onClick={() => setFilter(item.value)}>{item.label}</button>)}<details className="community-extra-filters"><summary>Más filtros{filters.slice(3).some(item=>item.value===filter)?` · ${filters.find(item=>item.value===filter)?.label}`:''}</summary><div>{filters.slice(3).map(item=><button type="button" key={item.value} aria-pressed={filter===item.value} className={filter===item.value?'active':undefined} onClick={()=>setFilter(item.value)}>{item.label}</button>)}</div></details></div>{community.isError && <div className="alert error">{apiErrorMessage(community.error)}</div>}{community.isLoading ? <div className="empty compact" role="status"><LoaderCircle className="spin"/><strong>Cargando Comunidad…</strong></div> : members.length ? <div className="community-grid">{members.map((member) => <CommunityCard key={member.id} member={member} pending={react.isPending} onReact={(reactionType) => react.mutate({ targetMemberUserId: member.id, reactionType })}/>)}</div> : <div className="empty compact"><UsersRound/><strong>Aún no hay perfiles para mostrar</strong><span>Cuando otros miembros habiliten su perfil, aparecerán aquí.</span></div>}</section>
    {react.isError && <div className="alert error community-action-error">{apiErrorMessage(react.error)}</div>}
  </div>;
}

function RankingCategoryCard({ category, icon }: { category: RankingCategory; icon: ReactNode }) {
  return <article className="ranking-category"><header><span>{icon}</span><div><h3>{category.title}</h3><small>{category.explanation}</small></div></header>{category.entries.length ? <ol className="ranking-podium" data-count={category.entries.length}>{category.entries.map((entry) => <li key={entry.memberUserId} className={`ranking-position ranking-position-${entry.position}`}><span className="ranking-medal"><Medal />{entry.position}.º</span>{entry.avatarUrl ? <img src={entry.avatarUrl} alt={`Foto de ${entry.name}`} loading="lazy"/> : <span className="avatar">{initials(entry.name)}</span>}<div><strong>{entry.name}</strong>{entry.goalType && <small>{goalLabels[entry.goalType] ?? entry.goalType}</small>}</div><b>{entry.displayValue}</b></li>)}</ol> : <div className="ranking-empty"><Medal/><strong>Aún no hay datos suficientes para este mes.</strong><span>Los logros aparecerán cuando existan métricas compartidas para esta categoría.</span></div>}</article>;
}

function CommunityCard({ member, pending, onReact }: { member: CommunityMember; pending: boolean; onReact: (reactionType: 'like' | 'love') => void }) {
  return <article className="community-card"><div className="community-card-head">{member.avatarUrl ? <img src={member.avatarUrl} alt={`Foto de ${member.name}`} loading="lazy"/> : <span className="avatar avatar-large">{initials(member.name)}</span>}<div><h2><Link to={`/portal/community/${member.id}`}>{member.name}</Link></h2>{member.goalType && <span className="community-goal"><Dumbbell />{goalLabels[member.goalType] ?? member.goalType}</span>}</div></div>{member.publicMessage && <p className="community-message">“{member.publicMessage}”</p>}<div className="community-metrics">{member.currentStreak !== null && <span><Flame />{member.currentStreak} días de racha</span>}{member.monthlyAttendances !== null && <span><Activity />{member.monthlyAttendances} este mes</span>}{member.progressPercent !== null && <span><Dumbbell />{member.progressPercent}% de avance</span>}{member.longestStreak !== null && <small>Mejor racha: {member.longestStreak}</small>}</div><div className="community-card-actions"><div className="community-reactions"><button type="button" aria-pressed={member.reactions.mine==='like'} className={member.reactions.mine === 'like' ? 'selected' : undefined} disabled={pending} onClick={() => onReact('like')}><ThumbsUp />Me gusta <b>{member.reactions.like}</b></button><button type="button" aria-pressed={member.reactions.mine==='love'} className={member.reactions.mine === 'love' ? 'selected love' : undefined} disabled={pending} onClick={() => onReact('love')}><Heart />Me encanta <b>{member.reactions.love}</b></button></div><Link className="small-button" to={`/portal/community/${member.id}`}>Ver perfil<ChevronRight/></Link></div></article>;
}
