import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Clock3, FileText, Upload, X, XCircle, ZoomIn } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, apiErrorMessage } from '../services/api';

type ManualPaymentRequest = {
  id: string;
  amount: number;
  currency: string;
  status: 'draft' | 'pending' | 'approved' | 'rejected';
  review_reason: string | null;
  bank_reference: string | null;
  created_at: string;
};

type ManualBillingResponse = {
  instructions: string;
  qrUrl: string | null;
  requests: ManualPaymentRequest[];
};

const statusLabels: Record<ManualPaymentRequest['status'], string> = {
  draft: 'Preparando',
  pending: 'Pendiente de revisión',
  approved: 'Aprobado',
  rejected: 'Rechazado',
};

function RequestStatusIcon({ status }: { status: ManualPaymentRequest['status'] }) {
  if (status === 'approved') return <CheckCircle2/>;
  if (status === 'rejected') return <XCircle/>;
  if (status === 'pending') return <Clock3/>;
  return <FileText/>;
}

export function ManualBilling() {
  const client = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [reference, setReference] = useState('');
  const [payer, setPayer] = useState('');
  const [paidOn, setPaidOn] = useState('');
  const [draftId, setDraftId] = useState('');
  const [qrOpen, setQrOpen] = useState(false);

  const query = useQuery({
    queryKey: ['manual-billing'],
    queryFn: async () => (await api.get<ManualBillingResponse>('/billing/manual')).data,
  });

  const submit = useMutation({
    mutationFn: async () => {
      let id = draftId;
      if (!id) {
        if (!file || file.size > 5_242_880 || !['image/jpeg', 'image/png', 'application/pdf'].includes(file.type)) {
          throw new Error('Selecciona un PDF, JPG o PNG de hasta 5 MB.');
        }
        const { data } = await api.post<{ id: string; signedUrl: string }>('/billing/manual');
        id = data.id;
        const body = new FormData();
        body.append('cacheControl', '0');
        body.append('', file);
        const result = await fetch(data.signedUrl, { method: 'PUT', headers: { 'x-upsert': 'true' }, body });
        if (!result.ok) throw new Error('No se pudo subir el comprobante.');
        setDraftId(id);
      }
      await api.post(`/billing/manual/${id}/submit`, { reference, payer, paidOn });
    },
    onSuccess: async () => {
      setDraftId('');
      setFile(null);
      setReference('');
      setPayer('');
      setPaidOn('');
      await client.invalidateQueries({ queryKey: ['manual-billing'] });
    },
  });

  useEffect(() => {
    if (!qrOpen) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setQrOpen(false);
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [qrOpen]);

  const instructions = query.data?.instructions ?? '';
  const instructionParts = instructions.split(/\s*\|\s*|\r?\n/).map((part) => part.trim()).filter(Boolean);
  const hasPendingRequest = query.data?.requests.some((request) => request.status === 'pending') ?? false;
  const today = new Date().toISOString().slice(0, 10);

  return <section className="panel manual-billing-panel">
    <header className="manual-billing-heading">
      <div>
        <p className="eyebrow">PAGO SEGURO</p>
        <h2>Pagar por transferencia</h2>
      </div>
      <span>Activación con revisión manual</span>
    </header>

    {query.isLoading ? <p>Cargando datos…</p> : query.isError ? <div className="alert error">{apiErrorMessage(query.error)}</div> : <>
      <div className="manual-payment-details">
        {query.data?.qrUrl && <button type="button" className="qr-preview-trigger" onClick={() => setQrOpen(true)} aria-label="Ampliar QR de pago">
          <img src={query.data.qrUrl} alt="QR de pago de FitLab"/>
          <span><ZoomIn/> Toca para ampliar</span>
        </button>}
        <div className="manual-bank-instructions">
          <p className="eyebrow">DATOS PARA TRANSFERIR</p>
          {instructionParts.length > 0 ? <div>{instructionParts.map((part, index) => <span key={`${part}-${index}`}>{part}</span>)}</div> : <p>Los datos de transferencia todavía no están disponibles.</p>}
          <small>Verifica que el valor y la referencia coincidan con tu comprobante.</small>
        </div>
      </div>

      <div className="manual-payment-note">
        <CheckCircle2/>
        <p><strong>Tu acceso se activa después de la revisión.</strong><span>Sube el comprobante y confirmaremos el ingreso antes de habilitar el período.</span></p>
      </div>

      {instructions && !hasPendingRequest && <form onSubmit={(event) => { event.preventDefault(); submit.mutate(); }} className="checkout-form single manual-payment-form">
        <label className="manual-file-picker" htmlFor="manual-payment-proof">
          <span>Comprobante</span>
          <input id="manual-payment-proof" type="file" accept="image/jpeg,image/png,application/pdf" disabled={!!draftId || submit.isPending} onChange={(event) => setFile(event.target.files?.[0] ?? null)}/>
          <span className="manual-file-control">
            <Upload/>
            <span><strong>{file?.name ?? 'Seleccionar comprobante'}</strong><small>PDF, JPG o PNG · máximo 5 MB</small></span>
          </span>
        </label>
        <label>Nombre del pagador<input required minLength={2} maxLength={150} autoComplete="name" placeholder="Como aparece en la transferencia" value={payer} onChange={(event) => setPayer(event.target.value)}/></label>
        <label>Referencia de la transferencia<input required minLength={4} maxLength={120} placeholder="Número o código del comprobante" value={reference} onChange={(event) => setReference(event.target.value)}/></label>
        <label>Fecha del pago<input type="date" required max={today} value={paidOn} onChange={(event) => setPaidOn(event.target.value)}/></label>
        <button className="primary manual-submit-button" disabled={submit.isPending || (!file && !draftId)}>{submit.isPending ? 'Enviando…' : 'Enviar a revisión'}</button>
      </form>}

      {hasPendingRequest && <div className="alert warning manual-pending-alert">Tu comprobante está pendiente de revisión. Te mostraremos aquí el resultado.</div>}
      {submit.isError && <div className="alert error">{apiErrorMessage(submit.error)}</div>}

      {!!query.data?.requests.length && <div className="manual-request-list">
        <h3>Historial de solicitudes</h3>
        {query.data.requests.map((request) => <article className={`manual-request-card ${request.status}`} key={request.id}>
          <span className="manual-request-icon"><RequestStatusIcon status={request.status}/></span>
          <div>
            <strong>{statusLabels[request.status]}</strong>
            <small>{Number(request.amount).toFixed(2)} {request.currency} · {new Date(request.created_at).toLocaleDateString('es-EC')}</small>
            {request.bank_reference && <small>Referencia: {request.bank_reference}</small>}
            {request.review_reason && <p>{request.review_reason}</p>}
          </div>
        </article>)}
      </div>}
    </>}

    {qrOpen && query.data?.qrUrl && <div className="modal-backdrop qr-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setQrOpen(false); }}>
      <section className="qr-modal" role="dialog" aria-modal="true" aria-labelledby="qr-modal-title">
        <button type="button" className="icon-button qr-modal-close" aria-label="Cerrar QR ampliado" onClick={() => setQrOpen(false)}><X/></button>
        <p className="eyebrow">ESCANEA PARA PAGAR</p>
        <h2 id="qr-modal-title">QR de pago FitLab</h2>
        <img src={query.data.qrUrl} alt="QR de pago de FitLab ampliado"/>
        <p>Abre la aplicación de tu banco y escanea este código. Luego vuelve para subir el comprobante.</p>
      </section>
    </div>}
  </section>;
}
