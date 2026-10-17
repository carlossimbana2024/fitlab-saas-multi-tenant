import { Camera, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { parseAttendanceQr, scannerCameraError } from '../utils/attendanceQr';
import { createAttendanceQrReader } from '../utils/attendanceQrReader';

type ScannerState = 'idle' | 'starting' | 'scanning' | 'paused' | 'error';

export function AttendanceQrScanner({ onToken }: { onToken: (token: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const reader = useRef<ReturnType<typeof createAttendanceQrReader> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const run = useRef(0);
  const mounted = useRef(true);
  const facing = useRef<'environment' | 'user'>('environment');
  const [state, setState] = useState<ScannerState>('idle');
  const [message, setMessage] = useState('');
  const [waitingPermission, setWaitingPermission] = useState(false);
  const active = state === 'starting' || state === 'scanning';

  const release = () => {
    run.current++;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    reader.current?.dispose(); reader.current = null;
    stream.current?.getTracks().forEach(track => { track.onended = null; track.stop(); }); stream.current = null;
    if (video.current) { video.current.pause(); video.current.srcObject = null; }
    if (canvas.current) { canvas.current.width = 0; canvas.current.height = 0; canvas.current = null; }
  };

  useEffect(() => {
    mounted.current = true;
    const pause = () => {
      release();
      if (mounted.current) { setState('paused'); setWaitingPermission(false); setMessage('El escáner está pausado. Pulsa Reanudar escáner cuando estés listo.'); }
    };
    const visibility = () => { if (document.visibilityState !== 'visible') pause(); };
    const offline = () => { pause(); setMessage('Sin conexión. Conéctate a internet y vuelve a abrir el escáner. No se ha registrado ninguna asistencia.'); };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', pause);
    window.addEventListener('offline', offline);
    return () => { mounted.current = false; release(); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', pause); window.removeEventListener('offline', offline); };
  }, []);

  const start = async () => {
    release();
    setMessage(''); setWaitingPermission(false);
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) { setState('error'); setMessage('Este navegador no permite abrir la cámara aquí. Abre FitLab por HTTPS en Safari o Chrome, o utiliza la cámara del celular.'); return; }
    if (!navigator.onLine) { setState('error'); setMessage('Necesitas conexión a internet para comprobar y confirmar tu asistencia.'); return; }
    if (document.visibilityState !== 'visible') { setState('paused'); return; }
    const generation = run.current;
    const current = () => mounted.current && generation === run.current && document.visibilityState === 'visible';
    setState('starting');
    const permissionTimer = setTimeout(() => { if (current()) setWaitingPermission(true); }, 12_000);
    try {
      // Request immediately after the user's tap (including Safari); never audio.
      const media = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: facing.current }, width: { ideal: 1280 }, height: { ideal: 720 } } });
      clearTimeout(permissionTimer);
      if (!current()) { media.getTracks().forEach(track => track.stop()); return; }
      stream.current = media;
      media.getVideoTracks().forEach(track => { track.onended = () => { if (current()) { release(); setState('error'); setMessage('La cámara se desconectó o se retiró su permiso. Puedes volver a intentarlo.'); } }; });
      const element = video.current;
      if (!element) { release(); return; }
      element.srcObject = media;
      await element.play();
      if (!current()) return;
      setWaitingPermission(false); setState('scanning');
      const decoder = createAttendanceQrReader(); reader.current = decoder;
      const image = document.createElement('canvas'); canvas.current = image;
      const context = image.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Camera canvas unavailable');
      const scan = async () => {
        if (!current()) return;
        try {
          if (element.readyState >= 2 && element.videoWidth && element.videoHeight) {
            const scale = Math.min(1, 640 / Math.max(element.videoWidth, element.videoHeight));
            image.width = Math.max(1, Math.round(element.videoWidth * scale)); image.height = Math.max(1, Math.round(element.videoHeight * scale));
            context.drawImage(element, 0, 0, image.width, image.height);
            const value = await decoder.decode(context.getImageData(0, 0, image.width, image.height));
            if (!current()) return;
            if (value) {
              const trusted = (import.meta.env.VITE_ATTENDANCE_QR_ALLOWED_ORIGINS ?? '').split(',').filter(Boolean);
              const token = parseAttendanceQr(value, window.location.origin, trusted);
              if (token) { release(); onToken(token); return; }
              setMessage('Este código no es un QR de asistencia de FitLab válido para este sitio. Apunta al cartel de tu sucursal.');
            }
          }
          // Bounded resolution and sequential ~4 fps decoding, never full-speed video.
          if (current()) timer.current = setTimeout(() => void scan(), 250);
        } catch {
          if (current()) { release(); setState('error'); setMessage('No se pudo leer la cámara. Reintenta o escanea el cartel con la cámara de tu celular.'); }
        }
      };
      void scan();
    } catch (cause) {
      if (current()) { release(); setState('error'); setWaitingPermission(false); setMessage(scannerCameraError(cause)); }
    } finally { clearTimeout(permissionTimer); }
  };

  const cancel = () => { release(); setState('idle'); setWaitingPermission(false); setMessage(''); };
  return <section className="attendance-scanner" aria-label="Escáner de asistencia">
    <p>Elige cómo escanear el QR de la entrada de tu sucursal. La cámara de tu celular sigue funcionando como antes.</p>
    <div className="attendance-scanner-camera" hidden={!active}>
      <video ref={video} muted playsInline autoPlay aria-label="Vista de la cámara para escanear el QR"/>
      <span className="attendance-scanner-frame" aria-hidden="true"/>
      {state === 'starting' && <div className="attendance-scanner-loading" role="status"><LoaderCircle className="spin"/><span>{waitingPermission ? 'Acepta el permiso de cámara en el navegador. Si no aparece, puedes cancelar y revisar los permisos.' : 'Abriendo cámara…'}</span></div>}
    </div>
    {message && <p className={state === 'error' ? 'alert error' : 'attendance-scanner-message'} role={state === 'error' ? 'alert' : 'status'}>{message}</p>}
    <div className="attendance-scanner-actions">
      {!active && <button type="button" className="primary full-width" onClick={() => void start()}><Camera/>{state === 'paused' ? 'Reanudar escáner' : state === 'error' ? 'Reintentar cámara' : 'Abrir escáner de FitLab'}</button>}
      {state === 'scanning' && <button type="button" className="ghost" onClick={() => { facing.current = facing.current === 'environment' ? 'user' : 'environment'; void start(); }}><RefreshCw/>Cambiar cámara</button>}
      {active && <button type="button" className="ghost" onClick={cancel}><X/>Cerrar cámara</button>}
    </div>
    <small className="attendance-scanner-privacy">Solo lectura de QR en tu dispositivo: no guardamos ni enviamos imágenes y no usamos el micrófono. La asistencia requiere tu confirmación.</small>
    <details className="attendance-scanner-alternative"><summary>Usar la cámara del celular o pedir ayuda</summary><p>Abre la aplicación Cámara, apunta al cartel y abre el enlace de FitLab. También puedes solicitar el registro manual en recepción.</p><p>Si abriste FitLab dentro de WhatsApp u otra aplicación y no funciona la cámara, abre este sitio en Safari o Chrome.</p></details>
  </section>;
}
