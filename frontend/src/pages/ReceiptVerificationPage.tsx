import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, LoaderCircle, ShieldCheck } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { api, apiErrorMessage } from '../services/api';

type Verification = {
  valid: true;
  number: number;
  issuedAt: string;
  status: 'confirmed' | 'voided' | 'refunded';
  amount: number;
  currency: string;
  gym: { name: string; legal_name?: string | null; logo_url?: string | null };
  location: { name: string; city?: string | null };
  member: { name: string };
  concept: string;
  coverage?: { starts_on: string; ends_on: string } | null;
};

const statusLabels = { confirmed: 'Confirmado', voided: 'Anulado', refunded: 'Reembolsado' } as const;
const receiptCode = (number: number) => `REC-${String(number).padStart(6, '0')}`;
const money = (amount: number, currency: string) => new Intl.NumberFormat('es-EC', { style: 'currency', currency }).format(Number(amount));
const dateTime = (value: string) => new Intl.DateTimeFormat('es-EC', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(value));

export function ReceiptVerificationPage() {
  const { token = '' } = useParams();
  const query = useQuery({
    queryKey: ['public-receipt-verification', token],
    enabled: Boolean(token),
    retry: false,
    queryFn: async () => (await api.get<{ verification: Verification }>(`/member-payments/verify/${token}`)).data.verification,
  });

  return <main className="receipt-verification-page"><section className="verification-card">
    {query.isLoading ? <div className="verification-loading"><LoaderCircle className="spin"/><strong>Verificando recibo…</strong></div> : query.isError ? <><div className="verification-invalid"><AlertTriangle/><div><h1>No se pudo verificar</h1><p>{apiErrorMessage(query.error)}</p></div></div><p className="verification-disclaimer">Comprueba que el enlace esté completo o solicita nuevamente el recibo al gimnasio.</p></> : query.data && <>
      <header><img src={query.data.gym.logo_url || '/fitlab-logo.png'} alt={`Logotipo de ${query.data.gym.name}`} referrerPolicy="no-referrer"/><div><p className="eyebrow">VERIFICACIÓN FITLAB</p><h1>{query.data.gym.name}</h1><span>{query.data.location.name}{query.data.location.city ? ` · ${query.data.location.city}` : ''}</span></div><ShieldCheck/></header>
      <div className={`verification-status ${query.data.status}`}><ShieldCheck/><div><strong>Recibo auténtico</strong><span>El código existe en FitLab y su estado actual es <b>{statusLabels[query.data.status]}</b>.</span></div></div>
      <div className="verification-code"><div><small>NÚMERO</small><strong>{receiptCode(query.data.number)}</strong></div><div><small>EMITIDO</small><strong>{dateTime(query.data.issuedAt)}</strong></div></div>
      <dl><div><dt>Miembro</dt><dd>{query.data.member.name}</dd></div><div><dt>Concepto</dt><dd>{query.data.concept}</dd></div><div><dt>Cobertura</dt><dd>{query.data.coverage ? `${query.data.coverage.starts_on} al ${query.data.coverage.ends_on}` : 'Sin período asociado'}</dd></div><div><dt>Total registrado</dt><dd>{money(query.data.amount, query.data.currency)}</dd></div></dl>
      <p className="verification-disclaimer">Esta página confirma un registro interno de FitLab. No revela teléfono, referencia ni notas del pago.</p>
    </>}
    <footer><strong>Comprobante interno. No válido como comprobante tributario.</strong><Link to="/login">Ir a FitLab</Link></footer>
  </section></main>;
}
