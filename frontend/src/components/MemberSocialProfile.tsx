import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Heart, Pencil, Plus, Settings, Trash2, Upload, Users } from 'lucide-react';
import { api, apiErrorMessage } from '../services/api';
import { MemberFriendshipActions, useFriendSummary } from './MemberFriendships';
import { ProfileHeader } from './ProfileHeader';
import { ProfilePhotoViewer } from './ProfilePhotoViewer';
import { ProfileDialog } from './ProfileDialog';
import { ProfileTabs } from './ProfileTabs';
import { PrivacySwitch } from './PrivacySwitch';
import { Medal } from 'lucide-react';
import '../social-profile.css';

type Badge={badge_code:string;earned_at:string;loyalty_badges:{name:string;description:string}};
type Profile={id:string;own:boolean;name:string;avatarUrl:string|null;bio:string;gallery:Array<string|null>;communityVisible:boolean;showGallery:boolean;showBadges:boolean;goalType:string|null;progressPercent?:number|null;streak:{current_streak:number;longest_streak:number}|null;monthlyAttendances:number|null;badges:Badge[];loveCount:number;loved:boolean};
function useSocialProfile(memberId?:string){return useQuery({queryKey:['member-social-profile',memberId??'me'],queryFn:async()=>(await api.get<{profile:Profile}>(memberId?`/members/me/community/profiles/${memberId}`:'/members/me/social-profile')).data.profile,refetchInterval:240000});}
export function SocialPrivacySettings(){
 const query=useSocialProfile();const client=useQueryClient();
 const save=useMutation({mutationFn:(change:{showGallery?:boolean;showBadges?:boolean})=>api.put('/members/me/social-profile',change),onSettled:()=>Promise.all(['member-social-profile','member-community'].map(key=>client.invalidateQueries({queryKey:[key]})))});
 if(query.isPending)return <p role="status">Cargando privacidad social…</p>;
 if(query.isError)return <p className="alert error">{apiErrorMessage(query.error)}</p>;
 return <>{(['showGallery','showBadges'] as const).map(key=><PrivacySwitch key={key} label={key==='showGallery'?'Compartir momentos':'Mostrar mis medallas'} disabled={save.isPending} checked={save.isPending&&key in save.variables?Boolean(save.variables[key]):query.data[key]} onChange={value=>save.mutate({[key]:value})}/>)}{save.isSuccess&&<small role="status">✓ Guardado</small>}{save.isError&&<p className="alert error" role="alert">{apiErrorMessage(save.error)}</p>}</>;
}
export function ProfileBadges({badges}:{badges:Badge[]}) {
 return <div className="social-badges">{badges.map(b=><span key={b.badge_code} title={b.loyalty_badges.description}><Medal/>{b.loyalty_badges.name}</span>)}</div>;
}
async function optimizedPhoto(file:File):Promise<Blob> {
 if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>5242880)throw new Error('Selecciona una imagen JPG, PNG o WEBP de hasta 5 MB.');
 const bitmap=await createImageBitmap(file);
 try {
  const scale=Math.min(1,1600/Math.max(bitmap.width,bitmap.height));
  const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
  const ctx=canvas.getContext('2d');if(!ctx)throw new Error('No se pudo preparar la imagen.');ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
  return await new Promise<Blob>((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('No se pudo comprimir la imagen.')),'image/webp',0.85));
 } finally {bitmap.close();}
}
type OwnerControls={name:string;avatarUrl:string|null;onEditAccount:()=>void;onAvatarFile:(file:File)=>void;avatarUploading:boolean;avatarError:unknown;activity:ReactNode};
export function MemberSocialProfile({memberId,owner}:{memberId?:string;owner?:OwnerControls}) {
 const client=useQueryClient();const query=useSocialProfile(memberId);const friends=useFriendSummary(!memberId);
 const [bio,setBio]=useState('');const [editing,setEditing]=useState(false);const [allBadges,setAllBadges]=useState(false);const [deleteSlot,setDeleteSlot]=useState<number|null>(null);const [preview,setPreview]=useState<string|null>(null);const avatarInput=useId();
 const [params,setParams]=useSearchParams();const tab=['moments','badges','activity'].includes(params.get('tab')??'')?params.get('tab')!:'moments';
 const refresh=async()=>{await Promise.all(['member-social-profile','member-community'].map(key=>client.invalidateQueries({queryKey:[key]})));};
 const save=useMutation({mutationFn:()=>api.put('/members/me/social-profile',{bio}),onSuccess:async()=>{await refresh();setEditing(false);}});
 const photo=useMutation({mutationFn:async({slot,file}:{slot:number;file:File|null})=>{
  if(!file)return api.put('/members/me/gallery',{slot,path:null});
  const blob=await optimizedPhoto(file);
  const prepared=(await api.post<{upload:{signedUrl:string;path:string}}>('/members/me/gallery-upload',{contentType:blob.type})).data.upload;
  const uploaded=await fetch(prepared.signedUrl,{method:'PUT',headers:{'content-type':blob.type,'x-upsert':'false'},body:blob});
  if(!uploaded.ok)throw new Error('No se pudo subir la foto. Intenta nuevamente.');
  return api.put('/members/me/gallery',{slot,path:prepared.path});
 },onSuccess:async()=>{await refresh();setDeleteSlot(null);}});
 const love=useMutation({mutationFn:()=>api.post('/members/me/community/reactions',{targetMemberUserId:memberId,reactionType:'love'}),onSuccess:refresh});
 if(query.isPending)return <section className="panel" role="status">Cargando perfil social…</section>;
 if(query.isError)return <section className="panel"><p className="alert error">{apiErrorMessage(query.error)}</p><button className="ghost" onClick={()=>void query.refetch()}>Reintentar</button>{!memberId&&<div className="profile-quick-links"><Link to="/portal/settings">Configuración</Link><Link to="/portal/payments">Membresía y pagos</Link></div>}</section>;
 const p=query.data;
 const tabs=[{id:'moments',label:'Momentos'},{id:'badges',label:'Medallas'},{id:'activity',label:'Actividad'}];
 const moments=<ProfileMoments gallery={p.gallery} own={p.own} pending={photo.isPending} error={photo.error} onPreview={setPreview} onFile={(slot,file)=>photo.mutate({slot,file})} onDelete={setDeleteSlot}/>;
 return <section className="panel social-profile profile-social-shell">
  <ProfileHeader profile={owner?{...p,name:owner.name,avatarUrl:owner.avatarUrl??p.avatarUrl}:p} shareUrl={p.own&&p.communityVisible?`${window.location.origin}/portal/community/${p.id}`:undefined} actions={p.own?<><button type="button" className="ghost" onClick={()=>{setBio(p.bio);save.reset();setEditing(true);}}><Pencil/>Editar perfil</button><Link className="ghost" to="/portal/settings" aria-label="Configuración"><Settings/></Link></>:<><button className={p.loved?'primary':'ghost'} disabled={love.isPending} aria-pressed={p.loved} onClick={()=>love.mutate()}><Heart/>{p.loved?'Quitar Me encanta':'Me encanta'}</button><MemberFriendshipActions memberId={p.id}/></>}/>
  {p.own&&<div className="profile-quick-links">{friends.data?.available&&<Link to="/portal/friends"><Users/>{friends.data.counts?`${friends.data.counts.friends} amigos`:'Mis amigos'}{Boolean(friends.data.counts?.incoming)&&<span className="badge">{friends.data.counts!.incoming} solicitudes</span>}</Link>}<Link to="/portal/payments">Membresía y pagos →</Link></div>}
  {p.own&&!p.communityVisible&&<p className="form-note">Tu perfil está oculto en Comunidad. <Link to="/portal/settings">Configurar privacidad</Link></p>}
  {save.isSuccess&&<small role="status">✓ Perfil guardado</small>}
  <ProfileTabs label="Contenido del perfil" tabs={tabs} selected={tab} onSelect={value=>setParams(current=>{current.set('tab',value);return current;},{replace:true})}/>
  <div className="profile-tab-content" role="tabpanel" aria-label={tabs.find(item=>item.id===tab)!.label}>
   {tab==='moments'&&moments}
   {tab==='badges'&&(p.badges.length?<><ProfileBadges badges={allBadges?p.badges:p.badges.slice(0,6)}/>{p.badges.length>6&&<button className="ghost" onClick={()=>setAllBadges(!allBadges)}>{allBadges?'Ver menos':'Ver todas'}</button>}</>:<p>{p.own?'Tus logros aparecerán aquí.':'Este perfil no tiene medallas visibles.'}</p>)}
   {tab==='activity'&&(p.own&&owner?owner.activity:<><h2>Actividad fitness</h2>{p.goalType&&<p>Objetivo: {goalLabel(p.goalType)}</p>}{p.progressPercent!=null&&<p>Avance hacia su objetivo: {p.progressPercent}%</p>}{!p.goalType&&p.progressPercent==null&&<p>No hay más actividad compartida.</p>}</>)}
  </div>
  {love.isError&&<p className="alert error" role="alert">{apiErrorMessage(love.error)}</p>}
  {editing&&p.own&&<ProfileDialog title="Editar perfil" onClose={()=>setEditing(false)} busy={save.isPending||photo.isPending||owner?.avatarUploading}><form className="social-form" onSubmit={event=>{event.preventDefault();save.mutate();}}><label>Tu bio<textarea maxLength={160} rows={3} value={bio} onChange={event=>setBio(event.target.value)} placeholder="Cuenta qué te motiva a entrenar"/><small>{bio.length}/160 caracteres</small></label>{owner&&<><div className="profile-edit-actions"><button type="button" className="ghost" disabled={owner.avatarUploading} onClick={()=>document.getElementById(avatarInput)?.click()}><Upload/>{owner.avatarUploading?'Subiendo…':'Cambiar foto'}</button><button type="button" className="ghost" onClick={()=>{setEditing(false);owner.onEditAccount();}}>Nombre y datos de cuenta</button></div><input id={avatarInput} type="file" hidden accept="image/jpeg,image/png,image/webp" disabled={owner.avatarUploading} onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)owner.onAvatarFile(file);}}/>{owner.avatarError!=null&&<p className="alert error">{apiErrorMessage(owner.avatarError)}</p>}</>}<h3>Momentos</h3>{moments}{save.isError&&<p className="alert error" role="alert">{apiErrorMessage(save.error)}</p>}<div className="modal-actions"><button type="button" className="ghost" disabled={save.isPending||photo.isPending||owner?.avatarUploading} onClick={()=>setEditing(false)}>Cancelar</button><button className="primary" disabled={save.isPending||photo.isPending||owner?.avatarUploading}>{save.isPending?'Guardando…':'Guardar cambios'}</button></div></form><p className="form-note">La foto y los momentos se guardan al subirlos; Guardar cambios aplica la bio.</p></ProfileDialog>}
  {deleteSlot!==null&&<ProfileDialog title="Eliminar momento" onClose={()=>setDeleteSlot(null)} busy={photo.isPending}><p>¿Eliminar esta foto de tus momentos?</p>{photo.isError&&<p className="alert error">{apiErrorMessage(photo.error)}</p>}<div className="modal-actions"><button className="ghost" disabled={photo.isPending} onClick={()=>setDeleteSlot(null)}>Cancelar</button><button className="primary" disabled={photo.isPending} onClick={()=>photo.mutate({slot:deleteSlot,file:null})}>{photo.isPending?'Eliminando…':'Eliminar foto'}</button></div></ProfileDialog>}
  {preview&&<ProfilePhotoViewer src={preview} name={`Momento de ${p.name}`} onClose={()=>setPreview(null)}/>}
 </section>;
}
function ProfileMoments({gallery,own,pending,error,onPreview,onFile,onDelete}:{gallery:Array<string|null>;own:boolean;pending:boolean;error:unknown;onPreview:(url:string)=>void;onFile:(slot:number,file:File)=>void;onDelete:(slot:number)=>void}){
 const id=useId();
 return <>{!gallery.some(Boolean)&&<p>{own?'Comparte tu primer momento.':'Este miembro no comparte momentos.'}</p>}{(own||gallery.some(Boolean))&&<div className="social-gallery profile-moments">{gallery.map((url,slot)=><div className="social-photo" key={slot}>{url?<button type="button" className="social-photo-preview" aria-label={`Ampliar foto ${slot+1}`} onClick={()=>onPreview(url)}><img src={url} alt={`Momento de entrenamiento ${slot+1}`} loading="lazy"/></button>:own?<button type="button" className="social-photo-empty" disabled={pending} aria-label={`Agregar momento ${slot+1}`} onClick={()=>document.getElementById(`${id}-${slot}`)?.click()}><Plus/></button>:<div className="social-photo-empty" aria-label="Sin foto"/>}{own&&<><input hidden id={`${id}-${slot}`} type="file" accept="image/jpeg,image/png,image/webp" disabled={pending} onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)onFile(slot,file);}}/>{url&&<div className="profile-moment-controls"><button type="button" aria-label={`Reemplazar momento ${slot+1}`} disabled={pending} onClick={()=>document.getElementById(`${id}-${slot}`)?.click()}><Upload/></button><button type="button" aria-label={`Eliminar momento ${slot+1}`} disabled={pending} onClick={()=>onDelete(slot)}><Trash2/></button></div>}</>}</div>)}</div>}{own&&<small className="form-note" role={pending?'status':undefined}>{pending?'Procesando y subiendo…':'Hasta 3 fotos · JPG, PNG o WEBP · máximo 5 MB.'}</small>}{error!=null&&<p className="alert error" role="alert">{apiErrorMessage(error)}</p>}</>;
}
export function goalLabel(goal:string){return ({lose_weight:'Perder peso',gain_weight:'Ganar peso',build_muscle:'Desarrollar músculo',improve_fitness:'Mejorar condición física',maintain_weight:'Mantener peso',general_wellness:'Bienestar general'} as Record<string,string>)[goal]??'Objetivo fitness';}
export function MemberPublicProfilePage(){const {memberId}=useParams();return <><Link className="ghost" to="/portal/community">Volver a Comunidad</Link><MemberSocialProfile memberId={memberId}/></>;}
