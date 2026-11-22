import React, { useEffect, useState } from 'react';
import { collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore';
import { CheckCircle2, History, Search, XCircle } from 'lucide-react';
import { APPROVAL_TYPE_LABELS, DEPARTMENT_LABELS } from '../../constants/departments';
import { useFirebase } from '../../app/providers/FirebaseProvider';
import { OperationType, db, handleFirestoreError } from '../../services/firebase/config';
import {
  adminReviewProduct,
  formatActionError,
  reviewReportCorrection,
} from '../../services/inventory/firestoreService';
import type { ApprovalRequest, AuditLog } from '../../types/inventory';
import { StatusBadge } from '../../components/common/StatusBadge';
import { formatTimestampAden } from '../../utils/dateAden';

export const ApprovalsAndAuditView: React.FC = () => {
  const { account, products, categories } = useFirebase();

  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [logSearch, setLogSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    const unsubApp = onSnapshot(
      query(collection(db, 'approvals'), orderBy('createdAt', 'desc'), limit(60)),
      (snap) => {
        setApprovals(
          snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<ApprovalRequest, 'id'>) }))
        );
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'approvals')
    );

    const unsubLogs = onSnapshot(
      query(collection(db, 'auditLogs'), orderBy('createdAt', 'desc'), limit(120)),
      (snap) => {
        setAuditLogs(
          snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<AuditLog, 'id'>) }))
        );
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'auditLogs')
    );

    return () => {
      unsubApp();
      unsubLogs();
    };
  }, []);

  const handleDecision = async (app: ApprovalRequest, decision: 'approve' | 'reject') => {
    if (!account) return;
    setBusy(true);
    setFeedback(null);
    try {
      if (app.type === 'report_correction') {
        await reviewReportCorrection(
          account,
          app,
          decision,
          decision === 'approve' ? 'معتمد من الإدارة العليا' : 'مرفوض من الإدارة',
          products,
          categories
        );
      } else if (app.type === 'product_admin' && app.productId) {
        const prod = products.find((p) => p.id === app.productId);
        if (!prod) {
          throw new Error('تعذر العثور على الصنف المطلوب في دليل الأصناف.');
        }
        await adminReviewProduct(account, prod, decision, '', app);
      }
      setFeedback({
        type: 'success',
        text: decision === 'approve' ? 'تم اعتماد الطلب وتحديث البيانات.' : 'تم رفض الطلب.',
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: formatActionError(err, 'تعذر تنفيذ القرار.'),
      });
    } finally {
      setBusy(false);
    }
  };

  const filteredLogs = auditLogs.filter((l) => {
    if (!logSearch.trim()) return true;
    const q = logSearch.trim();
    return (
      l.actorName.includes(q) ||
      l.action.includes(q) ||
      (l.newValueSummary || '').includes(q) ||
      (l.reason || '').includes(q)
    );
  });

  return (
    <div className="space-y-6">
      <div className="bg-white border border-zinc-200 rounded-2xl p-5">
        <h2 className="text-xl font-bold text-zinc-900 font-display">
          مركز الاعتمادات وسجل العمليات والتدقيق
        </h2>
        <p className="mt-1 text-sm text-zinc-500">
          اعتماد التصحيحات بعد الترحيل مع حفظ القيم القديمة والجديدة، ومراجعة السجل الكامل للعمليات
        </p>
      </div>

      {feedback && (
        <div
          className={`rounded-xl border px-4 py-3 text-sm font-medium ${
            feedback.type === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-red-200 bg-red-50 text-red-700'
          }`}
        >
          {feedback.text}
        </div>
      )}

      {/* Approvals Queue */}
      <div className="bg-white border border-zinc-200 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-zinc-100">
          <h3 className="text-base font-bold text-zinc-900 font-display">
            طلبات الاعتماد والتصحيح ({approvals.length})
          </h3>
        </div>
        {approvals.length === 0 ? (
          <div className="p-8 text-center text-sm text-zinc-500">لا توجد طلبات مسجلة.</div>
        ) : (
          <div className="divide-y divide-zinc-100">
            {approvals.map((app) => (
              <div
                key={app.id}
                className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-4"
              >
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-bold text-[#D91B23]">
                      {APPROVAL_TYPE_LABELS[app.type]}
                    </span>
                    {app.inventoryDate && (
                      <span className="font-mono text-xs text-zinc-500">· {app.inventoryDate}</span>
                    )}
                    {app.department && (
                      <span className="text-xs text-zinc-500">
                        · {DEPARTMENT_LABELS[app.department as keyof typeof DEPARTMENT_LABELS] || app.department}
                      </span>
                    )}
                  </div>
                  <div className="text-sm font-semibold text-zinc-900">{app.reason}</div>
                  {app.type === 'report_correction' && (
                    <div className="text-xs text-zinc-600 tabular-nums">
                      القيمة السابقة: <strong>{app.oldValue ?? 0}</strong> ← القيمة الجديدة:{' '}
                      <strong className="text-[#D91B23]">{app.newValue ?? 0}</strong>
                    </div>
                  )}
                  <div className="text-[11px] text-zinc-400">
                    مقدم الطلب: {app.requestedByName} · {formatTimestampAden(app.createdAt)}
                    {app.reviewedByName ? ` · المراجع: ${app.reviewedByName}` : ''}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {app.status === 'pending' &&
                  (app.type === 'report_correction' || app.type === 'product_admin') ? (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleDecision(app, 'approve')}
                        className="min-h-[38px] inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 py-1.5 text-xs font-bold text-white cursor-pointer"
                      >
                        <CheckCircle2 className="h-4 w-4" />
                        <span>اعتماد</span>
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleDecision(app, 'reject')}
                        className="min-h-[38px] inline-flex items-center gap-1.5 rounded-xl border border-red-200 bg-red-50 px-3.5 py-1.5 text-xs font-bold text-red-700 cursor-pointer"
                      >
                        <XCircle className="h-4 w-4" />
                        <span>رفض</span>
                      </button>
                    </>
                  ) : (
                    <StatusBadge
                      label={
                        app.status === 'approved'
                          ? 'معتمد'
                          : app.status === 'rejected'
                          ? 'مرفوض'
                          : 'قيد المراجعة الفنية'
                      }
                      tone={
                        app.status === 'approved'
                          ? 'success'
                          : app.status === 'rejected'
                          ? 'danger'
                          : 'warning'
                      }
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Immutable Audit Logs */}
      <div className="bg-white border border-zinc-200 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-zinc-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-zinc-500" />
            <h3 className="text-base font-bold text-zinc-900 font-display">
              سجل العمليات والتعديلات غير القابل للحذف
            </h3>
          </div>
          <div className="relative">
            <Search className="h-4 w-4 text-zinc-400 absolute right-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={logSearch}
              onChange={(e) => setLogSearch(e.target.value)}
              placeholder="بحث في السجل..."
              className="min-h-[38px] rounded-xl border border-zinc-200 pr-9 pl-3 text-xs"
            />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead className="bg-zinc-50 border-b border-zinc-200 text-zinc-500">
              <tr>
                <th className="px-4 py-3 font-semibold">الوقت (عدن)</th>
                <th className="px-3 py-3 font-semibold">المستخدم</th>
                <th className="px-3 py-3 font-semibold">العملية</th>
                <th className="px-3 py-3 font-semibold">التفاصيل / القيم</th>
                <th className="px-3 py-3 font-semibold">السبب</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {filteredLogs.map((log) => (
                <tr key={log.id} className="hover:bg-zinc-50/70">
                  <td className="px-4 py-3 tabular-nums text-zinc-500 whitespace-nowrap">
                    {formatTimestampAden(log.createdAt)}
                  </td>
                  <td className="px-3 py-3 font-semibold text-zinc-900">{log.actorName}</td>
                  <td className="px-3 py-3 font-semibold text-[#D91B23]">
                    {log.action.replace(/_/g, ' ')}
                  </td>
                  <td className="px-3 py-3 text-zinc-700">
                    {log.oldValueSummary ? `${log.oldValueSummary} ← ` : ''}
                    {log.newValueSummary || '—'}
                  </td>
                  <td className="px-3 py-3 text-zinc-500">{log.reason || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
