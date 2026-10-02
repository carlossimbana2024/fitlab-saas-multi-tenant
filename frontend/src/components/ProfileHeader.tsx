import { useEffect, useState, type ReactNode } from 'react';
import { Activity, Flame, Heart, Medal, Share2 } from 'lucide-react';
import { ProfilePhotoViewer } from './ProfilePhotoViewer';
import '../profile-header.css';

type HeaderProfile = { name: string; avatarUrl: string | null; bio: string; monthlyAttendances: number | null; streak: { current_streak: number } | null; loveCount: number; badges: unknown[]; showBadges: boolean; own: boolean };
export function ProfileHeader({ profile, actions, shareUrl, loading, showStats = true }: { profile: HeaderProfile; actions?: ReactNode; shareUrl?: string; loading?: boolean; showStats?: boolean }) {
  const [viewing, setViewing] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [feedback, setFeedback] = useState('');
  useEffect(() => { setImageFailed(false); setViewing(false); setFeedback(''); }, [profile.avatarUrl, profile.name]);
  const initials = profile.name.split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
  const share = async () => {
    try {
      if (navigator.share) await navigator.share({ title: `${profile.name} · FitLab`, url: shareUrl });
      else { await navigator.clipboard.writeText(shareUrl!); setFeedback('Enlace copiado. Solo pueden consultarlo miembros de tu gimnasio.'); }
    } catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) setFeedback('No se pudo compartir el enlace. Intenta nuevamente.'); }
  };
  return <header className="fitlab-profile-header" aria-busy={loading}>
    <div className="fitlab-profile-identity">
      {profile.avatarUrl && !imageFailed ? <button type="button" className="fitlab-profile-avatar" aria-label={`Ampliar foto de ${profile.name}`} onClick={() => setViewing(true)}><img key={profile.avatarUrl} src={profile.avatarUrl} alt={`Foto de ${profile.name}`} onLoad={() => setImageFailed(false)} onError={() => setImageFailed(true)} /><span>Ampliar</span></button> : <span className="fitlab-profile-avatar fitlab-profile-initials" aria-label={`Sin foto de ${profile.name}`}>{initials}</span>}
      <div><p className="eyebrow">{profile.own ? 'MI PERFIL' : 'COMUNIDAD FITLAB'}</p><h1>{profile.name}</h1>{profile.bio && <p className="fitlab-profile-bio">{profile.bio}</p>}</div>
    </div>
    {showStats && <div className="fitlab-profile-stats" aria-label="Actividad del perfil">
      {profile.monthlyAttendances !== null && <span><Activity /><strong>{profile.monthlyAttendances}</strong><small>asistencias este mes</small></span>}
      {profile.streak && <span><Flame /><strong>{profile.streak.current_streak}</strong><small>días de racha</small></span>}
      <span><Heart /><strong>{profile.loveCount}</strong><small>Me encanta</small></span>
      {(profile.own || profile.showBadges) && <span><Medal /><strong>{profile.badges.length}</strong><small>medallas</small></span>}
    </div>}
    <div className="fitlab-profile-actions">{actions}{shareUrl && <button type="button" className="ghost" onClick={() => void share()}><Share2 />Compartir perfil</button>}</div>
    {feedback && <p className="form-note" role="status">{feedback}</p>}
    {viewing && profile.avatarUrl && <ProfilePhotoViewer src={profile.avatarUrl} name={profile.name} onClose={() => setViewing(false)} />}
  </header>;
}
