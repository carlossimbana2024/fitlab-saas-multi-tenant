import { Bot, LoaderCircle, Send, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { api, apiErrorMessage } from '../services/api';
import { FloatingChatMascot } from './FloatingChatMascot';
import '../chat-mascot.css';

type ChatMessage = { role: 'user' | 'assistant'; content: string };

export function MemberChatWidget() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([{ role: 'assistant', content: '¡Hola! Soy FitLab IA. ¿En qué puedo ayudarte hoy?' }]);
  const panel=useRef<HTMLDialogElement>(null);const launcher=useRef<HTMLButtonElement>(null);const thread=useRef<HTMLDivElement>(null);
  const [mobile,setMobile]=useState(false);
  const [viewport,setViewport]=useState<{height:number;width:number;top:number;left:number}|null>(null);
  useEffect(()=>{
    if(!open)return;
    const node=panel.current;const media=window.matchMedia('(max-width:700px)');let overflow:string|null=null;let mode:boolean|undefined;
    const adapt=()=>{if(!node)return;const compact=media.matches||(window.visualViewport?.height??window.innerHeight)<420;if(compact===mode)return;mode=compact;setMobile(compact);const focused=node.contains(document.activeElement)?document.activeElement as HTMLElement:null;node.close();if(compact){if(overflow===null){overflow=document.body.style.overflow;document.body.style.overflow='hidden';}node.showModal();}else{if(overflow!==null){document.body.style.overflow=overflow;overflow=null;}node.show();}focused?.focus();};
    const resize=()=>{const v=window.visualViewport;setViewport({height:v?.height??window.innerHeight,width:v?.width??window.innerWidth,top:v?.offsetTop??0,left:v?.offsetLeft??0});adapt();};
    const escape=(event:KeyboardEvent)=>{const modal=document.querySelector('dialog:modal');if(event.key==='Escape'&&!event.defaultPrevented&&(!modal||modal===node)){event.preventDefault();setOpen(false);}};
    adapt();resize();media.addEventListener('change',adapt);window.addEventListener('resize',resize);window.addEventListener('keydown',escape);window.visualViewport?.addEventListener('resize',resize);window.visualViewport?.addEventListener('scroll',resize);
    return()=>{media.removeEventListener('change',adapt);window.removeEventListener('resize',resize);window.removeEventListener('keydown',escape);window.visualViewport?.removeEventListener('resize',resize);window.visualViewport?.removeEventListener('scroll',resize);node?.close();if(overflow!==null)document.body.style.overflow=overflow;queueMicrotask(()=>launcher.current?.focus());};
  },[open]);
  useEffect(()=>{if(open&&thread.current)thread.current.scrollTop=thread.current.scrollHeight;},[open,messages,sending]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const content = input.trim();
    if (!content || sending) return;
    const next = [...messages, { role: 'user' as const, content }];
    setMessages(next); setInput(''); setError(''); setSending(true);
    try {
      const history = next.slice(-10).filter((message, index) => !(index === 0 && message.role === 'assistant'));
      const { data } = await api.post<{ answer: string }>('/chat', { messages: history });
      setMessages((current) => [...current, { role: 'assistant', content: data.answer }]);
    } catch (cause) {
      setError(apiErrorMessage(cause));
    } finally {
      setSending(false);
    }
  };

  return <div className={`member-chat ${open ? 'open' : ''} ${mobile?'compact':''}`}>
    {open && createPortal(<dialog ref={panel} id="fitlab-chat-panel" className={`chat-window ${mobile?'chat-compact':''}`} aria-label="Asistente FitLab IA" aria-modal={mobile} style={viewport?{'--chat-vh':`${viewport.height}px`,'--chat-vw':`${viewport.width}px`,'--chat-vtop':`${viewport.top}px`,'--chat-vleft':`${viewport.left}px`} as React.CSSProperties:undefined} onCancel={event=>{event.preventDefault();setOpen(false);}} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();setOpen(false);}}}>
      <header><div><Bot/><span><strong>FitLab IA</strong><small>Asistente del miembro</small></span></div><button onClick={() => setOpen(false)} aria-label="Cerrar asistente"><X/></button></header>
      <div ref={thread} className="chat-messages" role="log" aria-live="polite" aria-relevant="additions">{messages.map((message, index) => <article className={message.role} key={`${message.role}-${index}`}><span>{message.content}</span></article>)}{sending && <article className="assistant typing"><LoaderCircle className="spin"/><span>Pensando…</span></article>}</div>
      {error && <div className="chat-error">{error}</div>}
      <form onSubmit={submit}><input aria-label="Mensaje para FitLab IA" maxLength={1200} placeholder="Escribe tu pregunta…" value={input} onChange={(event) => setInput(event.target.value)}/><button disabled={!input.trim() || sending} aria-label="Enviar mensaje"><Send/></button></form>
      <small className="chat-disclaimer">Orientación general. No sustituye atención médica ni profesional.</small>
    </dialog>,document.body)}
    <button ref={launcher} className="chat-launcher" onClick={() => setOpen((value) => !value)} aria-label={open ? 'Cerrar FitLab IA' : 'Abrir FitLab IA'} aria-expanded={open} aria-controls="fitlab-chat-panel" aria-haspopup="dialog"><FloatingChatMascot animate={!open}/><span className="chat-mascot-label">FitLab IA</span></button>
  </div>;
}
