import type { GenericAbortSignal } from 'axios';
import { adminPinCancelled, type AdminPinGrant } from './adminPinElevation';

type Ticket = { id: number; permission: string; signal: AbortSignal };
type Entry = {
  ticket: Ticket;
  controller: AbortController;
  detach: () => void;
  resolve: (grant: AdminPinGrant) => void;
  reject: (cause: unknown) => void;
};

export function createAdminPinQueue() {
  const entries: Entry[] = [];
  const listeners = new Set<() => void>();
  let nextId = 0;
  const notify = () => listeners.forEach(listener => listener());
  const dispose = (entry: Entry) => { entry.detach(); entry.controller.abort(); };
  const take = (ticket: Ticket) => {
    const index = entries.findIndex(entry => entry.ticket === ticket);
    if (index === -1) return;
    const [entry] = entries.splice(index, 1);
    dispose(entry);
    if (index === 0) notify();
    return entry;
  };

  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => entries[0]?.ticket ?? null,
    enqueue(permission: string, signals: readonly GenericAbortSignal[]) {
      return new Promise<AdminPinGrant>((resolve, reject) => {
        if (signals.some(signal => signal.aborted)) { reject(adminPinCancelled()); return; }
        const controller = new AbortController();
        const ticket = { id: ++nextId, permission, signal: controller.signal };
        const abort = () => take(ticket)?.reject(adminPinCancelled());
        const detach = () => signals.forEach(signal => signal.removeEventListener?.('abort', abort));
        entries.push({ ticket, controller, detach, resolve, reject });
        signals.forEach(signal => signal.addEventListener?.('abort', abort, { once: true }));
        if (entries.length === 1) notify();
      });
    },
    resolve(ticket: Ticket, grant: AdminPinGrant) { if (entries[0]?.ticket === ticket) take(ticket)?.resolve(grant); },
    reject(ticket: Ticket, cause: unknown) { if (entries[0]?.ticket === ticket) take(ticket)?.reject(cause); },
    cancelAll(cause: unknown = adminPinCancelled()) {
      if (!entries.length) return;
      for (const entry of entries.splice(0)) {
        dispose(entry);
        entry.reject(cause);
      }
      notify();
    },
  };
}

export type AdminPinQueue = ReturnType<typeof createAdminPinQueue>;
