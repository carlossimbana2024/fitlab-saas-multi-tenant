export function PrivacySwitch({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return <label className="profile-privacy-switch"><span>{label}</span><input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)}/><span className="profile-switch-track" aria-hidden="true"/></label>;
}
