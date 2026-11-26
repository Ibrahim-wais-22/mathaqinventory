import React, { useEffect, useMemo, useState } from 'react';
import { collection, doc, getDoc, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import {
  AlertTriangle,
  ArrowLeftRight,
  ArrowUpLeft,
  CalendarCheck,
  CheckCircle2,
  Lock,
  RefreshCw,
  Unlock,
} from 'lucide-react';
import {
  DEFAULT_BRANCH_ID,
  DEPARTMENT_LABELS,
  OPERATIONAL_DEPARTMENTS,
  REPORT_STATUS_LABELS,
  SESSION_STATUS_LABELS,
  TRANSFER_STATUS_LABELS,
  VARIANCE_LABELS,
} from '../../constants/departments';
import { useFirebase } from '../../app/providers/FirebaseProvider';
import { OperationType, db, handleFirestoreError } from '../../services/firebase/config';
import { checkSessionClosingReadiness, roundQty } from '../../services/inventory/calculator';
import {
  closeDailySession,
  formatActionError,
  recalculateSessionResults,
  reopenDailySession,
  transferDepartmentReportBetweenDates,
} from '../../services/inventory/firestoreService';
import type {
  ApprovalRequest,
  DailySession,
  DepartmentReport,
  FactoryTransfer,
  OperationalDepartmentId,
  ProductResult,
} from '../../types/inventory';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';
import { StatusBadge } from '../../components/common/StatusBadge';
import { formatArabicDate, getPreviousAdenDate, makeSessionId, shiftIsoDate } from '../../utils/dateAden';

export type NavTabId =
  | 'dashboard'
  | 'factory'
  | 'production'
  | 'sales'
  | 'waste'
  | 'catalog'
  | 'users'
  | 'approvals'
  | 'reports';

export const ExecutiveDashboard: React.FC<{
  onNavigate: (tab: NavTabId, reportFilter?: string) => void;
}> = ({ onNavigate }) => {
  const { account, currentSession, categories, products, inventoryDate, setInventoryDate } =
    useFirebase();

  const [reports, setReports] = useState<DepartmentReport[]>([]);
  const [transfers, setTransfers] = useState<FactoryTransfer[]>([]);
  const [results, setResults] = useState<ProductResult[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([]);
  const [recentSessions, setRecentSessions] = useState<DailySession[]>([]);

  const [calculating, setCalculating] = useState(false);
  const [closeModalOpen, setCloseModalOpen] = useState(false);
  const [closeNote, setCloseNote] = useState('');
  const [reopenModalOpen, setReopenModalOpen] = useState(false);
  const [reopenReason, setReopenReason] = useState('');
  const [transferModalOpen, setTransferModalOpen] = useState(false);
  const [transferDept, setTransferDept] = useState<OperationalDepartmentId>('sales');
  const [transferFromDate, setTransferFromDate] = useState(inventoryDate);
  const [transferToDate, setTransferToDate] = useState(() => getPreviousAdenDate(inventoryDate));
  const [transferReason, setTransferReason] = useState('');
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (!currentSession) return;

    const unsubRep = onSnapshot(
      query(collection(db, 'departmentReports'), where('sessionId', '==', currentSession.id)),
      (snap) => {
        setReports(
          snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<DepartmentReport, 'id'>) }))
        );
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'departmentReports')
    );

    const unsubTrf = onSnapshot(
      query(collection(db, 'factoryTransfers'), where('sessionId', '==', currentSession.id)),
      (snap) => {
        setTransfers(
          snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<FactoryTransfer, 'id'>) }))
        );
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'factoryTransfers')
    );

    const unsubRes = onSnapshot(
      query(collection(db, 'productResults'), where('sessionId', '==', currentSession.id)),
      (snap) => {
        setResults(
          snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<ProductResult, 'id'>) }))
        );
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'productResults')
    );

    const unsubApp = onSnapshot(
      query(collection(db, 'approvals'), where('status', '==', 'pending')),
      (snap) => {
        setPendingApprovals(
          snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<ApprovalRequest, 'id'>) }))
        );
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'approvals')
    );

    const unsubSess = onSnapshot(
      query(collection(db, 'dailySessions'), orderBy('inventoryDate', 'desc'), limit(7)),
      (snap) => {
        setRecentSessions(
          snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<DailySession, 'id'>) }))
        );
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'dailySessions')
    );

    return () => {
      unsubRep();
      unsubTrf();
      unsubRes();
      unsubApp();
      unsubSess();
    };
  }, [currentSession?.id]);

  const reportsSignature = useMemo(
    () =>
      reports
        .map((r) => `${r.id}:${r.status}:${r.itemCount}:${r.updatedAt?.seconds ?? 0}`)
        .sort()
        .join('|'),
    [reports]
  );

  const transfersSignature = useMemo(
    () =>
      transfers
        .map((t) => `${t.id}:${t.status}:${t.totalReceivedQty}:${t.updatedAt?.seconds ?? 0}`)
        .sort()
        .join('|'),
    [transfers]
  );

  // Keep central calculations synced when Management views an open/reopened session
  useEffect(() => {
    if (
      !account ||
      !currentSession ||
      currentSession.status === 'closed' ||
      products.length === 0 ||
      categories.length === 0
    ) {
      return;
    }
    const timer = setTimeout(() => {
      void recalculateSessionResults(account, currentSession, products, categories);
    }, 350);
    return () => clearTimeout(timer);
  }, [
    account?.uid,
    currentSession?.id,
    currentSession?.status,
    reportsSignature,
    transfersSignature,
    products.length,
    categories.length,
  ]);

  const handleManualRecalculate = async () => {
    if (!account || !currentSession) return;
    setCalculating(true);
    setFeedback(null);
    try {
      const prevDate = getPreviousAdenDate(currentSession.inventoryDate);
      const prevSnap = await getDoc(
        doc(db, 'dailySessions', makeSessionId(currentSession.branchId, prevDate))
      );
      if (prevSnap.exists() && prevSnap.data()?.status !== 'closed') {
        await recalculateSessionResults(
          account,
          { id: prevSnap.id, ...(prevSnap.data() as Omit<DailySession, 'id'>) },
          products,
          categories
        );
      }

      await recalculateSessionResults(account, currentSession, products, categories);

      const nextDate = shiftIsoDate(currentSession.inventoryDate, 1);
      const nextSnap = await getDoc(
        doc(db, 'dailySessions', makeSessionId(currentSession.branchId, nextDate))
      );
      if (nextSnap.exists() && nextSnap.data()?.status !== 'closed') {
        await recalculateSessionResults(
          account,
          { id: nextSnap.id, ...(nextSnap.data() as Omit<DailySession, 'id'>) },
          products,
          categories
        );
      }

      setFeedback({
        type: 'success',
        text: 'تم تحديث الحساب الآلي ونقل المتبقي الصالح مؤقتاً للمطابقة والتأكد قبل الإغلاق.',
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: formatActionError(err, 'تعذر إعادة الاحتساب.'),
      });
    } finally {
      setCalculating(false);
    }
  };

  const readiness = useMemo(
    () => checkSessionClosingReadiness(currentSession, reports, transfers),
    [currentSession, reports, transfers]
  );

  const kpis = useMemo(() => {
    const totals = results.reduce(
      (acc, r) => {
        acc.factoryReceived += r.factoryReceivedQty;
        acc.factoryReturned += r.factoryReturnedQty ?? 0;
        acc.indProduction += r.independentProductionQty;
        acc.sales += r.salesQty;
        acc.damaged += r.damagedQty;
        acc.validRemaining += r.validRemainingQty;
        acc.invalidRemaining += r.invalidRemainingQty;
        if (r.variance !== 0) acc.varianceItemsCount += 1;
        return acc;
      },
      {
        factoryReceived: 0,
        factoryReturned: 0,
        indProduction: 0,
        sales: 0,
        damaged: 0,
        validRemaining: 0,
        invalidRemaining: 0,
        varianceItemsCount: 0,
      }
    );
    return {
      factoryReceived: roundQty(totals.factoryReceived),
      factoryReturned: roundQty(totals.factoryReturned),
      indProduction: roundQty(totals.indProduction),
      sales: roundQty(totals.sales),
      damaged: roundQty(totals.damaged),
      validRemaining: roundQty(totals.validRemaining),
      invalidRemaining: roundQty(totals.invalidRemaining),
      varianceItemsCount: totals.varianceItemsCount,
    };
  }, [results]);

  const varianceRows = useMemo(() => results.filter((r) => r.variance !== 0), [results]);
  const deliveryVarianceTransfers = useMemo(
    () =>
      transfers.filter(
        (t) =>
          t.transferType !== 'return' &&
          t.status !== 'returned' &&
          (t.totalVarianceQty !== 0 || t.status === 'discrepancy_logged')
      ),
    [transfers]
  );

  const handleCloseDay = async () => {
    if (!account || !currentSession) return;
    setCalculating(true);
    setFeedback(null);
    try {
      await closeDailySession(account, currentSession, reports, products, categories, closeNote);
      setCloseModalOpen(false);
      setCloseNote('');
      setFeedback({
        type: 'success',
        text: 'تم إغلاق يوم الجرد واعتماد النتائج ونقل المتبقي الصالح فقط لليوم التالي.',
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: formatActionError(err, 'تعذر إغلاق اليوم.'),
      });
    } finally {
      setCalculating(false);
    }
  };

  const handleReopenDay = async () => {
    if (!account || !currentSession) return;
    setCalculating(true);
    setFeedback(null);
    try {
      await reopenDailySession(account, currentSession, reports, reopenReason);
      setReopenModalOpen(false);
      setReopenReason('');
      setFeedback({
        type: 'success',
        text: 'تمت إعادة فتح اليوم المغلق للتصحيح الموثق.',
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: formatActionError(err, 'تعذر إعادة فتح اليوم.'),
      });
    } finally {
      setCalculating(false);
    }
  };

  const openTransferModal = () => {
    setTransferDept('sales');
    setTransferFromDate(inventoryDate);
    setTransferToDate(getPreviousAdenDate(inventoryDate));
    setTransferReason('');
    setTransferModalOpen(true);
  };

  const handleTransferReportBetweenDates = async () => {
    if (!account) return;
    setCalculating(true);
    setFeedback(null);
    try {
      const branchId = currentSession?.branchId || account.branchId || DEFAULT_BRANCH_ID;
      const res = await transferDepartmentReportBetweenDates(
        account,
        branchId,
        transferDept,
        transferFromDate,
        transferToDate,
        transferReason,
        products,
        categories
      );
      setTransferModalOpen(false);
      setTransferReason('');
      setInventoryDate(transferToDate);
      setFeedback({
        type: 'success',
        text: `تم نقل تقرير ${DEPARTMENT_LABELS[transferDept]} (${res.movedItemsCount} صنف) من ${transferFromDate} إلى ${transferToDate} وإعادة احتساب اليومين بنجاح.`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: formatActionError(err, 'تعذر نقل التقرير بين التاريخين.'),
      });
    } finally {
      setCalculating(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Executive Session Control Bar */}
      <div className="bg-white border border-zinc-200 rounded-2xl p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-xl font-bold text-zinc-900 font-display">
              لوحة التحكم التنفيذية للجرد
            </h2>
            {currentSession && (
              <StatusBadge
                label={SESSION_STATUS_LABELS[currentSession.status]}
                tone={
                  currentSession.status === 'closed'
                    ? 'neutral'
                    : currentSession.status === 'reopened'
                    ? 'warning'
                    : 'success'
                }
                icon={currentSession.status === 'closed' ? 'lock' : 'check'}
              />
            )}
          </div>
          <p className="mt-1 text-sm text-zinc-500">
            {formatArabicDate(inventoryDate)} · توقيت التشغيل: Asia/Aden
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            disabled={calculating || currentSession?.status === 'closed'}
            onClick={() => void handleManualRecalculate()}
            className="min-h-[42px] inline-flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-2 text-xs font-semibold text-zinc-800 hover:bg-zinc-50 cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${calculating ? 'animate-spin' : ''}`} />
            <span>تحديث الحساب الآلي</span>
          </button>

          {currentSession?.status === 'closed' ? (
            <button
              type="button"
              onClick={() => setReopenModalOpen(true)}
              className="min-h-[42px] inline-flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2 text-xs font-bold text-amber-900 hover:bg-amber-100 cursor-pointer"
            >
              <Unlock className="h-4 w-4" />
              <span>إعادة فتح اليوم للتصحيح</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setCloseModalOpen(true)}
              className="min-h-[42px] inline-flex items-center gap-2 rounded-xl bg-[#D91B23] px-4 py-2 text-xs font-bold text-white hover:bg-[#B9141B] cursor-pointer"
            >
              <Lock className="h-4 w-4" />
              <span>اعتماد وإغلاق يوم الجرد</span>
            </button>
          )}
        </div>
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

      {currentSession && !currentSession.openingBalanceApproved && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-2.5 text-xs text-amber-900">
            <AlertTriangle className="h-4 w-4 text-amber-700 shrink-0 mt-0.5" />
            <span>
              اليوم السابق (<strong>{getPreviousAdenDate(inventoryDate)}</strong>) غير مغلق بعد؛ يمكنك
              الضغط على <strong>«تحديث ونقل المتبقي للمطابقة»</strong> لسحب المتبقي الصالح مؤقتاً والتأكد
              من المطابقة قبل الإغلاق النهائي.
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={calculating || currentSession.status === 'closed'}
              onClick={() => void handleManualRecalculate()}
              className="min-h-[34px] rounded-lg bg-[#D91B23] px-3 text-xs font-bold text-white hover:bg-[#B9141B] cursor-pointer whitespace-nowrap disabled:opacity-50"
            >
              تحديث ونقل المتبقي للمطابقة
            </button>
            <button
              type="button"
              onClick={() => setInventoryDate(getPreviousAdenDate(inventoryDate))}
              className="min-h-[34px] rounded-lg border border-amber-300 bg-white px-3 text-xs font-bold text-amber-900 hover:bg-amber-100 cursor-pointer whitespace-nowrap"
            >
              فتح يوم {getPreviousAdenDate(inventoryDate)} لإغلاقه
            </button>
          </div>
        </div>
      )}

      {/* Clickable 6-Metric KPI Strip */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
        {[
          {
            label: 'وارد المعمل المستلم',
            value: kpis.factoryReceived,
            target: 'reports' as NavTabId,
            filter: 'factory_transfers',
          },
          {
            label: 'الإنتاج المستقل',
            value: kpis.indProduction,
            target: 'reports' as NavTabId,
            filter: 'independent_production',
          },
          {
            label: 'إجمالي المبيعات (وحدة)',
            value: kpis.sales,
            target: 'reports' as NavTabId,
            filter: 'sales_by_product',
          },
          {
            label: 'إجمالي التالف',
            value: kpis.damaged,
            target: 'reports' as NavTabId,
            filter: 'waste_report',
          },
          {
            label: 'المتبقي الصالح',
            value: kpis.validRemaining,
            target: 'reports' as NavTabId,
            filter: 'waste_report',
          },
          {
            label: 'المتبقي غير الصالح',
            value: kpis.invalidRemaining,
            target: 'reports' as NavTabId,
            filter: 'waste_report',
          },
        ].map((card) => (
          <button
            key={card.label}
            type="button"
            onClick={() => onNavigate(card.target, card.filter)}
            className="text-right bg-white border border-zinc-200 rounded-2xl p-4 hover:border-[#D91B23]/50 transition-colors cursor-pointer group"
          >
            <div className="flex items-center justify-between text-xs text-zinc-500">
              <span>{card.label}</span>
              <ArrowUpLeft className="h-3.5 w-3.5 text-zinc-400 group-hover:text-[#D91B23]" />
            </div>
            <div className="mt-2 text-2xl font-extrabold text-zinc-900 tabular-nums font-display">
              {card.value}
            </div>
            {card.filter === 'factory_transfers' && kpis.factoryReturned > 0 && (
              <div className="mt-1 text-[11px] text-zinc-500 tabular-nums">
                بعد خصم {kpis.factoryReturned} مرتجع للمعمل
              </div>
            )}
          </button>
        ))}
      </div>

      {/* Department Reports Status + Variance (Shortage & Surplus) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-5 bg-white border border-zinc-200 rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-100 flex items-center justify-between gap-2">
            <h3 className="text-base font-bold text-zinc-900 font-display">حالة تقارير الإدارات</h3>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={openTransferModal}
                className="inline-flex items-center gap-1 text-xs font-bold text-zinc-700 hover:text-[#D91B23] cursor-pointer whitespace-nowrap"
                title="نقل تقرير تم إدخاله بتاريخ خاطئ إلى التاريخ الصحيح (للإدارة فقط)"
              >
                <ArrowLeftRight className="h-3.5 w-3.5" />
                <span>نقل لتاريخ آخر</span>
              </button>
              <button
                type="button"
                onClick={() => onNavigate('reports', 'department_compliance')}
                className="text-xs font-semibold text-[#D91B23] hover:underline cursor-pointer whitespace-nowrap"
              >
                التفاصيل
              </button>
            </div>
          </div>
          <div className="divide-y divide-zinc-100">
            {OPERATIONAL_DEPARTMENTS.map((dept) => {
              const rep = reports.find((r) => r.department === dept);
              return (
                <button
                  key={dept}
                  type="button"
                  onClick={() => onNavigate(dept)}
                  className="w-full px-5 py-3.5 flex items-center justify-between hover:bg-zinc-50 cursor-pointer"
                >
                  <div className="text-right">
                    <div className="text-sm font-bold text-zinc-900">{DEPARTMENT_LABELS[dept]}</div>
                    <div className="text-xs text-zinc-500">
                      {rep ? `${rep.itemCount} صنف مدخل` : 'لم يبدأ الإدخال بعد'}
                    </div>
                  </div>
                  <StatusBadge
                    label={rep ? REPORT_STATUS_LABELS[rep.status] : 'لم يبدأ'}
                    tone={
                      !rep
                        ? 'neutral'
                        : rep.status === 'draft'
                        ? 'warning'
                        : 'success'
                    }
                  />
                </button>
              );
            })}
          </div>
        </div>

        <div className="lg:col-span-7 bg-white border border-zinc-200 rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-100 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-[#D91B23]" />
              <h3 className="text-base font-bold text-zinc-900 font-display">
                أصناف العجز والزيادة ({varianceRows.length})
              </h3>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('reports', 'shortage_surplus')}
              className="text-xs font-semibold text-[#D91B23] hover:underline cursor-pointer"
            >
              تقرير العجز والزيادة
            </button>
          </div>
          {varianceRows.length === 0 ? (
            <div className="p-8 text-center text-sm text-emerald-700 flex items-center justify-center gap-2">
              <CheckCircle2 className="h-4 w-4" />
              <span>جميع الأصناف المحسوبة متطابقة تماماً (الفرق = 0).</span>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-right text-sm">
                <thead className="bg-zinc-50 border-b border-zinc-200 text-xs text-zinc-500">
                  <tr>
                    <th className="px-4 py-2.5 font-semibold">الصنف</th>
                    <th className="px-3 py-2.5 font-semibold">المتاح</th>
                    <th className="px-3 py-2.5 font-semibold">المباع</th>
                    <th className="px-3 py-2.5 font-semibold">المتبقي</th>
                    <th className="px-3 py-2.5 font-semibold">النتيجة</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {varianceRows.map((r) => (
                    <tr key={r.id}>
                      <td className="px-4 py-2.5 font-semibold text-zinc-900">{r.productName}</td>
                      <td className="px-3 py-2.5 tabular-nums">{r.totalAvailable}</td>
                      <td className="px-3 py-2.5 tabular-nums">{r.salesQty}</td>
                      <td className="px-3 py-2.5 tabular-nums">
                        {roundQty(r.validRemainingQty + r.invalidRemainingQty)}
                      </td>
                      <td className="px-3 py-2.5">
                        <StatusBadge
                          label={`${VARIANCE_LABELS[r.varianceType]} (${r.variance})`}
                          tone={r.varianceType === 'deficit' ? 'danger' : 'warning'}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Delivery Variances + Pending Approvals + Open/Closed Sessions */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-12 gap-6">
        {/* Factory vs Production Delivery Variances */}
        <div className="lg:col-span-4 bg-white border border-zinc-200 rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-100 flex items-center justify-between">
            <h3 className="text-base font-bold text-zinc-900 font-display">
              فروقات تسليم المعمل والإنتاج ({deliveryVarianceTransfers.length})
            </h3>
            <button
              type="button"
              onClick={() => onNavigate('reports', 'delivery_discrepancies')}
              className="text-xs font-semibold text-[#D91B23] hover:underline cursor-pointer"
            >
              التقرير المستقل
            </button>
          </div>
          {deliveryVarianceTransfers.length === 0 ? (
            <div className="p-8 text-center text-sm text-zinc-500">
              لا توجد فروقات تسليم بين المعمل والإنتاج لهذا اليوم.
            </div>
          ) : (
            <div className="divide-y divide-zinc-100">
              {deliveryVarianceTransfers.map((trf) => (
                <div key={trf.id} className="p-4 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs font-bold">{trf.transferNumber}</span>
                    <StatusBadge
                      label={TRANSFER_STATUS_LABELS[trf.status]}
                      tone="danger"
                    />
                  </div>
                  <div className="text-xs text-zinc-600 tabular-nums">
                    مرسل: {trf.totalSentQty} · مستلم: {trf.totalReceivedQty} · فرق التسليم:{' '}
                    <strong className="text-[#D91B23]">{trf.totalVarianceQty}</strong>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Pending Approvals */}
        <div className="lg:col-span-4 bg-white border border-zinc-200 rounded-2xl overflow-hidden flex flex-col justify-between">
          <div>
            <div className="px-5 py-4 border-b border-zinc-100 flex items-center justify-between">
              <h3 className="text-base font-bold text-zinc-900 font-display">
                الاعتمادات المعلقة
              </h3>
              <span className="text-sm font-extrabold text-[#D91B23] tabular-nums">
                {pendingApprovals.length}
              </span>
            </div>
            {pendingApprovals.length === 0 ? (
              <div className="p-6 text-center text-xs text-zinc-500">
                لا توجد طلبات اعتماد أو تصحيح معلقة.
              </div>
            ) : (
              <div className="divide-y divide-zinc-100">
                {pendingApprovals.slice(0, 4).map((app) => (
                  <div key={app.id} className="px-5 py-3">
                    <div className="text-xs font-bold text-zinc-900 truncate">{app.reason}</div>
                    <div className="text-[11px] text-zinc-500">
                      مقدم الطلب: {app.requestedByName}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="p-4 border-t border-zinc-100 bg-zinc-50/50">
            <button
              type="button"
              onClick={() => onNavigate('approvals')}
              className="w-full min-h-[38px] rounded-xl border border-zinc-200 bg-white text-xs font-semibold text-zinc-800 hover:bg-zinc-50 cursor-pointer"
            >
              فتح مركز الاعتمادات والتصحيحات
            </button>
          </div>
        </div>

        {/* Open/Closed Sessions */}
        <div className="lg:col-span-4 bg-white border border-zinc-200 rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-100 flex items-center justify-between">
            <h3 className="text-base font-bold text-zinc-900 font-display">
              الأيام المفتوحة والمغلقة
            </h3>
            <CalendarCheck className="h-4 w-4 text-zinc-400" />
          </div>
          <div className="divide-y divide-zinc-100">
            {recentSessions.map((sess) => (
              <button
                key={sess.id}
                type="button"
                onClick={() => setInventoryDate(sess.inventoryDate)}
                className={`w-full px-5 py-3 flex items-center justify-between hover:bg-zinc-50 cursor-pointer ${
                  sess.inventoryDate === inventoryDate ? 'bg-red-50/40' : ''
                }`}
              >
                <span className="font-mono text-xs font-bold text-zinc-800">
                  {sess.inventoryDate}
                </span>
                <StatusBadge
                  label={SESSION_STATUS_LABELS[sess.status]}
                  tone={
                    sess.status === 'closed'
                      ? 'neutral'
                      : sess.status === 'reopened'
                      ? 'warning'
                      : 'success'
                  }
                />
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Close Session Confirmation */}
      <ConfirmDialog
        open={closeModalOpen}
        title="اعتماد وإغلاق يوم الجرد"
        description={
          readiness.canClose
            ? 'جميع التقارير والتوريدات مكتملة. عند الإغلاق سيُمنع التعديل المباشر ويُرحّل المتبقي الصالح فقط لليوم التالي.'
            : 'توجد مهام غير مكتملة قبل الإغلاق، يرجى مراجعة الملاحظات أدناه:'
        }
        confirmLabel="إغلاق اليوم نهائياً"
        variant="danger"
        busy={calculating}
        confirmDisabled={!readiness.canClose}
        onConfirm={() => {
          if (readiness.canClose) void handleCloseDay();
        }}
        onCancel={() => setCloseModalOpen(false)}
      >
        {!readiness.canClose ? (
          <ul className="space-y-1.5 rounded-xl bg-red-50 border border-red-200 p-3 text-xs text-red-700 list-disc list-inside">
            {readiness.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        ) : (
          <div className="space-y-2">
            <label className="block text-xs font-semibold text-zinc-700">
              قرار الاعتماد الإداري (لتوثيق العجز/الزيادة إن وجدت)
            </label>
            <textarea
              rows={2}
              value={closeNote}
              onChange={(e) => setCloseNote(e.target.value)}
              placeholder="مثال: تمت مراجعة العجز واعتماد إغلاق اليوم..."
              className="w-full rounded-xl border border-zinc-200 p-3 text-sm"
            />
          </div>
        )}
      </ConfirmDialog>

      {/* Reopen Session Confirmation */}
      <ConfirmDialog
        open={reopenModalOpen}
        title="إعادة فتح يوم جرد مغلق"
        description="هذه العملية مقصورة على الإدارة العليا ويتم توثيقها في سجل التدقيق لإجراء تصحيح رسمي."
        confirmLabel="إعادة فتح اليوم"
        variant="primary"
        busy={calculating}
        onConfirm={() => void handleReopenDay()}
        onCancel={() => setReopenModalOpen(false)}
      >
        <div>
          <label className="block text-xs font-semibold text-zinc-700 mb-1">
            سبب إعادة الفتح (إلزامي)
          </label>
          <textarea
            rows={2}
            value={reopenReason}
            onChange={(e) => setReopenReason(e.target.value)}
            placeholder="اذكر سبب إعادة فتح اليوم المغلق..."
            className="w-full rounded-xl border border-zinc-200 p-3 text-sm"
          />
        </div>
      </ConfirmDialog>

      {/* Admin-only Report Date Transfer Modal */}
      <ConfirmDialog
        open={transferModalOpen}
        title="نقل تقرير قسم إلى تاريخ آخر (للإدارة فقط)"
        description="ينقل بيانات القسم كاملة من تاريخ أُدخل بالخطأ إلى التاريخ الصحيح، ويُفرغ تقرير المصدر ليعود مسودة جاهزة للإدخال الجديد، مع إعادة احتساب اليومين."
        confirmLabel="تنفيذ النقل وإعادة الاحتساب"
        variant="danger"
        busy={calculating}
        confirmDisabled={
          !transferFromDate ||
          !transferToDate ||
          transferFromDate === transferToDate ||
          !transferReason.trim()
        }
        onConfirm={() => void handleTransferReportBetweenDates()}
        onCancel={() => setTransferModalOpen(false)}
      >
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-semibold text-zinc-700 mb-1">القسم</label>
            <select
              value={transferDept}
              onChange={(e) => setTransferDept(e.target.value as OperationalDepartmentId)}
              className="w-full min-h-[40px] rounded-xl border border-zinc-200 bg-white px-3 text-sm font-semibold text-zinc-800"
            >
              {OPERATIONAL_DEPARTMENTS.map((dept) => (
                <option key={dept} value={dept}>
                  {DEPARTMENT_LABELS[dept]}
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
                value={transferFromDate}
                onChange={(e) => setTransferFromDate(e.target.value)}
                className="w-full min-h-[40px] rounded-xl border border-zinc-200 bg-white px-3 text-sm font-semibold tabular-nums"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-zinc-700 mb-1">
                إلى تاريخ (التاريخ الصحيح)
              </label>
              <input
                type="date"
                value={transferToDate}
                onChange={(e) => setTransferToDate(e.target.value)}
                className="w-full min-h-[40px] rounded-xl border border-zinc-200 bg-white px-3 text-sm font-semibold tabular-nums"
              />
            </div>
          </div>

          {transferDept === 'factory' && (
            <p className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-[11px] text-amber-900">
              ملاحظة: ينقل هذا الإجراء تقرير «الكميات المجهزة» للمعمل فقط ولا ينقل إشعارات التوريد أو المرتجعات.
            </p>
          )}

          <div>
            <label className="block text-xs font-semibold text-zinc-700 mb-1">
              سبب النقل (إلزامي لسجل التدقيق)
            </label>
            <textarea
              rows={2}
              value={transferReason}
              onChange={(e) => setTransferReason(e.target.value)}
              placeholder="مثال: تم إدخال مبيعات يوم 25 داخل يوم 26 بالخطأ..."
              className="w-full rounded-xl border border-zinc-200 p-3 text-sm"
            />
          </div>
        </div>
      </ConfirmDialog>
    </div>
  );
};
