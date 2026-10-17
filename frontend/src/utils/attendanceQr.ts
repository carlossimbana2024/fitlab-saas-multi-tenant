const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isAttendanceQrToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

export function attendanceTokenFromHash(hash: string): string | null {
  const match = /^#token=([A-Za-z0-9_-]{43})$/.exec(hash);
  return match?.[1] ?? null;
}

/** Only posters from this deployment (or explicitly trusted former domains).
 * The decoded URL is never opened or fetched; only its token reaches our API.
 */
export function parseAttendanceQr(value: string, currentOrigin: string, trustedOrigins: string[] = []): string | null {
  if (value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    const current = new URL(currentOrigin);
    const allowed = new Set([current.origin]);
    for (const origin of trustedOrigins) {
      try {
        const candidate = new URL(origin.trim());
        if (candidate.protocol === 'https:' && candidate.pathname === '/' && !candidate.search && !candidate.hash && !candidate.username && !candidate.password) allowed.add(candidate.origin);
      } catch { /* Invalid optional configuration never broadens trust. */ }
    }
    const localDevelopment = url.protocol === 'http:' && url.origin === current.origin && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((!localDevelopment && url.protocol !== 'https:') || !allowed.has(url.origin) || url.username || url.password || url.pathname !== '/check-in' || url.search) return null;
    return attendanceTokenFromHash(url.hash);
  } catch { return null; }
}

export function scannerCameraError(cause: unknown): string {
  const name = cause instanceof Error || (typeof cause === 'object' && cause !== null && 'name' in cause) ? String((cause as { name: unknown }).name) : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'No se permitió usar la cámara. Habilita el permiso de cámara de este sitio en tu navegador y vuelve a intentarlo. También puedes escanear con la cámara del celular o acudir a recepción.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No se encontró una cámara disponible. Prueba otra cámara o solicita el registro en recepción.';
  if (name === 'NotReadableError' || name === 'AbortError') return 'No se pudo acceder a la cámara. Cierra otras aplicaciones que la estén usando y vuelve a intentarlo.';
  return 'No se pudo iniciar el escáner. Intenta nuevamente o utiliza la cámara de tu celular para escanear el cartel.';
}
