import React, { useEffect, useState } from 'react';
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore';
import { ArrowLeftRight } from 'lucide-react';
import {
  DEFAULT_BRANCH_ID,
  DEPARTMENT_LABELS,
  OPERATIONAL_DEPARTMENTS,
  REPORT_STATUS_LABELS,
} from '../../constants/departments';
import { useFirebase } from '../../app/providers/FirebaseProvider';
import { db } from '../../services/firebase/config';
import {
  formatActionError,
  transferDepartmentReportBetweenDates,
} from '../../services/inventory/firestoreService';
import type { DepartmentReport, OperationalDepartmentId } from '../../types/inventory';
import { getPreviousAdenDate, getTodayAdenDate, makeSessionId } from '../../utils/dateAden';
import { ConfirmDialog } from '../common/ConfirmDialog';

interface ReportDateTransferModalProps {
  open: boolean;
  initialDepartment?: OperationalDepartmentId;
  initialFromDate?: string;
  initialToDate?: string;
  onClose: () => void;
  onSuccess?: (message: string) => void;
}

export const ReportDateTransferModal: React.FC<ReportDateTransferModalProps> = ({
  open,
  initialDepartment = 'sales',
  initialFromDate,
  initialToDate,
  onClose,
  onSuccess,
}) => {
  const { account, isAdmin, currentSession, products, categories, inventoryDate, setInventoryDate } =
    useFirebase();

  const [dept, setDept] = useState<OperationalDepartmentId>(initialDepartment);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [includeTransfers, setIncludeTransfers] = useState(true);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [preview, setPreview] = useState<{
    loading: boolean;
    error: string | null;
    sourceCount: number;
    sourceTransfersCount: number;
    sourceStatus: DepartmentReport['status'] | null;
    targetCount: number;
    targetTransfersCount: number;
    targetStatus: DepartmentReport['status'] | null;
  }>({
    loading: false,
    error: null,
    sourceCount: 0,
    sourceTransfersCount: 0,
    sourceStatus: null,
    targetCount: 0,
    targetTransfersCount: 0,
    targetStatus: null,
  });

  // Reset defaults whenever modal opens
  useEffect(() => {
    if (!open) return;
    const todayAden = getTodayAdenDate();
    const yesterdayAden = getPreviousAdenDate(todayAden);

    const defaultFrom =
      initialFromDate ||
      (inventoryDate === yesterdayAden ? todayAden : inventoryDate);
    const defaultTo =
      initialToDate ||
      (initialFromDate
        ? getPreviousAdenDate(initialFromDate)
        : inventoryDate === yesterdayAden
        ? yesterdayAden
        : getPreviousAdenDate(inventoryDate));

    setDept(initialDepartment);
    setFromDate(defaultFrom);
    setToDate(defaultTo);
    setIncludeTransfers(true);
    setReason('');
    setErrorMsg(null);
  }, [open, initialDepartment, initialFromDate, initialToDate, inventoryDate]);

  // Live inspection of source & target data
  useEffect(() => {
    if (!open || !account || !isAdmin || !fromDate || !toDate) return;
    let active = true;
    const branchId = currentSession?.branchId || account.branchId || DEFAULT_BRANCH_ID;
    const srcSessId = makeSessionId(branchId, fromDate);
    const tgtSessId = makeSessionId(branchId, toDate);
    const srcRepId = `${srcSessId}_${dept}`;
    const tgtRepId = `${tgtSessId}_${dept}`;

    setPreview((prev) => ({ ...prev, loading: true, error: null }));

    Promise.all([
      getDoc(doc(db, 'departmentReports', srcRepId)),
      getDocs(collection(db, 'departmentReports', srcRepId, 'items')),
      getDoc(doc(db, 'departmentReports', tgtRepId)),
      getDocs(collection(db, 'departmentReports', tgtRepId, 'items')),
      dept === 'production'
        ? getDocs(query(collection(db, 'productionEntries'), where('sessionId', '==', srcSessId)))
        : Promise.resolve(null),
      dept === 'production'
        ? getDocs(query(collection(db, 'productionEntries'), where('sessionId', '==', tgtSessId)))
        : Promise.resolve(null),
      dept === 'factory'
        ? getDocs(query(collection(db, 'factoryTransfers'), where('sessionId', '==', srcSessId)))
        : Promise.resolve(null),
      dept === 'factory'
        ? getDocs(query(collection(db, 'factoryTransfers'), where('sessionId', '==', tgtSessId)))
        : Promise.resolve(null),
    ])
      .then(([srcRep, srcItems, tgtRep, tgtItems, srcProd, tgtProd, srcTrfs, tgtTrfs]) => {
        if (!active) return;
        const srcCount = Math.max(srcItems.size, srcProd ? srcProd.size : 0);
        const tgtCount = Math.max(tgtItems.size, tgtProd ? tgtProd.size : 0);
        const srcTransfersCount = srcTrfs ? srcTrfs.size : 0;
        const tgtTransfersCount = tgtTrfs ? tgtTrfs.size : 0;

        setPreview({
          loading: false,
          error: null,
          sourceCount: srcCount,
          sourceTransfersCount: srcTransfersCount,
          sourceStatus: srcRep.exists()
            ? (srcRep.data() as DepartmentReport).status
            : srcCount > 0 || srcTransfersCount > 0
            ? 'submitted'
            : null,
          targetCount: tgtCount,
          targetTransfersCount: tgtTransfersCount,
          targetStatus: tgtRep.exists()
            ? (tgtRep.data() as DepartmentReport).status
            : tgtCount > 0 || tgtTransfersCount > 0
            ? 'submitted'
            : null,
        });
      })
      .catch((err) => {
        if (!active) return;
        setPreview({
          loading: false,
          error: formatActionError(err, 'تعذر فحص بيانات التاريخين.'),
          sourceCount: 0,
          sourceTransfersCount: 0,
          sourceStatus: null,
          targetCount: 0,
          targetTransfersCount: 0,
          targetStatus: null,
        });
      });

    return () => {
      active = false;
    };
  }, [open, dept, fromDate, toDate, account?.uid, isAdmin, currentSession?.branchId]);

  if (!isAdmin) return null;

  const hasSourceData =
    preview.sourceCount > 0 ||
    (dept === 'factory' && includeTransfers && preview.sourceTransfersCount > 0);

  const handleConfirm = async () => {
    if (!account) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const branchId = currentSession?.branchId || account.branchId || DEFAULT_BRANCH_ID;
      const res = await transferDepartmentReportBetweenDates(
        account,
        branchId,
        dept,
        fromDate,
        toDate,
        reason,
        products,
        categories,
        { includeFactoryTransfers: dept === 'factory' ? includeTransfers : false }
      );
      setInventoryDate(toDate);
      const parts: string[] = [];
      if (res.movedItemsCount > 0) parts.push(`${res.movedItemsCount} صنف`);
      if (res.movedTransfersCount > 0) parts.push(`${res.movedTransfersCount} إشعار توريد/مرتجع`);
      const summary = parts.length > 0 ? ` (${parts.join(' و ')})` : '';
      const msg = `تم نقل بيانات ${DEPARTMENT_LABELS[dept]}${summary} من ${fromDate} إلى ${toDate} وإعادة احتساب اليومين بنجاح.`;
      onClose();
      onSuccess?.(msg);
    } catch (err) {
      setErrorMsg(formatActionError(err, 'تعذر نقل التقرير بين التاريخين.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      open={open}
      title="نقل تقرير مُرحّل أو مدخل إلى تاريخ آخر (للإدارة فقط)"
      description="ينقل بيانات القسم (سواء كانت مُرحّلة أو مسودة) من التاريخ المُدخل بالخطأ إلى التاريخ الصحيح، ويُفرغ تقرير المصدر ليعود مسودة، مع إعادة احتساب اليومين تلقائياً."
      confirmLabel="تنفيذ النقل وإعادة الاحتساب"
      variant="danger"
      busy={busy}
      confirmDisabled={!fromDate || !toDate || fromDate === toDate || preview.loading || !hasSourceData}
      onConfirm={() => void handleConfirm()}
      onCancel={() => {
        if (!busy) onClose();
      }}
    >
      <div className="space-y-3">
        {errorMsg && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
            {errorMsg}
          </div>
        )}

        <div>
          <label className="block text-xs font-semibold text-zinc-700 mb-1">القسم</label>
          <select
            value={dept}
            onChange={(e) => setDept(e.target.value as OperationalDepartmentId)}
            className="w-full min-h-[40px] rounded-xl border border-zinc-200 bg-white px-3 text-sm font-semibold text-zinc-800"
          >
            {OPERATIONAL_DEPARTMENTS.map((d) => (
              <option key={d} value={d}>
                {DEPARTMENT_LABELS[d]}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-semibold text-zinc-700 mb-1">
              من تاريخ (المُدخل بالخطأ)
            </label>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="w-full min-h-[40px] rounded-xl border border-zinc-200 bg-white px-3 text-sm font-semibold tabular-nums"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-zinc-700 mb-1">
              إلى تاريخ (التاريخ الصحيح)
            </label>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="w-full min-h-[40px] rounded-xl border border-zinc-200 bg-white px-3 text-sm font-semibold tabular-nums"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setFromDate(toDate);
              setToDate(fromDate);
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-[11px] font-bold text-zinc-700 hover:bg-zinc-100 cursor-pointer"
          >
            <ArrowLeftRight className="h-3.5 w-3.5 text-[#D91B23]" />
            <span>عكس التاريخين</span>
          </button>
          <button
            type="button"
            onClick={() => {
              const today = getTodayAdenDate();
              setFromDate(today);
              setToDate(getPreviousAdenDate(today));
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-[11px] font-bold text-zinc-700 hover:bg-zinc-100 cursor-pointer"
          >
            <span>سحب من اليوم إلى أمس</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setFromDate(inventoryDate);
              setToDate(getPreviousAdenDate(inventoryDate));
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-[11px] font-bold text-zinc-700 hover:bg-zinc-100 cursor-pointer"
          >
            <span>من المعروض إلى اليوم السابق له</span>
          </button>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 space-y-1.5 text-xs">
          {preview.loading ? (
            <p className="text-zinc-500">جاري فحص بيانات التاريخين...</p>
          ) : preview.error ? (
            <p className="text-red-600 font-semibold">{preview.error}</p>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className="text-zinc-600">بيانات المصدر ({fromDate}):</span>
                {hasSourceData ? (
                  <span className="font-bold text-emerald-700 tabular-nums">
                    {preview.sourceCount > 0 ? `${preview.sourceCount} صنف` : ''}
                    {preview.sourceCount > 0 && dept === 'factory' && preview.sourceTransfersCount > 0
                      ? ' + '
                      : ''}
                    {dept === 'factory' && preview.sourceTransfersCount > 0
                      ? `${preview.sourceTransfersCount} إشعار توريد/مرتجع`
                      : ''}{' '}
                    ({preview.sourceStatus ? REPORT_STATUS_LABELS[preview.sourceStatus] : 'مدخل'}) — جاهز للنقل
                  </span>
                ) : (
                  <span className="font-bold text-red-600">لا توجد بيانات مدخلة في هذا التاريخ</span>
                )}
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-zinc-600">بيانات الوجهة ({toDate}):</span>
                {preview.targetCount > 0 || (dept === 'factory' && preview.targetTransfersCount > 0) ? (
                  <span className="font-semibold text-amber-800 tabular-nums">
                    {preview.targetCount > 0
                      ? `${preview.targetCount} صنف حالياً (سيُستبدل بالمنقول)`
                      : `${preview.targetTransfersCount} إشعار توريد حالياً`}
                  </span>
                ) : (
                  <span className="font-semibold text-zinc-600">فارغ وجاهز للاستقبال</span>
                )}
              </div>
            </>
          )}
        </div>

        {dept === 'factory' && preview.sourceTransfersCount > 0 && (
          <label className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900 cursor-pointer">
            <input
              type="checkbox"
              checked={includeTransfers}
              onChange={(e) => setIncludeTransfers(e.target.checked)}
              className="h-4 w-4 accent-[#D91B23]"
            />
            <span>
              نقل إشعارات التوريد والمرتجعات معها ({preview.sourceTransfersCount} إشعار)
            </span>
          </label>
        )}

        <div>
          <label className="block text-xs font-semibold text-zinc-700 mb-1">
            سبب النقل (اختياري — يُوثق في سجل التدقيق)
          </label>
          <textarea
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="مثال: تم ترحيل تقرير يوم 25 داخل يوم 26 بالخطأ..."
            className="w-full rounded-xl border border-zinc-200 p-3 text-sm"
          />
        </div>
      </div>
    </ConfirmDialog>
  );
};
