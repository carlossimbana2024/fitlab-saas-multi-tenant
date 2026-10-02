import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query';
import {Link} from 'react-router-dom';
import {Flame,Hand,Users} from 'lucide-react';
import {api,apiErrorMessage} from '../services/api';
import {PrivacySwitch} from './PrivacySwitch';
type Action='poke'|'invite'|'accept'|'reject'|'cancel'|'end';
type Streak={id:string;targetId:string;status:'pending'|'active';direction:string;startsOn:string|null;myTarget:number;friendTarget:number;myVisits:number;friendVisits:number;currentWeeks:number;bestWeeks:number;canContinue:boolean};
type Data={available:boolean;allowPokes:boolean;streaks:Streak[];cooldowns:{targetId:string;nextAt:string}[]};
function useTraining(){return useQuery({queryKey:['member-training-social'],queryFn:async()=>(await api.get<Data>('/members/me/training-social')).data,refetchInterval:30000});}
function useAction(){const client=useQueryClient();return useMutation({mutationFn:({targetMemberId,action}:{targetMemberId:string;action:Action})=>api.post('/members/me/training-social',{targetMemberId,action}),onSettled:async()=>{await Promise.all(['member-training-social','loyalty-engagement'].map(key=>client.invalidateQueries({queryKey:[key]})));}});}
export function TrainingFriendActions({memberId}:{memberId:string}){
 const query=useTraining();const action=useAction();const d=query.data;
 if(query.isError)return <p className="alert error">{apiErrorMessage(query.error)}</p>;
 if(!d?.available)return null;
 const cooldown=d.cooldowns.find(c=>c.targetId===memberId);const waiting=cooldown&&Date.parse(cooldown.nextAt)>Date.now();const existing=d.streaks.some(s=>s.targetId===memberId);
 return <div className="friend-actions"><button className="ghost" disabled={action.isPending||!d.allowPokes||Boolean(waiting)} onClick={()=>action.mutate({targetMemberId:memberId,action:'poke'})}><Hand/>{waiting?'Toque enviado':'Dar un toque'}</button>{!existing&&<button className="ghost" disabled={action.isPending||!d.allowPokes} onClick={()=>action.mutate({targetMemberId:memberId,action:'invite'})}><Flame/>Invitar a racha juntos</button>}{waiting&&<small>Disponible otra vez: {new Date(cooldown.nextAt).toLocaleString('es-EC')}</small>}{!d.allowPokes&&<small><Link to="/portal/settings">Activa “Permitir toques” en Configuración.</Link></small>}{existing&&<Link to="/portal/profile?tab=activity">Ver racha compartida</Link>}{action.isSuccess&&<p role="status">Acción registrada. Tu amigo recibirá un aviso en FitLab.</p>}{action.isError&&<p className="alert error">{apiErrorMessage(action.error)}</p>}</div>;
}
export function PokePreference(){
 const query=useTraining();const client=useQueryClient();
 const preference=useMutation({mutationFn:(allowPokes:boolean)=>api.put('/members/me/poke-preferences',{allowPokes}),onSettled:()=>client.invalidateQueries({queryKey:['member-training-social']})});
 if(query.isPending)return <p role="status">Cargando privacidad de toques…</p>;
 if(query.isError)return <p className="alert error">{apiErrorMessage(query.error)}</p>;
 if(!query.data.available)return null;
 return <><PrivacySwitch label="Permitir toques e invitaciones de amigos" checked={preference.isPending?Boolean(preference.variables):query.data.allowPokes} disabled={preference.isPending} onChange={value=>preference.mutate(value)}/><p className="form-note">Un toque por amigo cada 12 horas. Desactivarlo pausa la consulta de rachas compartidas.</p>{preference.isSuccess&&<small role="status">✓ Guardado</small>}{preference.isError&&<p className="alert error" role="alert">{apiErrorMessage(preference.error)}</p>}</>;
}
export function MyTrainingSocial(){
 const query=useTraining();const action=useAction();
 if(query.isPending)return <p role="status">Cargando toques y rachas…</p>;
 if(query.isError)return <p className="alert error">{apiErrorMessage(query.error)}</p>;
 if(!query.data.available)return null;const d=query.data;
 return <section className="profile-training"><div className="panel-title"><div><h2>Entrenen juntos</h2><p>Toques y rachas entre amigos.</p></div><Users/></div><h3>Rachas compartidas</h3><p>La racha cuenta semanas consecutivas cuando ambos cumplen su meta con días distintos de asistencia general válida. Empieza el lunes siguiente a la aceptación. No necesitas coincidir en horario; clases y botones no suman asistencias.</p>
 {!d.streaks.length&&<p>Visita el perfil de un amigo, envíale un toque e invítalo a entrenar con constancia.</p>}
 <div className="friend-list">{d.streaks.map(s=><article key={s.id}><div><strong><Flame/> Racha juntos</strong>{s.canContinue?<><Link to={`/portal/community/${s.targetId}`}>Ver perfil del amigo</Link><p>Tu meta: {s.myTarget} días por semana · Su meta: {s.friendTarget}.</p>{s.status==='active'&&<><p>Inicio: {s.startsOn} · {s.currentWeeks} semanas de racha · Récord: {s.bestWeeks}.</p><small>Semana en curso: tú {s.myVisits}/{s.myTarget} · tu amigo {s.friendVisits}/{s.friendTarget}.</small></>}</>:<p>Pausada: revisen amistad, visibilidad y consentimiento. No mostramos asistencias del otro miembro.</p>}</div><div className="friend-actions">{s.status==='active'?<button className="ghost" disabled={action.isPending} onClick={()=>{if(confirm('¿Finalizar esta racha compartida? No modifica tus asistencias ni tu racha personal.'))action.mutate({targetMemberId:s.targetId,action:'end'});}}>Finalizar racha</button>:s.direction==='outgoing'?<><span>Invitación enviada</span><button className="ghost" disabled={action.isPending} onClick={()=>action.mutate({targetMemberId:s.targetId,action:'cancel'})}>Cancelar</button></>:<><button className="primary" disabled={action.isPending||!s.canContinue} onClick={()=>action.mutate({targetMemberId:s.targetId,action:'accept'})}>Aceptar meta e iniciar</button><button className="ghost" disabled={action.isPending} onClick={()=>action.mutate({targetMemberId:s.targetId,action:'reject'})}>Rechazar</button></>}</div></article>)}</div>
 {action.isError&&<p className="alert error">{apiErrorMessage(action.error)}</p>}
 </section>;
}
