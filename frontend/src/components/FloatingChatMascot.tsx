import { useEffect, useRef, useState } from 'react';
import { Bot } from 'lucide-react';

type Connection = { saveData?: boolean; effectiveType?: string; addEventListener?: (type: string, listener: () => void) => void; removeEventListener?: (type: string, listener: () => void) => void };
const poster='/assets/chat/fitlab-robot.webp';
function supportedVideo(){const test=document.createElement('video');return test.canPlayType('video/webm; codecs="vp9"')?'/assets/chat/fitlab-robot.webm':test.canPlayType('video/mp4')?'/assets/chat/fitlab-robot.mp4':null;}
export function FloatingChatMascot({ animate }: { animate: boolean }) {
  const [eligible,setEligible]=useState(false);const [failed,setFailed]=useState(false);const [playing,setPlaying]=useState(false);const [imageFailed,setImageFailed]=useState(false);const [source]=useState(supportedVideo);const video=useRef<HTMLVideoElement>(null);
  useEffect(()=>{
    const motion=window.matchMedia('(prefers-reduced-motion: reduce)');const connection=(navigator as Navigator&{connection?:Connection}).connection;
    const update=()=>setEligible(animate&&!motion.matches&&!connection?.saveData&&!['slow-2g','2g'].includes(connection?.effectiveType??'')&&document.visibilityState==='visible');
    // Defer the tiny animation until the initial UI has painted; the poster is immediate.
    const timer=window.setTimeout(update,350);motion.addEventListener('change',update);connection?.addEventListener?.('change',update);document.addEventListener('visibilitychange',update);
    return()=>{clearTimeout(timer);motion.removeEventListener('change',update);connection?.removeEventListener?.('change',update);document.removeEventListener('visibilitychange',update);};
  },[animate]);
  const showVideo=eligible&&animate&&!failed&&Boolean(source);
  useEffect(()=>{setPlaying(false);let active=true;if(showVideo)void video.current?.play().catch(()=>{if(active)setFailed(true);});return()=>{active=false;};},[showVideo]);
  return <span className="chat-mascot-media" aria-hidden="true">{imageFailed?<Bot/>:<img src={poster} alt="" width={180} height={320} decoding="async" onError={()=>setImageFailed(true)}/>}{showVideo&&<video ref={video} src={source!} className={playing?'playing':undefined} width={180} height={320} poster={poster} autoPlay muted loop playsInline preload="metadata" disablePictureInPicture onPlaying={()=>setPlaying(true)} onError={()=>setFailed(true)}/>}</span>;
}
