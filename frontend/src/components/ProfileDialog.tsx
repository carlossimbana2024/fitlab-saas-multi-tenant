import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
export function ProfileDialog({ title, onClose, busy=false, children }: { title: string; onClose: () => void; busy?: boolean; children: ReactNode }) {
 const dialog=useRef<HTMLDialogElement>(null);const opener=useRef(document.activeElement as HTMLElement|null);const outside=useRef(false);
 useEffect(()=>{const overflow=document.body.style.overflow;document.body.style.overflow='hidden';dialog.current?.showModal();return()=>{document.body.style.overflow=overflow;queueMicrotask(()=>opener.current?.focus());};},[]);
 return createPortal(<dialog ref={dialog} className="profile-edit-dialog" aria-label={title} onCancel={event=>{event.preventDefault();if(!busy)onClose();}} onPointerDown={event=>{outside.current=event.target===event.currentTarget;}} onClick={event=>{if(!busy&&outside.current&&event.target===event.currentTarget)onClose();}}><div className="modal-heading"><h2>{title}</h2><button type="button" className="icon-button" aria-label={`Cerrar ${title}`} disabled={busy} onClick={onClose}><X/></button></div>{children}</dialog>,document.body);
}
