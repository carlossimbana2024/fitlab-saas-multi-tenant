import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, LoaderCircle, Printer, QrCode } from 'lucide-react';
import { useState } from 'react';
import { api, apiErrorMessage } from '../services/api';
import '../styles/attendanceQr.css';

type Codes = {
  locations: Array<{ id: string; name: string; is_active: boolean }>;
  codes: Array<{ id: string; location_id: string; created_at: string; expires_at: string | null }>;
};
type Poster = { locationId: string; branch: string; image: string };

export function AttendanceQrSettings({ gymName }: { gymName: string }) {
  const queryClient = useQueryClient();
  const codes = useQuery({ queryKey: ['attendance-qr-codes'], queryFn: async () => (await api.get<Codes>('/attendances/qr/codes')).data });
  const [selected, setSelected] = useState('');
  const [poster, setPoster] = useState<Poster | null>(null);
  const [notice, setNotice] = useState('');
  const [fileError, setFileError] = useState('');
  const locationId = selected || codes.data?.locations[0]?.id || '';
  const branch = codes.data?.locations.find((item) => item.id === locationId);
  const current = codes.data?.codes.find((item) => item.location_id === locationId);
  const change = useMutation({
    mutationFn: async (action: 'generate' | 'revoke') => {
      setPoster(null); setNotice(''); setFileError('');
      const { data } = await api.post<{ token: string | null; code: { location_name: string } }>('/attendances/qr/codes', { locationId, action });
      await queryClient.invalidateQueries({ queryKey: ['attendance-qr-codes'] });
      if (data.token) {
        const url = `${window.location.origin}/check-in#token=${data.token}`;
        try {
          const { default: QRCode } = await import('qrcode');
          const image = await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 4, width: 1000 });
          setPoster({ locationId, branch: data.code.location_name, image });
          setNotice('QR generado. Descarga el cartel ahora y reemplaza cualquier cartel anterior de esta sucursal.');
        } catch {
          setFileError('El QR quedó vigente, pero el navegador no pudo crear el cartel. Genera un nuevo QR para volver a intentarlo; el actual será reemplazado automáticamente.');
        }
      } else setNotice('QR revocado. El cartel anterior ya no permite registrar asistencias.');
    },
  });
  const operate = (action: 'generate' | 'revoke') => {
    if (current && !window.confirm(action === 'revoke'
      ? '¿Revocar este QR? El cartel actual dejará de funcionar.'
      : '¿Reemplazar este QR? El cartel actual dejará de funcionar y deberás imprimir el nuevo.')) return;
    change.mutate(action);
  };
  const exportPoster = async (print: boolean) => {
    if (!poster) return;
    setFileError('');
    try {
      const { jsPDF } = await import('jspdf');
      const pdf = new jsPDF();
      pdf.setFont('helvetica', 'bold'); pdf.setFontSize(24);
      pdf.text('REGISTRA TU ASISTENCIA', 105, 28, { align: 'center' });
      pdf.setFontSize(18);
      pdf.text(pdf.splitTextToSize(gymName, 170), 105, 45, { align: 'center' });
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(15);
      pdf.text(pdf.splitTextToSize(poster.branch, 170), 105, 70, { align: 'center' });
      pdf.addImage(poster.image, 'PNG', 40, 90, 130, 130);
      pdf.setFontSize(12);
      pdf.text(['1. Escanea con la cámara de tu teléfono.', '2. Inicia sesión con tu cuenta de miembro.', '3. Confirma tu llegada a esta sucursal.'], 35, 237);
      pdf.setFontSize(10); pdf.text('Una asistencia diaria. Si necesitas ayuda, acude a recepción.', 105, 274, { align: 'center' });
      if (print) {
        const popup = window.open('', '_blank');
        if (!popup) throw new Error('Permite las ventanas emergentes o descarga el PDF para imprimirlo.');
        popup.opener = null;
        pdf.autoPrint();
        const url = URL.createObjectURL(pdf.output('blob'));
        popup.location.href = url;
        window.setTimeout(() => URL.revokeObjectURL(url), 120_000);
      } else pdf.save('FitLab-QR-asistencia.pdf');
    } catch (cause) { setFileError(apiErrorMessage(cause)); }
  };
  return <section className="panel settings-form qr-settings">
    <div className="panel-title"><div><h2>QR de asistencia</h2><p>Un cartel por sucursal · solo el owner</p></div><QrCode/></div>
    <p>Los miembros escanean el cartel de la entrada y confirman su llegada desde el teléfono.</p>
    {codes.isLoading && <p><LoaderCircle className="spin"/> Cargando sucursales…</p>}
    {codes.isError && <div className="alert error">{apiErrorMessage(codes.error)}<button className="ghost" onClick={() => void codes.refetch()}>Reintentar</button></div>}
    <label>Sucursal<select disabled={change.isPending} value={locationId} onChange={(event) => { setSelected(event.target.value); setNotice(''); }}>
      {codes.data?.locations.map((item) => <option key={item.id} value={item.id}>{item.name}{!item.is_active ? ' · Inactiva' : ''}</option>)}
    </select></label>
    {current ? <p>QR {current.expires_at && new Date(current.expires_at) <= new Date() ? 'vencido' : 'vigente'} · creado el {new Date(current.created_at).toLocaleDateString('es-EC')}</p> : <p>Esta sucursal no tiene un QR vigente.</p>}
    <div className="qr-controls"><button className="primary" disabled={!branch?.is_active || change.isPending || codes.isError} onClick={() => operate('generate')}>{change.isPending ? <LoaderCircle className="spin"/> : <QrCode/>}{current ? 'Generar nuevo QR' : 'Generar QR'}</button>
      {current && <button className="ghost danger-text" disabled={change.isPending} onClick={() => operate('revoke')}>Revocar QR</button>}</div>
    {change.isError && <div className="alert error">{apiErrorMessage(change.error)}</div>}
    {notice && <div className="alert success" role="status">{notice}</div>}
    {poster?.locationId === locationId && <div className="qr-poster"><h3>{gymName}</h3><p>{poster.branch}</p><img src={poster.image} alt={`QR de asistencia de ${poster.branch}`}/><div className="qr-controls"><button className="ghost" onClick={() => void exportPoster(true)}><Printer/>Imprimir</button><button className="primary" onClick={() => void exportPoster(false)}><Download/>Descargar PDF</button></div></div>}
    {fileError && <div className="alert error">{fileError}</div>}
    <p className="muted">Guarda el PDF para reimprimirlo. Al salir de esta pantalla, la imagen del código no se conserva. Si pierdes el archivo, genera uno nuevo y reemplaza el cartel.</p>
  </section>;
}
