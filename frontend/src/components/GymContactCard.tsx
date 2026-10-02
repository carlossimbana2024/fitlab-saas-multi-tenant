import { useQuery } from '@tanstack/react-query';
import { Mail, MapPin, MessageCircle, Phone } from 'lucide-react';
import { api, apiErrorMessage } from '../services/api';
type Contact={name:string;address?:string|null;city?:string;phone?:string|null;whatsapp_phone?:string|null;email?:string|null};
export function GymContactCard(){
 const date=new Date().toISOString().slice(0,10);
 const query=useQuery({queryKey:['member-gym-contact',date],queryFn:async()=>(await api.get<{gym:Contact;location:Contact}>('/calendar',{params:{from:date,to:date}})).data});
 if(query.isPending)return <section className="panel" role="status">Cargando contacto del gimnasio…</section>;
 if(query.isError)return <section className="panel"><p className="alert error">{apiErrorMessage(query.error)}</p><button className="ghost" onClick={()=>void query.refetch()}>Reintentar contacto</button></section>;
 const {gym,location}=query.data;const phone=location.phone??gym.phone;const email=location.email??gym.email;const whatsapp=(location.whatsapp_phone??gym.whatsapp_phone)?.replace(/\D/g,'').replace(/^0/,'593');
 return <section className="panel"><h2>Contacta al gimnasio</h2><p>{gym.name} · {location.name}</p><div className="contact-info"><span><MapPin/>{location.address?`${location.address}, ${location.city??''}`:location.city??'Dirección no configurada'}</span>{phone&&<a href={`tel:${phone}`}><Phone/>Llamar</a>}{whatsapp&&<a href={`https://wa.me/${whatsapp}`} target="_blank" rel="noreferrer"><MessageCircle/>WhatsApp</a>}{email&&<a href={`mailto:${email}`}><Mail/>Correo</a>}</div></section>;
}
