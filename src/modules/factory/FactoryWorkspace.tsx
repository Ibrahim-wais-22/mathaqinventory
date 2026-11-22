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
  CopyCheck,
  Edit3,
  PackagePlus,
  Plus,
  RefreshCw,
  Save,
  Search,
  Send,
  Truck,
} from 'lucide-react';
import {
  PRODUCT_APPROVAL_LABELS,
  REPORT_STATUS_LABELS,
  TRANSFER_STATUS_LABELS,
} from '../../constants/departments';
import { useFirebase } from '../../app/providers/FirebaseProvider';
import { OperationType, db, handleFirestoreError } from '../../services/firebase/config';
import {
  createFactoryTransfer,
  ensureDepartmentReport,
  formatActionError,
  proposeProductByFactory,
  requestReportCorrection,
  saveDepartmentReportDraft,
  submitDepartmentReport,
} from '../../services/inventory/firestoreService';
import type {
  DepartmentReport,
  DepartmentReportItem,
  FactoryTransfer,
  Product,
} from '../../types/inventory';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';
import { StatusBadge } from '../../components/common/StatusBadge';
import { formatTimestampAden } from '../../utils/dateAden';

export const FactoryWorkspace: React.FC = () => {
  const {
    account,
    currentSession,
    sessionLoading,
    sessionError,
    refreshSession,
    categories,
    products,
    isDeptQtyReadOnly,
  } = useFirebase();

  const [report, setReport] = useState<DepartmentReport | null>(null);
  const [preparedMap, setPreparedMap] = useState<Record<string, string>>({});
  const [transferQtyMap, setTransferQtyMap] = useState<Record<string, string>>({});
  const [transferNote, setTransferNote] = useState('');
  const [transfers, setTransfers] = useState<FactoryTransfer[]>([]);
  const [proposedProducts, setProposedProducts] = useState<Product[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [activeSubTab, setActiveSubTab] = useState<'dispatch' | 'prepared' | 'proposals'>('dispatch');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [confirmSubmitOpen, setConfirmSubmitOpen] = useState(false);
  const [confirmTransferOpen, setConfirmTransferOpen] = useState(false);

  // Propose new product modal state
  const [newProdModal, setNewProdModal] = useState(false);
  const [newProdName, setNewProdName] = useState('');
  const [newProdCat, setNewProdCat] = useState('');
  const [newProdUnit, setNewProdUnit] = useState('نفر');
  const [newProdReason, setNewProdReason] = useState('');

  // Post-submission correction modal
  const [corrTarget, setCorrTarget] = useState<Product | null>(null);
  const [corrNewVal, setCorrNewVal] = useState('');
  const [corrReason, setCorrReason] = useState('');

  const approvedProducts = useMemo(
    () =>
      products.filter(
        (p) =>
          p.approvalStatus === 'approved' &&
          p.isActive &&
          p.allowedDepartments.includes('factory')
      ),
    [products]
  );

  // Load or initialize Factory report + items
  useEffect(() => {
    setReport(null);
    setPreparedMap({});
    setTransfers([]);
    if (!account || !currentSession) return;
    let active = true;
    if (!isDeptQtyReadOnly) {
      ensureDepartmentReport(account, currentSession, 'factory')
        .then((rep) => {
          if (active) setReport(rep);
        })
        .catch((err) => {
          if (active) {
            setFeedback({ type: 'error', text: formatActionError(err, 'تعذر تحميل تقرير المعمل.') });
          }
        });
    }

    const reportId = `${currentSession.id}_factory`;
    const unsubRep = onSnapshot(
      doc(db, 'departmentReports', reportId),
      (snap) => {
        if (snap.exists()) {
          setReport({ id: snap.id, ...(snap.data() as Omit<DepartmentReport, 'id'>) });
        }
      },
      (err) => handleFirestoreError(err, OperationType.GET, `departmentReports/${reportId}`)
    );

    const unsubItems = onSnapshot(
      query(
        collection(db, 'departmentReports', reportId, 'items'),
        where('department', '==', 'factory')
      ),
      (snap) => {
        const next: Record<string, string> = {};
        snap.forEach((docSnap) => {
          const item = docSnap.data() as DepartmentReportItem;
          if (item.preparedQty !== null && item.preparedQty !== undefined) {
            next[item.productId] = String(item.preparedQty);
          }
        });
        setPreparedMap(next);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, `departmentReports/${reportId}/items`)
    );

    const unsubTransfers = onSnapshot(
      query(collection(db, 'factoryTransfers'), where('sessionId', '==', currentSession.id)),
      (snap) => {
        const list = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<FactoryTransfer, 'id'>) }))
          .sort((a, b) => (b.transferNumber > a.transferNumber ? 1 : -1));
        setTransfers(list);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'factoryTransfers')
    );

    const unsubProposed = onSnapshot(
      query(collection(db, 'products'), where('createdBy', '==', account.uid)),
      (snap) => {
        setProposedProducts(
          snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Product, 'id'>) }))
        );
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'products')
    );

    return () => {
      active = false;
      unsubRep();
      unsubItems();
      unsubTransfers();
      unsubProposed();
    };
  }, [account?.uid, currentSession?.id]);

  const filteredProducts = useMemo(() => {
    return approvedProducts.filter((p) => {
      const matchesCat = selectedCategory === 'all' || p.categoryId === selectedCategory;
      const matchesSearch = !searchQuery.trim() || p.name.includes(searchQuery.trim());
      return matchesCat && matchesSearch;
    });
  }, [approvedProducts, selectedCategory, searchQuery]);

  const categoryMap = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories]);

  const isSessionClosed = currentSession?.status === 'closed';
  const isSubmitted = report ? report.status !== 'draft' : false;

  const enteredPreparedCount = useMemo(() => {
    return approvedProducts.filter((p) => preparedMap[p.id] !== '' && preparedMap[p.id] !== undefined)
      .length;
  }, [approvedProducts, preparedMap]);

  const resolveActiveReport = async (): Promise<DepartmentReport> => {
    if (!account) {
      throw new Error('يرجى تسجيل الدخول بحساب نشط أولاً.');
    }
    if (!currentSession) {
      throw new Error(sessionError || 'جلسة الجرد اليومية غير جاهزة بعد. يرجى تحديث الجلسة.');
    }
    if (report && report.sessionId === currentSession.id) {
      return report;
    }
    const ensured = await ensureDepartmentReport(account, currentSession, 'factory');
    setReport(ensured);
    return ensured;
  };

  const handleSaveDraft = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      const activeReport = await resolveActiveReport();
      const items = approvedProducts.map((p) => {
        const raw = preparedMap[p.id];
        const val = raw === undefined || raw === '' ? null : Number(raw);
        if (val !== null && (Number.isNaN(val) || val < 0)) {
          throw new Error(`الكمية المدخلة للصنف "${p.name}" غير صالحة.`);
        }
        return {
          productId: p.id,
          categoryId: p.categoryId,
          preparedQty: val,
        };
      });
      await saveDepartmentReportDraft(account!, activeReport, items);
      setFeedback({ type: 'success', text: 'تم حفظ مسودة تقرير المعمل بنجاح.' });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: formatActionError(err, 'تعذر حفظ المسودة.'),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleSubmitReport = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      const activeReport = await resolveActiveReport();
      const items = approvedProducts.map((p) => {
        const raw = preparedMap[p.id];
        const val = raw === undefined || raw === '' ? null : Number(raw);
        if (val !== null && (Number.isNaN(val) || val < 0)) {
          throw new Error(`الكمية المدخلة للصنف "${p.name}" غير صالحة.`);
        }
        return {
          productId: p.id,
          categoryId: p.categoryId,
          preparedQty: val,
        };
      });
      await saveDepartmentReportDraft(account!, activeReport, items);
      const count = items.filter((i) => i.preparedQty !== null).length;
      await submitDepartmentReport(account!, activeReport, count);
      setConfirmSubmitOpen(false);
      setFeedback({ type: 'success', text: 'تم ترحيل تقرير المعمل وإغلاق التعديل المباشر.' });
    } catch (err) {
      setConfirmSubmitOpen(false);
      setFeedback({
        type: 'error',
        text: formatActionError(err, 'تعذر ترحيل التقرير.'),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleFillPreparedFromTransfers = async () => {
    if (transfers.length === 0) {
      setFeedback({ type: 'error', text: 'لا توجد توريدات مرسلة اليوم للنسخ منها.' });
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      const summed = new Map<string, number>();
      for (const trf of transfers) {
        const itemsSnap = await getDocs(collection(db, 'factoryTransfers', trf.id, 'items'));
        itemsSnap.forEach((d) => {
          const data = d.data() as { productId?: string; sentQty?: number };
          if (data.productId) {
            summed.set(data.productId, (summed.get(data.productId) || 0) + Number(data.sentQty || 0));
          }
        });
      }
      setPreparedMap((prev) => {
        const next = { ...prev };
        summed.forEach((qty, pid) => {
          next[pid] = String(Math.round(qty * 1000) / 1000);
        });
        return next;
      });
      setFeedback({
        type: 'success',
        text: 'تم تعبئة الكميات المجهزة من إجمالي التوريدات المرسلة اليوم. يمكنك مراجعتها ثم الترحيل.',
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: formatActionError(err, 'تعذر جلب تفاصيل التوريدات.'),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleCreateTransfer = async () => {
    if (!account || !currentSession) {
      setConfirmTransferOpen(false);
      setFeedback({
        type: 'error',
        text: sessionError || 'جلسة الجرد اليومية غير متاحة حالياً. يرجى تحديث الصفحة.',
      });
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      const items = approvedProducts
        .map((p) => {
          const raw = transferQtyMap[p.id];
          if (raw === undefined || raw === '') {
            return { product: p, sentQty: 0 };
          }
          const qty = Number(raw);
          if (Number.isNaN(qty) || qty < 0) {
            throw new Error(`الكمية المرسلة للصنف "${p.name}" غير صالحة.`);
          }
          return {
            product: p,
            sentQty: qty,
          };
        })
        .filter((i) => i.sentQty > 0);
      await createFactoryTransfer(account, currentSession, items, transferNote);
      setTransferQtyMap({});
      setTransferNote('');
      setConfirmTransferOpen(false);
      setFeedback({
        type: 'success',
        text: 'تم إنشاء التوريد وإرساله إلى قسم الإنتاج بانتظار تأكيد الاستلام.',
      });
    } catch (err) {
      setConfirmTransferOpen(false);
      setFeedback({
        type: 'error',
        text: formatActionError(err, 'تعذر إرسال التوريد.'),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleProposeProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!account) return;
    setBusy(true);
    setFeedback(null);
    try {
      const catId = newProdCat || categories[0]?.id || '';
      if (!newProdName.trim() || !catId) {
        throw new Error('يرجى إدخال اسم الصنف واختيار المجموعة.');
      }
      await proposeProductByFactory(account, {
        name: newProdName,
        categoryId: catId,
        unit: newProdUnit || 'نفر',
        allowedDepartments: ['factory', 'production', 'sales', 'waste'],
        reason: newProdReason,
      });
      setNewProdModal(false);
      setNewProdName('');
      setNewProdReason('');
      setFeedback({
        type: 'success',
        text: 'تم إرسال الصنف الجديد إلى قسم الإنتاج للمراجعة والاعتماد الفني.',
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: formatActionError(err, 'تعذر اقتراح الصنف.'),
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
      const oldV = preparedMap[corrTarget.id] ? Number(preparedMap[corrTarget.id]) : 0;
      const newV = Number(corrNewVal);
      if (Number.isNaN(newV) || newV < 0) throw new Error('يرجى إدخال كمية صحيحة.');
      await requestReportCorrection(
        account,
        report,
        corrTarget,
        'preparedQty',
        oldV,
        newV,
        corrReason
      );
      setCorrTarget(null);
      setCorrNewVal('');
      setCorrReason('');
      setFeedback({ type: 'success', text: 'تم إرسال طلب التصحيح إلى الإدارة العليا للموافقة.' });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: formatActionError(err, 'تعذر إرسال طلب التصحيح.'),
      });
    } finally {
      setBusy(false);
    }
  };

  const totalDispatchUnits = Object.values(transferQtyMap).reduce(
    (sum, v) => sum + (Number(v) > 0 ? Number(v) : 0),
    0
  );

  return (
    <div className="space-y-6">
      {/* Header summary */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white border border-zinc-200 rounded-2xl p-5">
        <div>
          <h2 className="text-xl font-bold text-zinc-900 font-display">مساحة عمل المعمل</h2>
          <p className="mt-1 text-sm text-zinc-500">
            تجهيز الكميات اليومية · إنشاء توريدات إلى الإنتاج · اقتراح الأصناف الجديدة للاعتماد
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {report && (
            <StatusBadge
              label={`حالة التقرير: ${REPORT_STATUS_LABELS[report.status]}`}
              tone={report.status === 'draft' ? 'warning' : 'success'}
              icon={report.status === 'draft' ? 'clock' : 'check'}
            />
          )}
          {!isDeptQtyReadOnly && (
            <button
              type="button"
              onClick={() => setNewProdModal(true)}
              className="min-h-[42px] inline-flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-2 text-xs font-semibold text-zinc-800 hover:bg-zinc-50 cursor-pointer"
            >
              <PackagePlus className="h-4 w-4 text-[#D91B23]" />
              <span>طلب صنف جديد</span>
            </button>
          )}
        </div>
      </div>

      {isDeptQtyReadOnly && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-semibold text-amber-900">
          وضع الاطلاع فقط — صلاحيات إضافة أو تعديل الكميات في المعمل مقتصرة على موظفي المعمل ومخفية عن المدير التنفيذي ومدير الفرع.
        </div>
      )}

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

      {/* Segmented Navigation */}
      <div className="flex items-center gap-1 p-1 bg-zinc-100 rounded-xl w-fit border border-zinc-200">
        <button
          type="button"
          onClick={() => setActiveSubTab('dispatch')}
          className={`min-h-[40px] px-4 py-2 text-xs font-semibold rounded-lg transition-colors cursor-pointer whitespace-nowrap ${
            activeSubTab === 'dispatch'
              ? 'bg-white text-zinc-900 shadow-sm'
              : 'text-zinc-600 hover:text-zinc-900'
          }`}
        >
          التوريدات إلى الإنتاج ({transfers.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveSubTab('prepared')}
          className={`min-h-[40px] px-4 py-2 text-xs font-semibold rounded-lg transition-colors cursor-pointer whitespace-nowrap ${
            activeSubTab === 'prepared'
              ? 'bg-white text-zinc-900 shadow-sm'
              : 'text-zinc-600 hover:text-zinc-900'
          }`}
        >
          تقرير الكميات المجهزة ({enteredPreparedCount})
        </button>
        <button
          type="button"
          onClick={() => setActiveSubTab('proposals')}
          className={`min-h-[40px] px-4 py-2 text-xs font-semibold rounded-lg transition-colors cursor-pointer whitespace-nowrap ${
            activeSubTab === 'proposals'
              ? 'bg-white text-zinc-900 shadow-sm'
              : 'text-zinc-600 hover:text-zinc-900'
          }`}
        >
          الأصناف المقترحة ({proposedProducts.length})
        </button>
      </div>

      {/* Filters */}
      {activeSubTab !== 'proposals' && (
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="h-4 w-4 text-zinc-400 absolute right-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="ابحث عن صنف بالاسم..."
              className="w-full min-h-[44px] rounded-xl border border-zinc-200 bg-white pr-10 pl-4 text-sm text-zinc-900 focus:outline-none focus:border-[#D91B23]"
            />
          </div>
          <select
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            className="min-h-[44px] rounded-xl border border-zinc-200 bg-white px-4 text-sm text-zinc-800 focus:outline-none focus:border-[#D91B23]"
          >
            <option value="all">جميع المجموعات</option>
            {categories
              .filter((c) => c.isActive)
              .map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.name}
                </option>
              ))}
          </select>
        </div>
      )}

      {/* TAB 1: Factory Dispatch Transfers */}
      {activeSubTab === 'dispatch' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-7 bg-white border border-zinc-200 rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-zinc-100 flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-zinc-900 font-display">
                  {isDeptQtyReadOnly ? 'قائمة أصناف المعمل المعتمدة (اطلاع فقط)' : 'إنشاء توريد جديد إلى الإنتاج'}
                </h3>
                <p className="text-xs text-zinc-500">
                  {isDeptQtyReadOnly
                    ? 'استعراض أصناف المعمل ووحداتها؛ التوريدات تُنشأ من حساب موظف المعمل فقط'
                    : 'حدد الكمية المرسلة لكل صنف ليصل إشعار الاستلام لقسم الإنتاج فوراً'}
                </p>
              </div>
              {!isDeptQtyReadOnly && (
                <span className="text-xs font-semibold text-zinc-700 tabular-nums">
                  الإجمالي: {totalDispatchUnits} وحدة
                </span>
              )}
            </div>

            <div className="overflow-x-auto max-h-[460px] overflow-y-auto">
              <table className="w-full text-right">
                <thead className="bg-zinc-50 border-b border-zinc-200 text-xs text-zinc-500 sticky top-0 z-10">
                  <tr>
                    <th className="px-5 py-3 font-semibold">الصنف</th>
                    <th className="px-4 py-3 font-semibold">المجموعة</th>
                    <th className="px-4 py-3 font-semibold">الوحدة</th>
                    {!isDeptQtyReadOnly && (
                      <th className="px-4 py-3 font-semibold text-center">الكمية المرسلة</th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 text-sm">
                  {filteredProducts.map((prod) => (
                    <tr key={prod.id} className="hover:bg-zinc-50/70">
                      <td className="px-5 py-3 font-semibold text-zinc-900">{prod.name}</td>
                      <td className="px-4 py-3 text-zinc-600">
                        {categoryMap.get(prod.categoryId) || '—'}
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1 text-xs font-semibold text-zinc-700">
                          {prod.unit}
                        </span>
                      </td>
                      {!isDeptQtyReadOnly && (
                        <td className="px-4 py-3 text-center">
                          <input
                            type="number"
                            min="0"
                            step="any"
                            disabled={isSessionClosed}
                            value={transferQtyMap[prod.id] || ''}
                            onChange={(e) =>
                              setTransferQtyMap((prev) => ({ ...prev, [prod.id]: e.target.value }))
                            }
                            placeholder="0"
                            className="w-28 min-h-[40px] rounded-xl border border-zinc-200 px-3 text-center text-sm font-semibold tabular-nums focus:outline-none focus:border-[#D91B23] disabled:bg-zinc-100"
                          />
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {!isDeptQtyReadOnly && (
              <div className="p-5 border-t border-zinc-100 bg-zinc-50/50 space-y-3">
                <input
                  type="text"
                  value={transferNote}
                  onChange={(e) => setTransferNote(e.target.value)}
                  disabled={isSessionClosed}
                  placeholder="ملاحظة التوريد (اختياري)..."
                  className="w-full min-h-[42px] rounded-xl border border-zinc-200 bg-white px-4 text-sm focus:outline-none focus:border-[#D91B23]"
                />
                <button
                  type="button"
                  disabled={isSessionClosed || totalDispatchUnits <= 0 || busy}
                  onClick={() => setConfirmTransferOpen(true)}
                  className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl bg-[#D91B23] px-5 py-2.5 text-sm font-bold text-white hover:bg-[#B9141B] transition-colors cursor-pointer disabled:opacity-50"
                >
                  <Truck className="h-4 w-4" />
                  <span>إرسال التوريد إلى قسم الإنتاج</span>
                </button>
              </div>
            )}
          </div>

          {/* Transfer Status History */}
          <div className="lg:col-span-5 bg-white border border-zinc-200 rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-zinc-100">
              <h3 className="text-base font-bold text-zinc-900 font-display">
                سجل توريدات اليوم وحالات الاستلام
              </h3>
            </div>
            {transfers.length === 0 ? (
              <div className="p-8 text-center text-sm text-zinc-500">
                لم يتم إرسال توريدات في تاريخ الجرد المحدد بعد.
              </div>
            ) : (
              <div className="divide-y divide-zinc-100">
                {transfers.map((trf) => (
                  <div key={trf.id} className="p-4 space-y-2">
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
                        icon={
                          trf.status === 'pending_receipt'
                            ? 'clock'
                            : trf.status === 'received'
                            ? 'check'
                            : 'alert'
                        }
                      />
                    </div>
                    <div className="flex items-center justify-between text-xs text-zinc-600 tabular-nums">
                      <span>المرسل: {trf.totalSentQty}</span>
                      <span>
                        المستلم: {trf.status === 'pending_receipt' ? '—' : trf.totalReceivedQty}
                      </span>
                      <span>
                        فرق التسليم:{' '}
                        {trf.status === 'pending_receipt' ? '—' : trf.totalVarianceQty}
                      </span>
                    </div>
                    <div className="text-[11px] text-zinc-400">
                      وقت الإرسال: {formatTimestampAden(trf.createdAt)}
                      {trf.receivedByName ? ` · المستلم: ${trf.receivedByName}` : ''}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: Prepared Quantities Report */}
      {activeSubTab === 'prepared' && (
        <div className="bg-white border border-zinc-200 rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-100 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-bold text-zinc-900 font-display">
                تقرير الكميات المجهزة بالمعمل
              </h3>
              <p className="text-xs text-zinc-500">
                اترك الحقل فارغاً للأصناف التي لم تجهز اليوم، أو أدخل 0 إذا كانت الكمية صفراً فعلياً
              </p>
            </div>
            {!isDeptQtyReadOnly && !isSubmitted && !isSessionClosed && (
              <div className="flex flex-wrap items-center gap-2">
                {transfers.length > 0 && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleFillPreparedFromTransfers()}
                    className="min-h-[42px] inline-flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2 text-xs font-semibold text-amber-900 hover:bg-amber-100 cursor-pointer"
                  >
                    <CopyCheck className="h-4 w-4" />
                    <span>تعبئة من التوريدات المرسلة</span>
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleSaveDraft()}
                  className="min-h-[42px] inline-flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-2 text-xs font-semibold text-zinc-800 hover:bg-zinc-50 cursor-pointer"
                >
                  <Save className="h-4 w-4" />
                  <span>حفظ كمسودة</span>
                </button>
                <button
                  type="button"
                  disabled={busy || enteredPreparedCount === 0}
                  onClick={() => setConfirmSubmitOpen(true)}
                  className="min-h-[42px] inline-flex items-center gap-2 rounded-xl bg-[#D91B23] px-4 py-2 text-xs font-bold text-white hover:bg-[#B9141B] cursor-pointer disabled:opacity-50"
                >
                  <Send className="h-4 w-4" />
                  <span>ترحيل تقرير المعمل</span>
                </button>
              </div>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-right">
              <thead className="bg-zinc-50 border-b border-zinc-200 text-xs text-zinc-500">
                <tr>
                  <th className="px-5 py-3 font-semibold">الصنف</th>
                  <th className="px-4 py-3 font-semibold">المجموعة</th>
                  <th className="px-4 py-3 font-semibold">الوحدة</th>
                  <th className="px-4 py-3 font-semibold">الكمية المجهزة</th>
                  {!isDeptQtyReadOnly && isSubmitted && !isSessionClosed && (
                    <th className="px-4 py-3 font-semibold">تصحيح</th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 text-sm">
                {filteredProducts.map((prod) => (
                  <tr key={prod.id} className="hover:bg-zinc-50/70">
                    <td className="px-5 py-3 font-semibold text-zinc-900">{prod.name}</td>
                    <td className="px-4 py-3 text-zinc-600">
                      {categoryMap.get(prod.categoryId) || '—'}
                    </td>
                    <td className="px-4 py-3 text-zinc-600">{prod.unit}</td>
                    <td className="px-4 py-3">
                      {isDeptQtyReadOnly ? (
                        <span className="inline-block min-w-[64px] text-center font-semibold tabular-nums text-zinc-800">
                          {preparedMap[prod.id] !== undefined && preparedMap[prod.id] !== ''
                            ? preparedMap[prod.id]
                            : '—'}
                        </span>
                      ) : (
                        <input
                          type="number"
                          min="0"
                          step="any"
                          disabled={isSubmitted || isSessionClosed}
                          value={preparedMap[prod.id] ?? ''}
                          onChange={(e) =>
                            setPreparedMap((prev) => ({ ...prev, [prod.id]: e.target.value }))
                          }
                          placeholder="لم يُدخل"
                          className="w-32 min-h-[40px] rounded-xl border border-zinc-200 px-3 text-center font-semibold tabular-nums focus:outline-none focus:border-[#D91B23] disabled:bg-zinc-100"
                        />
                      )}
                    </td>
                    {!isDeptQtyReadOnly && isSubmitted && !isSessionClosed && (
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => {
                            setCorrTarget(prod);
                            setCorrNewVal(preparedMap[prod.id] ?? '0');
                          }}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-[#D91B23] hover:underline cursor-pointer"
                        >
                          <Edit3 className="h-3.5 w-3.5" />
                          <span>طلب تصحيح</span>
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 3: Proposed Products */}
      {activeSubTab === 'proposals' && (
        <div className="bg-white border border-zinc-200 rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-100 flex items-center justify-between">
            <h3 className="text-base font-bold text-zinc-900 font-display">
              طلبات اعتماد الأصناف المرسلة من المعمل
            </h3>
            {!isDeptQtyReadOnly && (
              <button
                type="button"
                onClick={() => setNewProdModal(true)}
                className="min-h-[38px] inline-flex items-center gap-1.5 rounded-xl bg-[#18181B] px-3.5 py-1.5 text-xs font-semibold text-white cursor-pointer"
              >
                <Plus className="h-4 w-4" />
                <span>صنف جديد</span>
              </button>
            )}
          </div>
          {proposedProducts.length === 0 ? (
            <div className="p-8 text-center text-sm text-zinc-500">
              لم تقم باقتراح أي أصناف جديدة بعد.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-right">
                <thead className="bg-zinc-50 border-b border-zinc-200 text-xs text-zinc-500">
                  <tr>
                    <th className="px-5 py-3 font-semibold">الصنف</th>
                    <th className="px-4 py-3 font-semibold">المجموعة</th>
                    <th className="px-4 py-3 font-semibold">الوحدة</th>
                    <th className="px-4 py-3 font-semibold">الحالة</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 text-sm">
                  {proposedProducts.map((p) => (
                    <tr key={p.id} className="hover:bg-zinc-50/70">
                      <td className="px-5 py-3">
                        <div className="font-bold text-zinc-900">{p.name}</div>
                        {p.rejectionReason && (
                          <div className="text-xs text-red-600 mt-0.5">
                            سبب الرفض: {p.rejectionReason}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-zinc-600">
                        {categoryMap.get(p.categoryId) || '—'}
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1 text-xs font-semibold text-zinc-700">
                          {p.unit}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge
                          label={PRODUCT_APPROVAL_LABELS[p.approvalStatus]}
                          tone={
                            p.approvalStatus === 'approved'
                              ? 'success'
                              : p.approvalStatus === 'rejected'
                              ? 'danger'
                              : 'warning'
                          }
                          icon={
                            p.approvalStatus === 'approved'
                              ? 'check'
                              : p.approvalStatus === 'rejected'
                              ? 'error'
                              : 'clock'
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Modals */}
      <ConfirmDialog
        open={confirmTransferOpen}
        title="تأكيد إرسال التوريد إلى الإنتاج"
        description={`سيتم إرسال توريد بإجمالي ${totalDispatchUnits} وحدة إلى قسم الإنتاج لتاريخ ${currentSession?.inventoryDate || ''}.`}
        confirmLabel="إرسال التوريد"
        busy={busy}
        onConfirm={() => void handleCreateTransfer()}
        onCancel={() => setConfirmTransferOpen(false)}
      />

      <ConfirmDialog
        open={confirmSubmitOpen}
        title="تأكيد ترحيل تقرير المعمل"
        description="بعد الترحيل لا يمكن تعديل الكميات مباشرة، وأي تعديل يتطلب موافقة الإدارة العليا."
        confirmLabel="ترحيل التقرير نهائياً"
        variant="danger"
        busy={busy}
        onConfirm={() => void handleSubmitReport()}
        onCancel={() => setConfirmSubmitOpen(false)}
      />

      {newProdModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <form
            onSubmit={handleProposeProduct}
            className="w-full max-w-md rounded-2xl bg-white border border-zinc-200 p-6 space-y-4"
          >
            <h3 className="text-lg font-bold text-zinc-900 font-display">
              اقتراح صنف جديد للاعتماد
            </h3>
            <p className="text-xs text-zinc-500">
              يمر الصنف بالاعتماد الفني من الإنتاج ثم الاعتماد الإداري من الإدارة العليا قبل تفعيله.
            </p>
            <div>
              <label className="block text-xs font-semibold text-zinc-700 mb-1">اسم الصنف</label>
              <input
                type="text"
                required
                value={newProdName}
                onChange={(e) => setNewProdName(e.target.value)}
                placeholder="مثال: برمة لحم بالخضار"
                className="w-full min-h-[42px] rounded-xl border border-zinc-200 px-3 text-sm focus:outline-none focus:border-[#D91B23]"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-zinc-700 mb-1">المجموعة</label>
                <select
                  value={newProdCat || categories[0]?.id || ''}
                  onChange={(e) => setNewProdCat(e.target.value)}
                  className="w-full min-h-[42px] rounded-xl border border-zinc-200 px-3 text-sm"
                >
                  {categories
                    .filter((c) => c.isActive)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-700 mb-1">وحدة القياس</label>
                <input
                  type="text"
                  required
                  value={newProdUnit}
                  onChange={(e) => setNewProdUnit(e.target.value)}
                  placeholder="نفر / حبة / صحن"
                  className="w-full min-h-[42px] rounded-xl border border-zinc-200 px-3 text-sm"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-zinc-700 mb-1">ملاحظة للإنتاج</label>
              <input
                type="text"
                value={newProdReason}
                onChange={(e) => setNewProdReason(e.target.value)}
                placeholder="وصف مختصر للصنف الجديد"
                className="w-full min-h-[42px] rounded-xl border border-zinc-200 px-3 text-sm"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setNewProdModal(false)}
                className="min-h-[40px] px-4 rounded-xl border border-zinc-200 text-xs font-semibold text-zinc-700 cursor-pointer"
              >
                إلغاء
              </button>
              <button
                type="submit"
                disabled={busy}
                className="min-h-[40px] px-5 rounded-xl bg-[#D91B23] text-xs font-bold text-white cursor-pointer"
              >
                {busy ? 'جاري الإرسال...' : 'إرسال للاعتماد الفني'}
              </button>
            </div>
          </form>
        </div>
      )}

      {corrTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white border border-zinc-200 p-6 space-y-4">
            <h3 className="text-lg font-bold text-zinc-900 font-display">
              طلب تصحيح بعد الترحيل — {corrTarget.name}
            </h3>
            <div>
              <label className="block text-xs font-semibold text-zinc-700 mb-1">الكمية الجديدة</label>
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
