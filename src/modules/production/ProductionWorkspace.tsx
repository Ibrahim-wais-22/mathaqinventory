import React, { useEffect, useMemo, useState } from 'react';
import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';
import {
  CheckCircle2,
  ClipboardCheck,
  Edit3,
  Factory,
  PlusCircle,
  RefreshCw,
  Search,
  Send,
  XCircle,
} from 'lucide-react';
import {
  REPORT_STATUS_LABELS,
  TRANSFER_STATUS_LABELS,
  VARIANCE_LABELS,
} from '../../constants/departments';
import { useFirebase } from '../../app/providers/FirebaseProvider';
import { OperationType, db, handleFirestoreError } from '../../services/firebase/config';
import {
  addIndependentProduction,
  confirmTransferReceipt,
  ensureDepartmentReport,
  formatActionError,
  requestReportCorrection,
  saveDepartmentReportDraft,
  submitDepartmentReport,
  technicalReviewProduct,
} from '../../services/inventory/firestoreService';
import type {
  ApprovalRequest,
  DepartmentReport,
  DepartmentReportItem,
  FactoryTransfer,
  FactoryTransferItem,
  Product,
  ProductResult,
  ProductionEntry,
} from '../../types/inventory';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';
import { StatusBadge } from '../../components/common/StatusBadge';
import { formatTimestampAden } from '../../utils/dateAden';

