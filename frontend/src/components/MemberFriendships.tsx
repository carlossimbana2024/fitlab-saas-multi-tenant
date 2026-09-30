import { useMutation,useQuery,useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check,UserPlus,Users,X } from 'lucide-react';
import { api,apiErrorMessage } from '../services/api';
import '../social-profile.css';

type Action='request'|'accept'|'reject'|'cancel'|'remove';
type Relationship={id:string;targetId:string;name:string;viewable:boolean;status:'pending'|'accepted';direction:'incoming'|'outgoing'};
function useFriendActions(){
 const client=useQueryClient();return useMutation({mutationFn:({targetMemberId,action}:{targetMemberId:string;action:Action})=>api.post('/members/me/friends',{targetMemberId,action}),onSettled:async()=>{await Promise.all(['member-friends','member-friendship','loyalty-engagement'].map(key=>client.invalidateQueries({queryKey:[key]})));}});
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
 </div>;
}
export function MyFriendships(){
 const [page,setPage]=useState(0);const client=useQueryClient();const action=useFriendActions();
 const query=useQuery({queryKey:['member-friends',page],queryFn:async()=>(await api.get<{available:boolean;allowRequests:boolean;total:number;relationships:Relationship[]}>('/members/me/friends',{params:{page}})).data,refetchInterval:30000});
 const preference=useMutation({mutationFn:(allowRequests:boolean)=>api.put('/members/me/friend-preferences',{allowRequests}),onSuccess:async()=>{await Promise.all(['member-friends','member-friendship'].map(key=>client.invalidateQueries({queryKey:[key]})));}});
 if(query.isPending)return <section className="panel" role="status">Cargando amigos…</section>;
 if(query.isError)return <section className="panel"><p className="alert error">{apiErrorMessage(query.error)}</p><button className="ghost" onClick={()=>void query.refetch()}>Reintentar</button></section>;
 if(!query.data.available)return null;
 const allowRequests=preference.isPending?Boolean(preference.variables):query.data.allowRequests;
 const act=(targetMemberId:string,kind:Action)=>action.mutate({targetMemberId,action:kind});
 return <section className="panel social-profile"><div className="panel-title"><div><h2>Amigos y solicitudes</h2><p>Conecta con miembros de tu gimnasio.</p></div><Users/></div>
  <label className="social-checkbox"><input type="checkbox" disabled={preference.isPending} checked={allowRequests} onChange={e=>preference.mutate(e.target.checked)}/>Permitir solicitudes de amistad</label><p className="form-note">También debes activar “Aparecer en Comunidad” en tu encuesta. Desactivar solicitudes evita nuevas conexiones; no elimina amistades existentes.</p>
  {query.data.relationships.length===0&&<p>Aún no tienes amistades ni solicitudes pendientes. Visita Comunidad para descubrir otros perfiles.</p>}
  <div className="friend-list">{query.data.relationships.map(r=><article key={r.id}><div>{r.viewable?<Link to={`/portal/community/${r.targetId}`}><strong>{r.name}</strong></Link>:<strong>{r.name}</strong>}<small>{r.status==='accepted'?'Amigos':r.direction==='incoming'?'Solicitud recibida':'Solicitud enviada'}</small></div><div className="friend-actions">{r.status==='accepted'?<button className="ghost" disabled={action.isPending} onClick={()=>{if(confirm('¿Eliminar esta amistad?'))act(r.targetId,'remove');}}>Eliminar</button>:r.direction==='outgoing'?<button className="ghost" disabled={action.isPending} onClick={()=>act(r.targetId,'cancel')}>Cancelar</button>:<><button className="primary" disabled={action.isPending||!query.data.allowRequests||!r.viewable} onClick={()=>act(r.targetId,'accept')}>Aceptar</button><button className="ghost" disabled={action.isPending} onClick={()=>act(r.targetId,'reject')}>Rechazar</button></>}</div></article>)}</div>
  {(page>0||query.data.total>25)&&<div className="friend-actions"><button className="ghost" disabled={page===0} onClick={()=>setPage(page-1)}>Anterior</button><span>Página {page+1}</span><button className="ghost" disabled={(page+1)*25>=query.data.total} onClick={()=>setPage(page+1)}>Siguiente</button></div>}
  {[action.error,preference.error].filter(Boolean).map((error,i)=><p key={i} className="alert error" role="alert">{apiErrorMessage(error)}</p>)}
 </section>;
}
