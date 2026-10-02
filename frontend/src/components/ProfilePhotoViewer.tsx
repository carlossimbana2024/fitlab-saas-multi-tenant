import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Minus, Plus, RotateCcw, X } from 'lucide-react';
import '../profile-header.css';

export function ProfilePhotoViewer({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef(document.activeElement as HTMLElement | null);
  const [zoom, setZoom] = useState(1);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const points = useRef(new Map<number, { x: number; y: number }>());
  const distance = useRef<number | null>(null);
  const backdropPressed = useRef(false);
  const changeZoom = (next: number) => { setZoom(Math.max(1, Math.min(4, next))); if (next <= 1) setOffset({ x: 0, y: 0 }); };
  useEffect(() => {
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.showModal();
    return () => { document.body.style.overflow = overflow; queueMicrotask(() => opener.current?.focus()); };
  }, []);
  return createPortal(<dialog ref={dialog} className="profile-photo-dialog" aria-label={`Foto de ${name}`} onCancel={event => { event.preventDefault(); onClose(); }} onPointerDown={event => { backdropPressed.current = event.target === event.currentTarget; }} onClick={event => { if (backdropPressed.current && event.target === event.currentTarget) onClose(); }}>
    <div className="profile-photo-toolbar">
      <span>Foto de {name}</span>
      <button type="button" aria-label="Alejar foto" disabled={zoom <= 1 || failed} onClick={() => changeZoom(zoom - .5)}><Minus /></button>
      <output aria-label="Nivel de zoom">{Math.round(zoom * 100)}%</output>
      <button type="button" aria-label="Acercar foto" disabled={zoom >= 4 || failed} onClick={() => changeZoom(zoom + .5)}><Plus /></button>
      <button type="button" aria-label="Restablecer zoom" onClick={() => { changeZoom(1); setOffset({ x: 0, y: 0 }); }}><RotateCcw /></button>
      <button type="button" autoFocus aria-label="Cerrar foto" onClick={onClose}><X /></button>
    </div>
    <div className="profile-photo-stage" onWheel={event => { changeZoom(zoom + (event.deltaY < 0 ? .2 : -.2)); }}
      onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); points.current.set(event.pointerId, { x: event.clientX, y: event.clientY }); distance.current = null; }}
      onPointerMove={event => {
        const previous = points.current.get(event.pointerId); if (!previous) return;
        points.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        const touches = [...points.current.values()];
        if (touches.length === 2) {
          const next = Math.hypot(touches[0].x - touches[1].x, touches[0].y - touches[1].y);
          if (distance.current && next > 0) changeZoom(zoom * next / distance.current);
          distance.current = next;
        } else if (zoom > 1) {
          const maxX = event.currentTarget.clientWidth * (zoom - 1) / 2;
          const maxY = event.currentTarget.clientHeight * (zoom - 1) / 2;
          const dx = event.clientX - previous.x; const dy = event.clientY - previous.y;
          setOffset(current => ({ x: Math.max(-maxX, Math.min(maxX, current.x + dx)), y: Math.max(-maxY, Math.min(maxY, current.y + dy)) }));
        }
      }}
      onPointerUp={event => { points.current.delete(event.pointerId); distance.current = null; }}
      onPointerCancel={event => { points.current.delete(event.pointerId); distance.current = null; }}>
      {!failed && !loaded && <span className="profile-photo-loading" role="status">Cargando foto…</span>}
      {failed ? <p role="alert">No se pudo cargar la foto. Cierra el visor e intenta nuevamente.</p> : <img src={src} alt={`Foto ampliada de ${name}`} draggable={false} onLoad={() => setLoaded(true)} onError={() => setFailed(true)} style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }} />}
    </div>
    <p className="profile-photo-hint">Usa + y −, la rueda o dos dedos para ampliar. Arrastra para desplazarte.</p>
  </dialog>, document.body);
}
