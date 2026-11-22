import React, { useEffect, useState } from 'react';
import { collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore';
import { ArrowUpLeft, History, X } from 'lucide-react';
import { OperationType, db, handleFirestoreError } from '../../services/firebase/config';
import type { AuditLog } from '../../types/inventory';
import { formatTimestampAden } from '../../utils/dateAden';

interface RecentActivityDrawerProps {
  open: boolean;
  onClose: () => void;
  onOpenFullAudit: () => void;
}

export const RecentActivityDrawer: React.FC<RecentActivityDrawerProps> = ({
  open,
  onClose,
  onOpenFullAudit,
}) => {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    const unsub = onSnapshot(
      query(collection(db, 'auditLogs'), orderBy('createdAt', 'desc'), limit(20)),
      (snap) => {
        setLogs(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<AuditLog, 'id'>) })));
        setLoading(false);
      },
      (err) => {
        setLoading(false);
        handleFirestoreError(err, OperationType.LIST, 'auditLogs');
      }
    );
    return () => unsub();
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end no-print" dir="rtl">
      {/* Backdrop */}
      <button
        type="button"
        aria-label="إغلاق سجل العمليات"
        onClick={onClose}
        className="fixed inset-0 bg-black/35 backdrop-blur-[1px] cursor-pointer"
      />

      {/* Side Drawer Panel (trailing left edge in RTL) */}
      <aside
        aria-label="آخر العمليات والتعديلات"
        className="relative z-10 h-full w-full max-w-md bg-white border-r border-zinc-200 shadow-2xl flex flex-col mr-auto"
      >
        <div className="px-5 py-4 border-b border-zinc-200 flex items-center justify-between gap-3 bg-white">
          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-xl bg-red-50 text-[#D91B23] flex items-center justify-center shrink-0">
              <History className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-base font-bold text-zinc-900 font-display">
                آخر العمليات والتعديلات
              </h2>
              <p className="text-[11px] text-zinc-500">أحدث 20 عملية مسجلة في النظام</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق"
            className="h-9 w-9 rounded-xl border border-zinc-200 flex items-center justify-center text-zinc-500 hover:text-zinc-900 hover:bg-zinc-50 cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-zinc-100">
          {loading ? (
            <div className="p-8 text-center text-xs text-zinc-500">جاري تحميل آخر العمليات...</div>
          ) : logs.length === 0 ? (
            <div className="p-8 text-center text-xs text-zinc-500">لا توجد عمليات مسجلة بعد.</div>
          ) : (
            logs.map((log) => (
              <div key={log.id} className="px-5 py-3.5 space-y-1 hover:bg-zinc-50/70">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-bold text-zinc-900 truncate">{log.actorName}</span>
                  <span className="text-[11px] text-zinc-400 tabular-nums shrink-0">
                    {formatTimestampAden(log.createdAt)}
                  </span>
                </div>
                <div className="text-xs font-semibold text-[#D91B23]">
                  {log.action.replace(/_/g, ' ')}
                </div>
                {(log.newValueSummary || log.oldValueSummary) && (
                  <div className="text-xs text-zinc-600 leading-relaxed">
                    {log.oldValueSummary ? `${log.oldValueSummary} ← ` : ''}
                    {log.newValueSummary || ''}
                  </div>
                )}
                {log.reason && (
                  <div className="text-[11px] text-zinc-400">السبب: {log.reason}</div>
                )}
              </div>
            ))
          )}
        </div>

        <div className="p-4 border-t border-zinc-200 bg-zinc-50/70">
          <button
            type="button"
            onClick={() => {
              onClose();
              onOpenFullAudit();
            }}
            className="w-full min-h-[42px] inline-flex items-center justify-center gap-2 rounded-xl bg-[#18181B] px-4 py-2 text-xs font-bold text-white hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            <span>فتح سجل التدقيق الكامل</span>
            <ArrowUpLeft className="h-4 w-4" />
          </button>
        </div>
      </aside>
    </div>
  );
};