export const ProductionWorkspace: React.FC = () => {
  const {
    account,
    currentSession,
    sessionLoading,
    sessionError,
    refreshSession,
    categories,
    products,
    hasPermission,
  } = useFirebase();

  const [report, setReport] = useState<DepartmentReport | null>(null);
  const [submittedIndMap, setSubmittedIndMap] = useState<Record<string, number>>({});
  const [confirmSubmitOpen, setConfirmSubmitOpen] = useState(false);

  const [transfers, setTransfers] = useState<FactoryTransfer[]>([]);
  const [selectedTransfer, setSelectedTransfer] = useState<FactoryTransfer | null>(null);
  const [transferItems, setTransferItems] = useState<FactoryTransferItem[]>([]);
  const [loadingTransferItems, setLoadingTransferItems] = useState(false);
  const [receivedQtyMap, setReceivedQtyMap] = useState<Record<string, string>>({});
  const [itemNoteMap, setItemNoteMap] = useState<Record<string, string>>({});
  const [productionNote, setProductionNote] = useState('');

  const [indEntries, setIndEntries] = useState<ProductionEntry[]>([]);
  const [indProdId, setIndProdId] = useState('');
  const [indQty, setIndQty] = useState('');
  const [indNote, setIndNote] = useState('');

  const [techApprovals, setTechApprovals] = useState<ApprovalRequest[]>([]);
  const [resultsReadOnly, setResultsReadOnly] = useState<ProductResult[]>([]);

  const [activeTab, setActiveTab] = useState<'receipts' | 'independent' | 'technical' | 'readonly'>(
    'receipts'
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [corrTarget, setCorrTarget] = useState<Product | null>(null);
  const [corrNewVal, setCorrNewVal] = useState('');
  const [corrReason, setCorrReason] = useState('');

  const canReadResults = hasPermission('view_results');
  const isSessionClosed = currentSession?.status === 'closed';
  const isSubmitted = report ? report.status !== 'draft' : false;

  const approvedProducts = useMemo(
    () =>
      products.filter(
        (p) =>
          p.approvalStatus === 'approved' &&
          p.isActive &&
          p.allowedDepartments.includes('production')
      ),
    [products]
  );

  const pendingTechnicalProducts = useMemo(
    () => products.filter((p) => p.approvalStatus === 'pending_technical'),
    [products]
  );

  const categoryMap = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories]);
  const productMap = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  useEffect(() => {
    setReport(null);
    setSubmittedIndMap({});
    setTransfers([]);
    setSelectedTransfer(null);
    setTransferItems([]);
    setIndEntries([]);

    if (!account || !currentSession) return;
    let active = true;

    ensureDepartmentReport(account, currentSession, 'production')
      .then((rep) => {
        if (active) setReport(rep);
      })
      .catch((err) => {
        if (active) {
          setFeedback({ type: 'error', text: formatActionError(err, 'تعذر تحميل تقرير الإنتاج.') });
        }
      });

    const reportId = `${currentSession.id}_production`;
    const unsubRep = onSnapshot(
      doc(db, 'departmentReports', reportId),
      (snap) => {
        if (snap.exists()) {
          setReport({ id: snap.id, ...(snap.data() as Omit<DepartmentReport, 'id'>) });
        }
      },
      (err) => handleFirestoreError(err, OperationType.GET, `departmentReports/${reportId}`)
    );

    const unsubRepItems = onSnapshot(
      query(
        collection(db, 'departmentReports', reportId, 'items'),
        where('department', '==', 'production')
      ),
      (snap) => {
        const next: Record<string, number> = {};
        snap.forEach((d) => {
          const item = d.data() as DepartmentReportItem;
          if (item.independentProductionQty !== null && item.independentProductionQty !== undefined) {
            next[item.productId] = item.independentProductionQty;
          }
        });
        setSubmittedIndMap(next);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, `departmentReports/${reportId}/items`)
    );

    const unsubTrf = onSnapshot(
      query(collection(db, 'factoryTransfers'), where('sessionId', '==', currentSession.id)),
      (snap) => {
        const list = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<FactoryTransfer, 'id'>) }))
          .sort((a, b) => (b.transferNumber > a.transferNumber ? 1 : -1));
        setTransfers(list);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'factoryTransfers')
    );

    const unsubInd = onSnapshot(
      query(collection(db, 'productionEntries'), where('sessionId', '==', currentSession.id)),
      (snap) => {
        setIndEntries(
          snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<ProductionEntry, 'id'>) }))
        );
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'productionEntries')
    );

    const unsubApp = onSnapshot(
      query(
        collection(db, 'approvals'),
        where('type', '==', 'product_technical')
      ),
      (snap) => {
        setTechApprovals(
          snap.docs
            .map((d) => ({ id: d.id, ...(d.data() as Omit<ApprovalRequest, 'id'>) }))
            .filter((a) => a.status === 'pending')
        );
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'approvals')
    );

    let unsubRes = () => {};
    if (canReadResults) {
      unsubRes = onSnapshot(
        query(collection(db, 'productResults'), where('sessionId', '==', currentSession.id)),
        (snap) => {
          setResultsReadOnly(
            snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<ProductResult, 'id'>) }))
          );
        },
        (err) => handleFirestoreError(err, OperationType.LIST, 'productResults')
      );
    }

    return () => {
      active = false;
      unsubRep();
      unsubRepItems();
      unsubTrf();
      unsubInd();
      unsubApp();
      unsubRes();
    };
  }, [account?.uid, currentSession?.id, canReadResults]);

  const openTransferDetail = async (trf: FactoryTransfer) => {
    setSelectedTransfer(trf);
    setTransferItems([]);
    setLoadingTransferItems(true);
    setProductionNote(trf.productionNote || '');
    setFeedback(null);
    try {
      const snap = await getDocs(collection(db, 'factoryTransfers', trf.id, 'items'));
      const items = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<FactoryTransferItem, 'id'>),
      }));
      setTransferItems(items);
      const recInit: Record<string, string> = {};
      const noteInit: Record<string, string> = {};
      items.forEach((it) => {
        recInit[it.productId] =
          it.receivedQty !== null && it.receivedQty !== undefined
            ? String(it.receivedQty)
            : String(it.sentQty);
        noteInit[it.productId] = it.note || '';
      });
      setReceivedQtyMap(recInit);
      setItemNoteMap(noteInit);
    } catch (err) {
      setFeedback({
        type: 'error',
        text: formatActionError(err, 'تعذر تحميل تفاصيل التوريد.'),
      });
    } finally {
      setLoadingTransferItems(false);
    }
  };

  const handleConfirmReceipt = async () => {
    if (!account || !selectedTransfer) {
      setFeedback({ type: 'error', text: 'يرجى اختيار توريد أولاً.' });
      return;
    }
    if (transferItems.length === 0) {
      setFeedback({ type: 'error', text: 'تعذر قراءة أصناف التوريد. أعد فتح التوريد وحاول مجدداً.' });
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      const rows = transferItems.map((item) => {
        const raw = receivedQtyMap[item.productId];
        const val = raw === undefined || raw === '' ? 0 : Number(raw);
        if (Number.isNaN(val) || val < 0) {
          throw new Error(`الكمية المستلمة للصنف "${item.productName}" غير صحيحة.`);
        }
        return {
          item,
          receivedQty: val,
          note: itemNoteMap[item.productId] || '',
        };
      });
      await confirmTransferReceipt(account, selectedTransfer, rows, productionNote);
      setSelectedTransfer(null);
      setTransferItems([]);
      setFeedback({
        type: 'success',
        text: 'تم تأكيد استلام التوريد وتسجيل الكميات الفعلية وفروقات التسليم إن وجدت.',
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: formatActionError(err, 'تعذر تأكيد الاستلام.'),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleAddIndependent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!account || !currentSession) {
      setFeedback({
        type: 'error',
        text: sessionError || 'جلسة الجرد اليومية غير متاحة حالياً. يرجى تحديث الصفحة.',
      });
      return;
    }
    if (isSubmitted) {
      setFeedback({
        type: 'error',
        text: 'تم ترحيل تقرير الإنتاج لهذا اليوم. لتعديل الكميات استخدم طلب التصحيح الإداري.',
      });
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      const targetId = indProdId || approvedProducts[0]?.id;
      const prod = approvedProducts.find((p) => p.id === targetId);
      if (!prod) throw new Error('يرجى اختيار صنف معتمد.');
      const qty = Number(indQty);
      if (Number.isNaN(qty) || qty <= 0) throw new Error('أدخل كمية إنتاج أكبر من صفر.');
      await addIndependentProduction(account, currentSession, prod, qty, indNote);
      setIndQty('');
      setIndNote('');
      setFeedback({
        type: 'success',
        text: `تم تسجيل إنتاج مستقل لـ "${prod.name}" (${qty} ${prod.unit}).`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: formatActionError(err, 'تعذر تسجيل الإنتاج المستقل.'),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleSubmitProductionReport = async () => {
    if (!account) return;
    if (!currentSession) {
      setConfirmSubmitOpen(false);
      setFeedback({
        type: 'error',
        text: sessionError || 'جلسة الجرد اليومية غير جاهزة بعد.',
      });
      return;
    }
    const pendingTransfers = transfers.filter((t) => t.status === 'pending_receipt');
    if (pendingTransfers.length > 0) {
      setConfirmSubmitOpen(false);
      setFeedback({
        type: 'error',
        text: `يوجد ${pendingTransfers.length} توريد من المعمل بانتظار تأكيد الاستلام. يرجى تأكيد الاستلام أولاً قبل ترحيل تقرير الإنتاج.`,
      });
      return;
    }

    setBusy(true);
    setFeedback(null);
    try {
      const activeReport =
        report && report.sessionId === currentSession.id
          ? report
          : await ensureDepartmentReport(account, currentSession, 'production');
      setReport(activeReport);

      // Sum independent production quantities per product
      const indTotals = new Map<string, number>();
      indEntries.forEach((entry) => {
        indTotals.set(entry.productId, (indTotals.get(entry.productId) || 0) + Number(entry.qty || 0));
      });

      // Collect products that had received factory transfers as well
      const receivedTotals = new Map<string, number>();
      for (const trf of transfers) {
        const itemsSnap = await getDocs(collection(db, 'factoryTransfers', trf.id, 'items'));
        itemsSnap.forEach((d) => {
          const item = d.data() as FactoryTransferItem;
          receivedTotals.set(
            item.productId,
            (receivedTotals.get(item.productId) || 0) + Number(item.receivedQty ?? 0)
          );
        });
      }

      const targetProducts =
        approvedProducts.length > 0 ? approvedProducts : products.filter((p) => p.approvalStatus === 'approved');

      const reportItems = targetProducts
        .filter((p) => indTotals.has(p.id) || receivedTotals.has(p.id))
        .map((p) => ({
          productId: p.id,
          categoryId: p.categoryId,
          independentProductionQty: Math.round((indTotals.get(p.id) || 0) * 1000) / 1000,
          note: receivedTotals.has(p.id)
            ? `استلام من المعمل: ${receivedTotals.get(p.id)}`
            : 'إنتاج مستقل مباشر',
        }));

      // Allow submitting even when a day had 0 independent production and 0 factory transfers
      if (reportItems.length === 0 && targetProducts.length > 0) {
        reportItems.push({
          productId: targetProducts[0].id,
          categoryId: targetProducts[0].categoryId,
          independentProductionQty: 0,
          note: 'تأكيد تقرير الإنتاج (لا توجد كميات إنتاج مستقل لهذا اليوم)',
        });
      }

      await saveDepartmentReportDraft(account, activeReport, reportItems);
      await submitDepartmentReport(account, activeReport, reportItems.length);
      setConfirmSubmitOpen(false);
      setFeedback({
        type: 'success',
        text: 'تم ترحيل تقرير الإنتاج بنجاح واعتماد كميات الإنتاج لليوم.',
      });
    } catch (err) {
      setConfirmSubmitOpen(false);
      setFeedback({
        type: 'error',
        text: formatActionError(err, 'تعذر ترحيل تقرير الإنتاج.'),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleRequestCorrection = async () => {
    if (!account || !report || !corrTarget) return;
    setBusy(true);
    setFeedback(null);
    try {
      const oldV = submittedIndMap[corrTarget.id] ?? 0;
      const newV = Number(corrNewVal);
      if (Number.isNaN(newV) || newV < 0) throw new Error('أدخل كمية صحيحة.');
      await requestReportCorrection(
        account,
        report,
        corrTarget,
        'independentProductionQty',
        oldV,
        newV,
        corrReason
      );
      setCorrTarget(null);
      setCorrNewVal('');
      setCorrReason('');
      setFeedback({
        type: 'success',
        text: 'تم إرسال طلب تصحيح الإنتاج المستقل إلى الإدارة العليا.',
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: formatActionError(err, 'تعذر إرسال طلب التصحيح.'),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleTechDecision = async (prod: Product, decision: 'approve' | 'reject') => {
    if (!account) return;
    setBusy(true);
    setFeedback(null);
    try {
      const related = techApprovals.find((a) => a.targetId === prod.id);
      const note =
        decision === 'approve'
          ? 'تمت مراجعة المواصفات الفنية واعتماد الصنف فنياً'
          : 'غير مطابق فنياً، يرجى المراجعة';
      await technicalReviewProduct(account, prod, decision, note, related);
      setFeedback({
        type: 'success',
        text:
          decision === 'approve'
            ? `تم الاعتماد الفني للصنف "${prod.name}" وإرساله للاعتماد الإداري.`
            : `تم رفض الصنف "${prod.name}" فنياً.`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: formatActionError(err, 'تعذر تنفيذ المراجعة الفنية.'),
      });
    } finally {
      setBusy(false);
    }
  };

  const pendingCount = transfers.filter((t) => t.status === 'pending_receipt').length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white border border-zinc-200 rounded-2xl p-5">
        <div>
          <h2 className="text-xl font-bold text-zinc-900 font-display">مساحة عمل الإنتاج</h2>
          <p className="mt-1 text-sm text-zinc-500">
            استلام توريدات المعمل وتسجيل فروقات التسليم · إدخال الإنتاج المستقل · الاعتماد الفني
            للأصناف · ترحيل تقرير الإنتاج
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          {report && (
            <StatusBadge
              label={`حالة التقرير: ${REPORT_STATUS_LABELS[report.status]}`}
              tone={report.status === 'draft' ? 'warning' : 'success'}
              icon={report.status === 'draft' ? 'clock' : 'check'}
            />
          )}
          <StatusBadge
            label={`توريدات بانتظار الاستلام: ${pendingCount}`}
            tone={pendingCount > 0 ? 'warning' : 'success'}
            icon={pendingCount > 0 ? 'clock' : 'check'}
          />
          {!isSubmitted && !isSessionClosed && (
            <button
              type="button"
              disabled={busy || !currentSession || pendingCount > 0}
              onClick={() => setConfirmSubmitOpen(true)}
              title={
                pendingCount > 0
                  ? 'يجب تأكيد استلام جميع التوريدات الواردة قبل الترحيل'
                  : 'ترحيل تقرير الإنتاج لليوم'
              }
              className="min-h-[42px] inline-flex items-center gap-2 rounded-xl bg-[#D91B23] px-4 py-2 text-xs font-bold text-white hover:bg-[#B9141B] transition-colors cursor-pointer disabled:opacity-50"
            >
              <Send className="h-4 w-4" />
              <span>ترحيل تقرير الإنتاج</span>
            </button>
          )}
        </div>
      </div>

      {sessionError && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700 flex flex-wrap items-center justify-between gap-2">
          <span>{sessionError}</span>
          <button
            type="button"
            onClick={() => void refreshSession()}
            disabled={sessionLoading}
            className="inline-flex items-center gap-1.5 rounded-lg bg-white border border-red-200 px-3 py-1.5 text-xs font-bold text-red-700 hover:bg-red-100 cursor-pointer"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${sessionLoading ? 'animate-spin' : ''}`} />
            <span>إعادة المحاولة</span>
          </button>
        </div>
      )}

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

      {/* Tabs */}
      <div className="flex flex-wrap items-center gap-1 p-1 bg-zinc-100 rounded-xl w-fit border border-zinc-200">
        <button
          type="button"
          onClick={() => setActiveTab('receipts')}
          className={`min-h-[40px] px-4 py-2 text-xs font-semibold rounded-lg cursor-pointer whitespace-nowrap ${
            activeTab === 'receipts' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-600'
          }`}
        >
          توريدات المعمل ({transfers.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('independent')}
          className={`min-h-[40px] px-4 py-2 text-xs font-semibold rounded-lg cursor-pointer whitespace-nowrap ${
            activeTab === 'independent' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-600'
          }`}
        >
          الإنتاج المستقل ({indEntries.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('technical')}
          className={`min-h-[40px] px-4 py-2 text-xs font-semibold rounded-lg cursor-pointer whitespace-nowrap ${
            activeTab === 'technical' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-600'
          }`}
        >
          الاعتماد الفني للأصناف ({pendingTechnicalProducts.length})
        </button>
        {canReadResults && (
          <button
            type="button"
            onClick={() => setActiveTab('readonly')}
            className={`min-h-[40px] px-4 py-2 text-xs font-semibold rounded-lg cursor-pointer whitespace-nowrap ${
              activeTab === 'readonly' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-600'
            }`}
          >
            نتائج الجرد والهدر (قراءة فقط)
          </button>
        )}
      </div>

      {/* TAB 1: Factory Transfers Receipt */}
      {activeTab === 'receipts' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-5 bg-white border border-zinc-200 rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-zinc-100">
              <h3 className="text-base font-bold text-zinc-900 font-display">
                إشعارات التوريد الواردة من المعمل
              </h3>
            </div>
            {transfers.length === 0 ? (
              <div className="p-8 text-center text-sm text-zinc-500">
                لا توجد توريدات مسجلة من المعمل لهذا التاريخ.
              </div>
            ) : (
              <div className="divide-y divide-zinc-100">
                {transfers.map((trf) => (
                  <button
                    key={trf.id}
                    type="button"
                    onClick={() => void openTransferDetail(trf)}
                    className={`w-full text-right p-4 hover:bg-zinc-50 transition-colors cursor-pointer ${
                      selectedTransfer?.id === trf.id ? 'bg-red-50/40' : ''
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs font-bold text-zinc-900">
                        {trf.transferNumber}
                      </span>
                      <StatusBadge
                        label={TRANSFER_STATUS_LABELS[trf.status]}
                        tone={
                          trf.status === 'pending_receipt'
                            ? 'warning'
                            : trf.status === 'received'
                            ? 'success'
                            : 'danger'
                        }
                      />
                    </div>
                    <div className="mt-2 flex items-center justify-between text-xs text-zinc-600 tabular-nums">
                      <span>مرسل من المعمل: {trf.totalSentQty}</span>
                      <span>
                        مستلم: {trf.status === 'pending_receipt' ? 'بانتظار التأكيد' : trf.totalReceivedQty}
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] text-zinc-400">
                      بواسطة: {trf.createdByName} · {formatTimestampAden(trf.createdAt)}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="lg:col-span-7 bg-white border border-zinc-200 rounded-2xl overflow-hidden">
            {!selectedTransfer ? (
              <div className="p-12 text-center text-sm text-zinc-500">
                اختر توريداً من القائمة لمراجعة الكميات المرسلة وتأكيد الكميات المستلمة فعلياً.
              </div>
            ) : (
              <div>
                <div className="px-5 py-4 border-b border-zinc-100 flex items-center justify-between">
                  <div>
                    <h3 className="text-base font-bold text-zinc-900 font-display">
                      مراجعة التوريد {selectedTransfer.transferNumber}
                    </h3>
                    <p className="text-xs text-zinc-500">
                      الكمية المرسلة من المعمل ثابتة ولا يمكن تعديلها؛ أدخل الكمية المستلمة فعلياً
                      فقط
                    </p>
                  </div>
                  <StatusBadge
                    label={TRANSFER_STATUS_LABELS[selectedTransfer.status]}
                    tone={
                      selectedTransfer.status === 'pending_receipt'
                        ? 'warning'
                        : selectedTransfer.status === 'received'
                        ? 'success'
                        : 'danger'
                    }
                  />
                </div>

                {loadingTransferItems ? (
                  <div className="p-10 text-center text-sm text-zinc-500">
                    جاري تحميل أصناف التوريد...
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-right">
                      <thead className="bg-zinc-50 border-b border-zinc-200 text-xs text-zinc-500">
                        <tr>
                          <th className="px-4 py-3 font-semibold">الصنف</th>
                          <th className="px-3 py-3 font-semibold">مرسل (المعمل)</th>
                          <th className="px-3 py-3 font-semibold">مستلم (فعلي)</th>
                          <th className="px-3 py-3 font-semibold">فرق التسليم</th>
                          <th className="px-4 py-3 font-semibold">ملاحظة</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-100 text-sm">
                        {transferItems.map((item) => {
                          const recVal = Number(receivedQtyMap[item.productId] ?? item.sentQty);
                          const diff = Math.round((item.sentQty - recVal) * 1000) / 1000;
                          return (
                            <tr key={item.productId}>
                              <td className="px-4 py-3 font-semibold text-zinc-900">
                                {item.productName}
                                <div className="text-xs font-normal text-zinc-500">{item.unit}</div>
                              </td>
                              <td className="px-3 py-3 font-bold tabular-nums text-zinc-700">
                                {item.sentQty}
                              </td>
                              <td className="px-3 py-3">
                                <input
                                  type="number"
                                  min="0"
                                  step="any"
                                  disabled={
                                    selectedTransfer.status !== 'pending_receipt' || isSessionClosed
                                  }
                                  value={receivedQtyMap[item.productId] ?? ''}
                                  onChange={(e) =>
                                    setReceivedQtyMap((prev) => ({
                                      ...prev,
                                      [item.productId]: e.target.value,
                                    }))
                                  }
                                  className="w-24 min-h-[40px] rounded-xl border border-zinc-200 px-2 text-center font-semibold tabular-nums disabled:bg-zinc-100"
                                />
                              </td>
                              <td
                                className={`px-3 py-3 font-bold tabular-nums ${
                                  diff !== 0 ? 'text-[#D91B23]' : 'text-emerald-700'
                                }`}
                              >
                                {diff}
                              </td>
                              <td className="px-4 py-3">
                                <input
                                  type="text"
                                  disabled={
                                    selectedTransfer.status !== 'pending_receipt' || isSessionClosed
                                  }
                                  value={itemNoteMap[item.productId] ?? ''}
                                  onChange={(e) =>
                                    setItemNoteMap((prev) => ({
                                      ...prev,
                                      [item.productId]: e.target.value,
                                    }))
                                  }
                                  placeholder="سبب الفرق..."
                                  className="w-full min-h-[38px] rounded-lg border border-zinc-200 px-2.5 text-xs disabled:bg-zinc-100"
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                {selectedTransfer.status === 'pending_receipt' && !isSessionClosed && (
                  <div className="p-5 border-t border-zinc-100 bg-zinc-50/50 space-y-3">
                    <input
                      type="text"
                      value={productionNote}
                      onChange={(e) => setProductionNote(e.target.value)}
                      placeholder="ملاحظة استلام الإنتاج العامة (اختياري)..."
                      className="w-full min-h-[42px] rounded-xl border border-zinc-200 bg-white px-4 text-sm"
                    />
                    <button
                      type="button"
                      disabled={busy || loadingTransferItems || transferItems.length === 0}
                      onClick={() => void handleConfirmReceipt()}
                      className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl bg-[#D91B23] px-5 py-2.5 text-sm font-bold text-white hover:bg-[#B9141B] cursor-pointer disabled:opacity-50"
                    >
                      <ClipboardCheck className="h-4 w-4" />
                      <span>{busy ? 'جاري التأكيد...' : 'تأكيد الاستلام الفعلي واعتماد الرصيد'}</span>
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: Independent Production */}
      {activeTab === 'independent' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <form
            onSubmit={handleAddIndependent}
            className="lg:col-span-5 bg-white border border-zinc-200 rounded-2xl p-5 space-y-4"
          >
            <div className="flex items-center gap-2">
              <Factory className="h-5 w-5 text-[#D91B23]" />
              <h3 className="text-base font-bold text-zinc-900 font-display">
                تسجيل إنتاج مستقل مباشر
              </h3>
            </div>
            <p className="text-xs text-zinc-500">
              يُستخدم للكميات التي أُنتجت مباشرة داخل قسم الإنتاج ولم ترد من المعمل.
            </p>
            <div>
              <label className="block text-xs font-semibold text-zinc-700 mb-1">الصنف</label>
              <select
                value={indProdId || approvedProducts[0]?.id || ''}
                onChange={(e) => setIndProdId(e.target.value)}
                disabled={isSessionClosed || isSubmitted}
                className="w-full min-h-[44px] rounded-xl border border-zinc-200 px-3 text-sm disabled:bg-zinc-100"
              >
                {approvedProducts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({categoryMap.get(p.categoryId) || ''} · {p.unit})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-zinc-700 mb-1">الكمية المنتجة</label>
              <input
                type="number"
                min="0.1"
                step="any"
                required
                disabled={isSessionClosed || isSubmitted}
                value={indQty}
                onChange={(e) => setIndQty(e.target.value)}
                placeholder="أدخل العدد"
                className="w-full min-h-[44px] rounded-xl border border-zinc-200 px-3 text-sm tabular-nums disabled:bg-zinc-100"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-zinc-700 mb-1">ملاحظة</label>
              <input
                type="text"
                disabled={isSessionClosed || isSubmitted}
                value={indNote}
                onChange={(e) => setIndNote(e.target.value)}
                placeholder="تفاصيل الدفعة..."
                className="w-full min-h-[44px] rounded-xl border border-zinc-200 px-3 text-sm disabled:bg-zinc-100"
              />
            </div>
            <button
              type="submit"
              disabled={busy || isSessionClosed || isSubmitted}
              className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl bg-[#D91B23] text-sm font-bold text-white hover:bg-[#B9141B] cursor-pointer disabled:opacity-50"
            >
              <PlusCircle className="h-4 w-4" />
              <span>{isSubmitted ? 'تم ترحيل التقرير' : 'تسجيل الإنتاج المستقل'}</span>
            </button>
          </form>

          <div className="lg:col-span-7 bg-white border border-zinc-200 rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-zinc-100 flex items-center justify-between gap-2">
              <h3 className="text-base font-bold text-zinc-900 font-display">
                سجل الإنتاج المستقل لليوم
              </h3>
              {isSubmitted && !isSessionClosed && (
                <button
                  type="button"
                  onClick={() => {
                    const target =
                      approvedProducts.find((p) => p.id === (indProdId || approvedProducts[0]?.id)) ||
                      approvedProducts[0] ||
                      null;
                    if (target) {
                      setCorrTarget(target);
                      setCorrNewVal(String(submittedIndMap[target.id] ?? 0));
                    }
                  }}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-[#D91B23] hover:underline cursor-pointer"
                >
                  <Edit3 className="h-3.5 w-3.5" />
                  <span>طلب تصحيح بعد الترحيل</span>
                </button>
              )}
            </div>
            {indEntries.length === 0 ? (
              <div className="p-8 text-center text-sm text-zinc-500">
                لا توجد سجلات إنتاج مستقل لهذا التاريخ.
              </div>
            ) : (
              <div className="divide-y divide-zinc-100">
                {indEntries.map((entry) => {
                  const p = productMap.get(entry.productId);
                  return (
                    <div key={entry.id} className="p-4 flex items-center justify-between gap-4">
                      <div>
                        <div className="text-sm font-bold text-zinc-900">
                          {p?.name || entry.productId}
                        </div>
                        <div className="text-xs text-zinc-500">
                          {entry.createdByName} · {formatTimestampAden(entry.createdAt)}
                          {entry.note ? ` · ${entry.note}` : ''}
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-base font-extrabold text-zinc-900 tabular-nums">
                          +{entry.qty} {p?.unit || ''}
                        </span>
                        {isSubmitted && !isSessionClosed && p && (
                          <button
                            type="button"
                            onClick={() => {
                              setCorrTarget(p);
                              setCorrNewVal(String(submittedIndMap[p.id] ?? entry.qty));
                            }}
                            className="inline-flex items-center gap-1 text-xs font-semibold text-[#D91B23] hover:underline cursor-pointer"
                          >
                            <Edit3 className="h-3.5 w-3.5" />
                            <span>تصحيح</span>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: Technical Approval */}
      {activeTab === 'technical' && (
        <div className="bg-white border border-zinc-200 rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-100">
            <h3 className="text-base font-bold text-zinc-900 font-display">
              اعتماد الأصناف الجديدة فنياً
            </h3>
            <p className="text-xs text-zinc-500">
              مراجعة الأصناف المقترحة من المعمل واعتماد مطابقتها الفنية قبل رفعها للإدارة العليا.
            </p>
          </div>
          {pendingTechnicalProducts.length === 0 ? (
            <div className="p-8 text-center text-sm text-zinc-500">
              لا توجد أصناف بانتظار الاعتماد الفني حالياً.
            </div>
          ) : (
            <div className="divide-y divide-zinc-100">
              {pendingTechnicalProducts.map((prod) => (
                <div
                  key={prod.id}
                  className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                >
                  <div>
                    <div className="text-sm font-bold text-zinc-900">{prod.name}</div>
                    <div className="text-xs text-zinc-500">
                      المجموعة: {categoryMap.get(prod.categoryId) || '—'} · الوحدة: {prod.unit} ·
                      مقترح من: {prod.createdByName}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleTechDecision(prod, 'approve')}
                      className="min-h-[40px] inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-bold text-white hover:bg-emerald-700 cursor-pointer"
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      <span>اعتماد فني</span>
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleTechDecision(prod, 'reject')}
                      className="min-h-[40px] inline-flex items-center gap-1.5 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-xs font-bold text-red-700 hover:bg-red-100 cursor-pointer"
                    >
                      <XCircle className="h-4 w-4" />
                      <span>رفض</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* TAB 4: Read-only Inventory & Waste Result */}
      {activeTab === 'readonly' && canReadResults && (
        <div className="bg-white border border-zinc-200 rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-100 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-bold text-zinc-900 font-display">
                ملخص الجرد والهدر (قراءة فقط)
              </h3>
            </div>
            <div className="relative">
              <Search className="h-4 w-4 text-zinc-400 absolute right-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="بحث بالصنف..."
                className="min-h-[38px] rounded-xl border border-zinc-200 pr-9 pl-3 text-xs"
              />
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-right text-sm">
              <thead className="bg-zinc-50 border-b border-zinc-200 text-xs text-zinc-500">
                <tr>
                  <th className="px-4 py-3 font-semibold">الصنف</th>
                  <th className="px-3 py-3 font-semibold">إجمالي الإنتاج</th>
                  <th className="px-3 py-3 font-semibold">التالف</th>
                  <th className="px-3 py-3 font-semibold">المتبقي الصالح</th>
                  <th className="px-3 py-3 font-semibold">النتيجة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {resultsReadOnly
                  .filter((r) => !searchQuery.trim() || r.productName.includes(searchQuery.trim()))
                  .map((r) => (
                    <tr key={r.id}>
                      <td className="px-4 py-3 font-semibold text-zinc-900">{r.productName}</td>
                      <td className="px-3 py-3 tabular-nums">{r.totalProduction}</td>
                      <td className="px-3 py-3 tabular-nums">{r.damagedQty}</td>
                      <td className="px-3 py-3 tabular-nums">{r.validRemainingQty}</td>
                      <td className="px-3 py-3">
                        <StatusBadge
                          label={`${VARIANCE_LABELS[r.varianceType]} (${r.variance})`}
                          tone={
                            r.varianceType === 'matched'
                              ? 'success'
                              : r.varianceType === 'deficit'
                              ? 'danger'
                              : 'warning'
                          }
                        />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmSubmitOpen}
        title="تأكيد ترحيل تقرير الإنتاج"
        description={`سيتم ترحيل تقرير الإنتاج لتاريخ ${currentSession?.inventoryDate || ''} (بعد استلام ${transfers.length} توريد وتسجيل ${indEntries.length} دفعة إنتاج مستقل). بعد الترحيل يتطلب أي تعديل موافقة الإدارة العليا.`}
        confirmLabel="ترحيل تقرير الإنتاج نهائياً"
        variant="danger"
        busy={busy}
        onConfirm={() => void handleSubmitProductionReport()}
        onCancel={() => setConfirmSubmitOpen(false)}
      />

      {corrTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white border border-zinc-200 p-6 space-y-4">
            <h3 className="text-lg font-bold text-zinc-900 font-display">
              طلب تصحيح الإنتاج المستقل — {corrTarget.name}
            </h3>
            <div>
              <label className="block text-xs font-semibold text-zinc-700 mb-1">الصنف</label>
              <select
                value={corrTarget.id}
                onChange={(e) => {
                  const found = approvedProducts.find((p) => p.id === e.target.value);
                  if (found) {
                    setCorrTarget(found);
                    setCorrNewVal(String(submittedIndMap[found.id] ?? 0));
                  }
                }}
                className="w-full min-h-[42px] rounded-xl border border-zinc-200 px-3 text-sm"
              >
                {approvedProducts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-zinc-700 mb-1">
                الكمية الجديدة للإنتاج المستقل
              </label>
              <input
                type="number"
                min="0"
                step="any"
                value={corrNewVal}
                onChange={(e) => setCorrNewVal(e.target.value)}
                className="w-full min-h-[42px] rounded-xl border border-zinc-200 px-3 text-sm tabular-nums"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-zinc-700 mb-1">سبب التعديل</label>
              <textarea
                rows={2}
                value={corrReason}
                onChange={(e) => setCorrReason(e.target.value)}
                placeholder="اذكر سبب التصحيح لتوثيقه في سجل التدقيق..."
                className="w-full rounded-xl border border-zinc-200 p-3 text-sm"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCorrTarget(null)}
                className="min-h-[40px] px-4 rounded-xl border border-zinc-200 text-xs font-semibold text-zinc-700 cursor-pointer"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={busy || !corrReason.trim()}
                onClick={() => void handleRequestCorrection()}
                className="min-h-[40px] px-5 rounded-xl bg-[#D91B23] text-xs font-bold text-white cursor-pointer disabled:opacity-50"
              >
                إرسال الطلب للإدارة
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
