import { useEffect, useMemo, useRef, useState } from 'react';

const splashAssets = {
  desktop: {
    image: '/assets/splash/fitlab-splash-desktop.jpg',
    video: '/assets/splash/fitlab-splash-desktop.mp4',
  },
  mobile: {
    image: '/assets/splash/fitlab-splash-mobile.jpg',
    video: '/assets/splash/fitlab-splash-mobile.mp4',
  },
} as const;

type ConnectionNavigator = Navigator & {
  connection?: { saveData?: boolean; effectiveType?: string };
};

function prefersLightweightSplash() {
  if (typeof window === 'undefined') return true;
  const connection = (navigator as ConnectionNavigator).connection;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
    || Boolean(connection?.saveData)
    || ['slow-2g', '2g'].includes(connection?.effectiveType ?? '');
}

export function AppSplash({ active }: { active: boolean }) {
  const [mounted, setMounted] = useState(active);
  const [leaving, setLeaving] = useState(false);
  const [portrait, setPortrait] = useState(() => typeof window !== 'undefined' && window.matchMedia('(orientation: portrait)').matches);
  const [videoFailed, setVideoFailed] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const lightweight = useMemo(prefersLightweightSplash, []);
  const assets = portrait ? splashAssets.mobile : splashAssets.desktop;

  useEffect(() => {
    const media = window.matchMedia('(orientation: portrait)');
    const update = () => setPortrait(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    setVideoFailed(false);
    setVideoReady(false);
  }, [assets.video]);

  useEffect(() => {
    if (active) {
      setMounted(true);
      setLeaving(false);
      return;
    }
    if (!mounted) return;
    setLeaving(true);
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const timer = window.setTimeout(() => setMounted(false), reducedMotion ? 0 : 280);
    return () => window.clearTimeout(timer);
  }, [active, mounted]);

  useEffect(() => {
    if (!mounted || lightweight || videoFailed) return;
    const attempt = videoRef.current?.play();
    attempt?.catch(() => setVideoFailed(true));
  }, [assets.video, lightweight, mounted, videoFailed]);

  useEffect(() => {
    document.documentElement.toggleAttribute('data-app-loading', mounted);
    return () => document.documentElement.removeAttribute('data-app-loading');
  }, [mounted]);

  if (!mounted) return null;

  return <div
    className={`app-splash${leaving ? ' leaving' : ''}`}
    data-variant={portrait ? 'mobile' : 'desktop'}
    role="status"
    aria-live="polite"
    aria-label="Cargando FitLab"
    aria-busy={active}
  >
    <img className="app-splash-media app-splash-fallback" src={assets.image} alt="" aria-hidden="true"/>
    {!lightweight && !videoFailed && <video
      key={assets.video}
      ref={videoRef}
      className={`app-splash-media app-splash-video${videoReady ? ' ready' : ''}`}
      src={assets.video}
      autoPlay
      muted
      loop
      playsInline
      preload="auto"
      tabIndex={-1}
      aria-hidden="true"
      onCanPlay={() => setVideoReady(true)}
      onError={() => setVideoFailed(true)}
    />}
    <span className="sr-only">Cargando FitLab…</span>
  </div>;
}
