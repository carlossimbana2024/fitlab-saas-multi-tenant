import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Activity, Flame, Heart, Medal, Save, Trash2, Upload } from 'lucide-react';
import { api, apiErrorMessage } from '../services/api';
import { MemberFriendshipActions } from './MemberFriendships';
import '../social-profile.css';

type Badge={badge_code:string;earned_at:string;loyalty_badges:{name:string;description:string}};
type Profile={id:string;own:boolean;name:string;avatarUrl:string|null;bio:string;gallery:Array<string|null>;communityVisible:boolean;showGallery:boolean;showBadges:boolean;goalType:string|null;progressPercent?:number|null;streak:{current_streak:number;longest_streak:number}|null;monthlyAttendances:number|null;badges:Badge[];loveCount:number;loved:boolean};
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
export function MemberSocialProfile({memberId}:{memberId?:string}) {
 const client=useQueryClient();const path=memberId?`/members/me/community/profiles/${memberId}`:'/members/me/social-profile';
 const query=useQuery({queryKey:['member-social-profile',memberId??'me'],queryFn:async()=>(await api.get<{profile:Profile}>(path)).data.profile,refetchInterval:240000});
 const [form,setForm]=useState({bio:'',showGallery:false,showBadges:false});const [preview,setPreview]=useState<string|null>(null);
 useEffect(()=>{if(query.data)setForm({bio:query.data.bio,showGallery:query.data.showGallery,showBadges:query.data.showBadges});},[query.data?.bio,query.data?.showGallery,query.data?.showBadges]);
 const refresh=async()=>{await Promise.all(['member-social-profile','member-community'].map(key=>client.invalidateQueries({queryKey:[key]})));};
 const save=useMutation({mutationFn:()=>api.put('/members/me/social-profile',form),onSuccess:refresh});
 const photo=useMutation({mutationFn:async({slot,file}:{slot:number;file:File|null})=>{
  if(!file)return api.put('/members/me/gallery',{slot,path:null});
  const blob=await optimizedPhoto(file);
  const prepared=(await api.post<{upload:{signedUrl:string;path:string}}>('/members/me/gallery-upload',{contentType:blob.type})).data.upload;
  const uploaded=await fetch(prepared.signedUrl,{method:'PUT',headers:{'content-type':blob.type,'x-upsert':'false'},body:blob});
  if(!uploaded.ok)throw new Error('No se pudo subir la foto. Intenta nuevamente.');
  return api.put('/members/me/gallery',{slot,path:prepared.path});
 },onSuccess:refresh});
 const love=useMutation({mutationFn:()=>api.post('/members/me/community/reactions',{targetMemberUserId:memberId,reactionType:'love'}),onSuccess:refresh});
 if(query.isPending)return <section className="panel" role="status">Cargando perfil social…</section>;
 if(query.isError)return <section className="panel"><p className="alert error">{apiErrorMessage(query.error)}</p><button className="ghost" onClick={()=>void query.refetch()}>Reintentar</button></section>;
 const p=query.data;
 return <section className="panel social-profile">
  {!p.own&&<div className="social-identity">{p.avatarUrl&&<img src={p.avatarUrl} alt={`Foto de ${p.name}`}/>}<div><p className="eyebrow">COMUNIDAD FITLAB</p><h1>{p.name}</h1>{p.bio&&<p>{p.bio}</p>}</div></div>}
  {p.own&&<><div className="panel-title"><div><h2>Tu identidad fitness</h2><p>Bio, momentos y logros. Tú eliges qué compartir.</p></div><Medal/></div><p className="form-note">{p.communityVisible?'Tu perfil es visible para miembros de tu gimnasio.':'Tu perfil está oculto en Comunidad. Actívalo en la configuración de privacidad de tu encuesta si deseas compartirlo.'}</p></>}
  <div className="social-stats">{p.monthlyAttendances!==null&&<span><Activity/><strong>{p.monthlyAttendances}</strong> visitas este mes</span>}{p.streak&&<span><Flame/><strong>{p.streak.current_streak}</strong> días de racha</span>}<span><Heart/><strong>{p.loveCount}</strong> Me encanta</span></div>
  {p.progressPercent!=null&&<p>Avance hacia tu objetivo: <strong>{p.progressPercent}%</strong></p>}
  {p.own&&<form className="social-form" onSubmit={e=>{e.preventDefault();save.mutate();}}><label>Tu bio<textarea maxLength={160} rows={3} value={form.bio} onChange={e=>setForm({...form,bio:e.target.value})} placeholder="Entrenando para ser mi mejor versión 💪"/><small>{form.bio.length}/160 caracteres</small></label><label className="social-checkbox"><input type="checkbox" checked={form.showGallery} onChange={e=>setForm({...form,showGallery:e.target.checked})}/>Compartir mi galería en Comunidad</label><label className="social-checkbox"><input type="checkbox" checked={form.showBadges} onChange={e=>setForm({...form,showBadges:e.target.checked})}/>Compartir mis medallas en Comunidad</label><button className="primary" disabled={save.isPending}><Save/>{save.isPending?'Guardando…':'Guardar perfil social'}</button>{save.isSuccess&&<p role="status">Perfil guardado.</p>}</form>}
  {(p.own||p.gallery.some(Boolean))&&<><h3>Momentos de entrenamiento</h3><div className="social-gallery">{p.gallery.map((url,slot)=><div key={slot} className="social-photo">{url?<button className="social-photo-preview" type="button" onClick={()=>setPreview(url)} aria-label={`Ampliar foto ${slot+1}`}><img src={url} alt={`Momento de entrenamiento ${slot+1}`} loading="lazy"/></button>:<div className="social-photo-empty"><Upload/><span>Foto {slot+1}</span></div>}{p.own&&<div className="social-photo-actions"><label className="small-button" aria-disabled={photo.isPending}><Upload/>{url?'Cambiar':'Agregar'}<input type="file" accept="image/jpeg,image/png,image/webp" disabled={photo.isPending} onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)photo.mutate({slot,file});}}/></label>{url&&<button className="small-button" aria-label={`Eliminar foto ${slot+1}`} disabled={photo.isPending} onClick={()=>{if(confirm('¿Eliminar esta foto de tu galería?'))photo.mutate({slot,file:null});}}><Trash2/></button>}</div>}</div>)}</div>{p.own&&<small>Hasta 3 fotos · JPG, PNG o WEBP · máximo 5 MB por archivo. {photo.isPending?'Procesando y subiendo…':''}</small>}</>}
  {p.badges.length>0&&<><h3>Medallas ganadas</h3><ProfileBadges badges={p.badges}/></>}
  {!p.own&&<button className={p.loved?'primary':'ghost'} disabled={love.isPending} aria-pressed={p.loved} onClick={()=>love.mutate()}><Heart/>{p.loved?'Quitar Me encanta':'Me encanta'}</button>}
  {!p.own&&<MemberFriendshipActions memberId={p.id}/>}
  {[save.error,photo.error,love.error].filter(Boolean).map((error,i)=><p key={i} className="alert error" role="alert">{apiErrorMessage(error)}</p>)}
  {preview&&<div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Foto ampliada" onClick={()=>setPreview(null)} onKeyDown={e=>{if(e.key==='Escape')setPreview(null);}}><div className="social-preview"><button className="ghost" autoFocus onClick={()=>setPreview(null)}>Cerrar foto</button><img src={preview} alt="Foto de entrenamiento ampliada"/></div></div>}
 </section>;
}
export function MemberPublicProfilePage(){const {memberId}=useParams();return <><Link className="ghost" to="/portal/community">Volver a Comunidad</Link><MemberSocialProfile memberId={memberId}/></>;}
