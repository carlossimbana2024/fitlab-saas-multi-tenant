import { CheckCircle2, ChevronRight, QrCode } from 'lucide-react';
import { Link } from 'react-router-dom';
import '../attendance-qr.css';

/** The same entry point and daily state in Home and Progress. */
export function AttendanceQrCard({ hasAttendanceToday }: { hasAttendanceToday: boolean }) {
  return <Link className="attendance-qr-card" to="/check-in">
    <span className="attendance-qr-icon" aria-hidden="true">{hasAttendanceToday ? <CheckCircle2/> : <QrCode/>}</span>
    <span className="attendance-qr-copy"><strong>{hasAttendanceToday ? 'Entrada registrada hoy' : 'Registrar asistencia'}</strong><small>Escanea el QR de tu sucursal</small></span>
    <ChevronRight className="attendance-qr-arrow" aria-hidden="true"/>
  </Link>;
}
