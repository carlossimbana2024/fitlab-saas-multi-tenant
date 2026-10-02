import { useMutation,useQuery,useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check,UserPlus,Users,X } from 'lucide-react';
import { api,apiErrorMessage } from '../services/api';
import {TrainingFriendActions} from './MemberTrainingSocial';
import {PrivacySwitch} from './PrivacySwitch';
import {ProfileTabs} from './ProfileTabs';
import '../social-profile.css';

type Action='request'|'accept'|'reject'|'cancel'|'remove';
type Relationship={id:string;targetId:string;name:string;avatarUrl?:string|null;viewable:boolean;status:'pending'|'accepted';direction:'incoming'|'outgoing'};
type FriendsData={available:boolean;allowRequests:boolean;total:number;counts?:{friends:number;incoming:number;outgoing:number};relationships:Relationship[]};
export function useFriendSummary(enabled=true){return useQuery({queryKey:['member-friends',0,'all'],queryFn:async()=>(await api.get<FriendsData>('/members/me/friends',{params:{page:0,filter:'all'}})).data,refetchInterval:30000,enabled});}
export function FriendRequestsPreference(){
 const query=useFriendSummary();const client=useQueryClient();
 const preference=useMutation({mutationFn:(allowRequests:boolean)=>api.put('/members/me/friend-preferences',{allowRequests}),onSettled:()=>Promise.all(['member-friends','member-friendship'].map(key=>client.invalidateQueries({queryKey:[key]})))});
 if(query.isPending)return <p role="status">Cargando privacidad de amistades…</p>;
 if(query.isError)return <p className="alert error">{apiErrorMessage(query.error)}</p>;
 if(!query.data.available)return null;
 return <><PrivacySwitch label="Permitir solicitudes de amistad" disabled={preference.isPending} checked={preference.isPending?Boolean(preference.variables):query.data.allowRequests} onChange={value=>preference.mutate(value)}/><p className="form-note">Ambos deben aparecer en Comunidad. Desactivarlo no elimina tus amigos.</p>{preference.isSuccess&&<small role="status">✓ Guardado</small>}{preference.isError&&<p className="alert error" role="alert">{apiErrorMessage(preference.error)}</p>}</>;
}
function useFriendActions(){
 const client=useQueryClient();return useMutation({mutationFn:({targetMemberId,action}:{targetMemberId:string;action:Action})=>api.post('/members/me/friends',{targetMemberId,action}),onSettled:async()=>{await Promise.all(['member-friends','member-friendship','member-training-social','loyalty-engagement'].map(key=>client.invalidateQueries({queryKey:[key]})));}});
}
export function MemberFriendshipActions({memberId}:{memberId:string}){
 const query=useQuery({queryKey:['member-friendship',memberId],queryFn:async()=>(await api.get<{available:boolean;canRequest:boolean;status:string;direction:string}>(`/members/me/friends/${memberId}`)).data,refetchInterval:30000});
 const action=useFriendActions();const r=query.data;
 if(query.isPending)return <p role="status">Consultando amistad…</p>;
 if(query.isError)return <p className="alert error">{apiErrorMessage(query.error)}</p>;
 if(!r?.available)return null;
 const act=(kind:Action)=>action.mutate({targetMemberId:memberId,action:kind});
 return <div className="friend-actions">
  {r.status==='accepted'?<><span><Users/>Amigos</span><button className="ghost" disabled={action.isPending} onClick={()=>{if(confirm('¿Eliminar esta amistad?'))act('remove');}}>Eliminar amistad</button></>:
   r.status==='pending'&&r.direction==='outgoing'?<><span>Solicitud enviada</span><button className="ghost" disabled={action.isPending} onClick={()=>act('cancel')}>Cancelar solicitud</button></>:
   r.status==='pending'?<><span>Solicitud recibida</span><button className="primary" disabled={action.isPending||!r.canRequest} onClick={()=>act('accept')}><Check/>Aceptar</button><button className="ghost" disabled={action.isPending} onClick={()=>act('reject')}><X/>Rechazar</button></>:
   r.canRequest?<button className="primary" disabled={action.isPending} onClick={()=>act('request')}><UserPlus/>Agregar amigo</button>:<p className="form-note">Para conectar, ambos deben aparecer en Comunidad y permitir solicitudes en su perfil.</p>}
  {action.isError&&<p className="alert error" role="alert">{apiErrorMessage(action.error)}</p>}
  {r.status==='accepted'&&<TrainingFriendActions memberId={memberId}/>}
 </div>;
}
export function MyFriendships(){
 const [page,setPage]=useState(0);const [filter,setFilter]=useState('friends');const action=useFriendActions();
 const query=useQuery({queryKey:['member-friends',page,filter],queryFn:async()=>(await api.get<FriendsData>('/members/me/friends',{params:{page,filter}})).data,refetchInterval:30000});
 if(query.isPending)return <section className="panel" role="status">Cargando amigos…</section>;
 if(query.isError)return <section className="panel"><p className="alert error">{apiErrorMessage(query.error)}</p><button className="ghost" onClick={()=>void query.refetch()}>Reintentar</button></section>;
 if(!query.data.available)return null;
 const act=(targetMemberId:string,kind:Action)=>action.mutate({targetMemberId,action:kind});
 return <section className="panel social-profile"><div className="panel-title"><div><h1>Amigos</h1><p>Conecta con miembros de tu gimnasio.</p></div><Users/></div>
  <ProfileTabs label="Amistades" selected={filter} onSelect={value=>{setFilter(value);setPage(0);}} tabs={[{id:'friends',label:`Amigos (${query.data.counts?.friends??0})`},{id:'incoming',label:`Solicitudes (${query.data.counts?.incoming??0})`},{id:'outgoing',label:`Enviadas (${query.data.counts?.outgoing??0})`}]}/>
  <Link className="small-button" to="/portal/settings">Configurar privacidad</Link>
  {query.data.relationships.length===0&&<p>{filter==='friends'?'Conecta con miembros de tu gimnasio.':filter==='incoming'?'No tienes solicitudes pendientes.':'No tienes solicitudes enviadas.'} <Link to="/portal/community">Explorar Comunidad</Link></p>}
  <div className="friend-list" role="tabpanel" aria-label={filter==='friends'?'Amigos':filter==='incoming'?'Solicitudes':'Enviadas'}>{query.data.relationships.map(r=><article key={r.id}><div className="profile-friend-person">{r.avatarUrl&&<img src={r.avatarUrl} alt={`Foto de ${r.name}`} loading="lazy"/>}<div>{r.viewable?<Link to={`/portal/community/${r.targetId}`}><strong>{r.name}</strong></Link>:<strong>{r.name}</strong>}<small>{r.status==='accepted'?'Amigos':r.direction==='incoming'?'Solicitud recibida':'Solicitud enviada'}</small></div></div><div className="friend-actions">{r.status==='accepted'?<button className="ghost" disabled={action.isPending} onClick={()=>{if(confirm('¿Eliminar esta amistad?'))act(r.targetId,'remove');}}>Eliminar</button>:r.direction==='outgoing'?<button className="ghost" disabled={action.isPending} onClick={()=>act(r.targetId,'cancel')}>Cancelar</button>:<><button className="primary" disabled={action.isPending||!query.data.allowRequests||!r.viewable} onClick={()=>act(r.targetId,'accept')}>Aceptar</button><button className="ghost" disabled={action.isPending} onClick={()=>act(r.targetId,'reject')}>Rechazar</button></>}</div></article>)}</div>
  {(page>0||query.data.total>25)&&<div className="friend-actions"><button className="ghost" disabled={page===0} onClick={()=>setPage(page-1)}>Anterior</button><span>Página {page+1}</span><button className="ghost" disabled={(page+1)*25>=query.data.total} onClick={()=>setPage(page+1)}>Siguiente</button></div>}
  {action.isError&&<p className="alert error" role="alert">{apiErrorMessage(action.error)}</p>}
 </section>;
}
