import { Bot, LoaderCircle, MessageCircle, Send, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api, apiErrorMessage } from '../services/api';

type ChatMessage = { role: 'user' | 'assistant'; content: string };

export function MemberChatWidget() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([{ role: 'assistant', content: '¡Hola! Soy FitLab IA. ¿En qué puedo ayudarte hoy?' }]);

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

  return <div className={`member-chat ${open ? 'open' : ''}`}>
    {open && <section className="chat-window" aria-label="Asistente FitLab IA">
      <header><div><Bot/><span><strong>FitLab IA</strong><small>Asistente del miembro</small></span></div><button onClick={() => setOpen(false)} aria-label="Cerrar asistente"><X/></button></header>
      <div className="chat-messages">{messages.map((message, index) => <article className={message.role} key={`${message.role}-${index}`}><span>{message.content}</span></article>)}{sending && <article className="assistant typing"><LoaderCircle className="spin"/><span>Pensando…</span></article>}</div>
      {error && <div className="chat-error">{error}</div>}
      <form onSubmit={submit}><input aria-label="Mensaje para FitLab IA" maxLength={1200} placeholder="Escribe tu pregunta…" value={input} onChange={(event) => setInput(event.target.value)}/><button disabled={!input.trim() || sending} aria-label="Enviar mensaje"><Send/></button></form>
      <small className="chat-disclaimer">Orientación general. No sustituye atención médica ni profesional.</small>
    </section>}
    <button className="chat-launcher" onClick={() => setOpen((value) => !value)} aria-label={open ? 'Cerrar FitLab IA' : 'Abrir FitLab IA'}>{open ? <X/> : <MessageCircle/>}<span>{open ? 'Cerrar' : 'FitLab IA'}</span></button>
  </div>;
}
