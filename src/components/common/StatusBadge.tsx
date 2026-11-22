import React from 'react';
import { CheckCircle2, Clock, Lock, XCircle, AlertTriangle } from 'lucide-react';

export type StatusTone = 'success' | 'warning' | 'danger' | 'neutral' | 'info';

export const StatusBadge: React.FC<{
  label: string;
  tone: StatusTone;
  icon?: 'check' | 'clock' | 'lock' | 'error' | 'alert';
}> = ({ label, tone, icon }) => {
  const toneClasses: Record<StatusTone, string> = {
    success: 'text-emerald-700 bg-emerald-50 border-emerald-200',
    warning: 'text-amber-800 bg-amber-50 border-amber-200',
    danger: 'text-red-700 bg-red-50 border-red-200',
    info: 'text-sky-800 bg-sky-50 border-sky-200',
    neutral: 'text-zinc-700 bg-zinc-100 border-zinc-200',
  };

  const IconComp =
    icon === 'check'
      ? CheckCircle2
      : icon === 'clock'
      ? Clock
      : icon === 'lock'
      ? Lock
      : icon === 'error'
      ? XCircle
      : icon === 'alert'
      ? AlertTriangle
      : null;

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs font-semibold whitespace-nowrap shrink-0 ${toneClasses[tone]}`}
    >
      {IconComp && <IconComp className="h-3.5 w-3.5 shrink-0" />}
      <span>{label}</span>
    </span>
  );
};
