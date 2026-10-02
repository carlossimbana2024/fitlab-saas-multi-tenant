import { useId } from 'react';
export function ProfileTabs({ tabs, selected, onSelect, label }: { tabs: { id: string; label: string }[]; selected: string; onSelect: (id: string) => void; label: string }) {
  const id=useId();
  return <div className="profile-tabs" role="tablist" aria-label={label}>{tabs.map((tab,index)=><button key={tab.id} id={`${id}-${tab.id}`} type="button" role="tab" aria-selected={selected===tab.id} tabIndex={selected===tab.id?0:-1} onClick={()=>onSelect(tab.id)} onKeyDown={event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;onSelect(tabs[next].id);(event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();}}>{tab.label}</button>)}</div>;
}
