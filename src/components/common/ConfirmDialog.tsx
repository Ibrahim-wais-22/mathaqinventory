import React from 'react';
import { AlertCircle, X } from 'lucide-react';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'primary';
  busy?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: React.ReactNode;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  title,
  description,
  confirmLabel = 'تأكيد التنفيذ',
  cancelLabel = 'إلغاء',
  variant = 'primary',
  busy = false,
  confirmDisabled = false,
  onConfirm,
  onCancel,
  children,
}) => {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-md max-h-[90dvh] overflow-y-auto rounded-2xl bg-white border border-zinc-200 p-6 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div
              className={`h-10 w-10 rounded-xl flex items-center justify-center shrink-0 ${
                variant === 'danger' ? 'bg-red-50 text-[#D91B23]' : 'bg-amber-50 text-[#D97706]'
              }`}
            >
              <AlertCircle className="h-5 w-5" />
            </div>
            <h3 className="text-lg font-bold text-zinc-900 font-display">{title}</h3>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 cursor-pointer"
            aria-label="إغلاق"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="mt-3 text-sm text-zinc-600 leading-relaxed">{description}</p>

        {children && <div className="mt-4">{children}</div>}

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="min-h-[42px] px-4 py-2 rounded-xl border border-zinc-200 text-sm font-medium text-zinc-700 hover:bg-zinc-50 transition-colors cursor-pointer"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy || confirmDisabled}
            className={`min-h-[42px] px-5 py-2 rounded-xl text-sm font-semibold text-white transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
              variant === 'danger'
                ? 'bg-[#D91B23] hover:bg-[#B9141B]'
                : 'bg-[#18181B] hover:bg-zinc-800'
            }`}
          >
            {busy ? 'جاري التنفيذ...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
