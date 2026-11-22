import React, { useEffect, useMemo, useState } from 'react';
import {
  collection,
  doc,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';
import { Edit3, Save, Search, Send } from 'lucide-react';
import { REPORT_STATUS_LABELS, VARIANCE_LABELS } from '../../constants/departments';
import { useFirebase } from '../../app/providers/FirebaseProvider';
import { OperationType, db, handleFirestoreError } from '../../services/firebase/config';
import {
  ensureDepartmentReport,
  formatActionError,
  requestReportCorrection,
  saveDepartmentReportDraft,
  submitDepartmentReport,
} from '../../services/inventory/firestoreService';
import type {
  DepartmentReport,
  DepartmentReportItem,
  Product,
  ProductResult,
} from '../../types/inventory';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';
import { StatusBadge } from '../../components/common/StatusBadge';

export const SalesWorkspace: React.FC = () => {
  const { account, currentSession, categories, products, hasPermission } = useFirebase();

  const [report, setReport] = useState<DepartmentReport | null>(null);
  const [salesMap, setSalesMap] = useState<Record<string, string>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [activeTab, setActiveTab] = useState<'entry' | 'results'>('entry');
  const [resultsReadOnly, setResultsReadOnly] = useState<ProductResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

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
          p.approvalStatus === 'approved' && p.isActive && p.allowedDepartments.includes('sales')
      ),
    [products]
  );

  const categoryMap = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories]);

  useEffect(() => {
    if (!account || !currentSession) return;
    let active = true;
    ensureDepartmentReport(account, currentSession, 'sales')
      .then((rep) => {
        if (active) setReport(rep);
      })
      .catch((err) => {
        if (active) {
          setFeedback({ type: 'error', text: formatActionError(err, 'تعذر تحميل تقرير المبيعات.') });
        }
      });

    const reportId = `${currentSession.id}_sales`;
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
        where('department', '==', 'sales')
      ),
      (snap) => {
        const next: Record<string, string> = {};
        snap.forEach((docSnap) => {
          const item = docSnap.data() as DepartmentReportItem;
          if (item.salesQty !== null && item.salesQty !== undefined) {
            next[item.productId] = String(item.salesQty);
          }
        });
        setSalesMap(next);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, `departmentReports/${reportId}/items`)
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
      unsubItems();
      unsubRes();
    };
  }, [account?.uid, currentSession?.id, canReadResults]);

  const filteredProducts = useMemo(() => {
    return approvedProducts.filter((p) => {
      const matchesCat = selectedCategory === 'all' || p.categoryId === selectedCategory;
      const matchesSearch = !searchQuery.trim() || p.name.includes(searchQuery.trim());
      return matchesCat && matchesSearch;
    });
  }, [approvedProducts, selectedCategory, searchQuery]);

  const enteredCount = Object.values(salesMap).filter((v) => v !== '' && v !== undefined).length;
  const totalSoldUnits = Object.values(salesMap).reduce(
    (sum, v) => sum + (v !== '' && !Number.isNaN(Number(v)) ? Number(v) : 0),
    0
  );

  const handleSaveDraft = async () => {
    if (!account || !report) return;
    setBusy(true);
    setFeedback(null);
    try {
      const items = approvedProducts.map((p) => {
        const raw = salesMap[p.id];
        const val = raw === undefined || raw === '' ? null : Number(raw);
        if (val !== null && (Number.isNaN(val) || val < 0)) {
          throw new Error(`الكمية المدخلة للصنف "${p.name}" غير صالحة.`);
        }
        return {
          productId: p.id,
          categoryId: p.categoryId,
          salesQty: val,
        };
      });
      await saveDepartmentReportDraft(account, report, items);
      setFeedback({ type: 'success', text: 'تم حفظ مسودة تقرير المبيعات بنجاح.' });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: formatActionError(err, 'تعذر حفظ المسودة.'),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = async () => {
    if (!account || !report) return;
    setBusy(true);
    setFeedback(null);
    try {
      const items = approvedProducts.map((p) => {
        const raw = salesMap[p.id];
        const val = raw === undefined || raw === '' ? null : Number(raw);
        if (val !== null && (Number.isNaN(val) || val < 0)) {
          throw new Error(`الكمية المدخلة للصنف "${p.name}" غير صالحة.`);
        }
        return {
          productId: p.id,
          categoryId: p.categoryId,
          salesQty: val,
        };
      });
      await saveDepartmentReportDraft(account, report, items);
      const count = items.filter((i) => i.salesQty !== null).length;
      await submitDepartmentReport(account, report, count);
      setConfirmOpen(false);
      setFeedback({ type: 'success', text: 'تم ترحيل تقرير المبيعات بالوحدات بنجاح.' });
    } catch (err) {
      setConfirmOpen(false);
      setFeedback({
        type: 'error',
        text: formatActionError(err, 'تعذر ترحيل التقرير.'),
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
      const oldV = salesMap[corrTarget.id] ? Number(salesMap[corrTarget.id]) : 0;
      const newV = Number(corrNewVal);
      if (Number.isNaN(newV) || newV < 0) throw new Error('أدخل عدداً صحيحاً.');
      await requestReportCorrection(
        account,
        report,
        corrTarget,
        'salesQty',
        oldV,
        newV,
        corrReason
      );
      setCorrTarget(null);
      setCorrNewVal('');
      setCorrReason('');
      setFeedback({ type: 'success', text: 'تم إرسال طلب تصحيح المبيعات إلى الإدارة العليا.' });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: formatActionError(err, 'تعذر إرسال طلب التصحيح.'),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white border border-zinc-200 rounded-2xl p-5">
        <div>
          <h2 className="text-xl font-bold text-zinc-900 font-display">مساحة عمل المبيعات</h2>
          <p className="mt-1 text-sm text-zinc-500">
            إدخال عدد الوحدات المباعة لكل صنف لتاريخ الجرد المحدد (بدون قيم مالية)
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="text-xs font-semibold text-zinc-600 tabular-nums">
            إجمالي الوحدات المباعة: <strong className="text-zinc-900">{totalSoldUnits}</strong>
          </div>
          {report && (
            <StatusBadge
              label={`الحالة: ${REPORT_STATUS_LABELS[report.status]}`}
              tone={report.status === 'draft' ? 'warning' : 'success'}
              icon={report.status === 'draft' ? 'clock' : 'check'}
            />
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

      {canReadResults && (
        <div className="flex items-center gap-1 p-1 bg-zinc-100 rounded-xl w-fit border border-zinc-200">
          <button
            type="button"
            onClick={() => setActiveTab('entry')}
            className={`min-h-[40px] px-4 py-2 text-xs font-semibold rounded-lg cursor-pointer ${
              activeTab === 'entry' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-600'
            }`}
          >
            إدخال المبيعات بالعدد
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('results')}
            className={`min-h-[40px] px-4 py-2 text-xs font-semibold rounded-lg cursor-pointer ${
              activeTab === 'results' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-600'
            }`}
          >
            نتائج الجرد النهائية (قراءة فقط)
          </button>
        </div>
      )}

      {activeTab === 'entry' ? (
        <>
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="h-4 w-4 text-zinc-400 absolute right-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="ابحث عن صنف بالاسم..."
                className="w-full min-h-[44px] rounded-xl border border-zinc-200 bg-white pr-10 pl-4 text-sm focus:outline-none focus:border-[#D91B23]"
              />
            </div>
            <select
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
              className="min-h-[44px] rounded-xl border border-zinc-200 bg-white px-4 text-sm"
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

          <div className="bg-white border border-zinc-200 rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-zinc-100 flex flex-wrap items-center justify-between gap-3">
              <span className="text-xs text-zinc-500">
                أدخل 0 للأصناف التي لم يُبع منها شيء، واترك غير المدخل فارغاً حتى يكتمل الجرد.
              </span>
              {!isSubmitted && !isSessionClosed && (
                <div className="flex items-center gap-2">
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
                    disabled={busy || enteredCount === 0}
                    onClick={() => setConfirmOpen(true)}
                    className="min-h-[42px] inline-flex items-center gap-2 rounded-xl bg-[#D91B23] px-4 py-2 text-xs font-bold text-white hover:bg-[#B9141B] cursor-pointer disabled:opacity-50"
                  >
                    <Send className="h-4 w-4" />
                    <span>ترحيل تقرير المبيعات</span>
                  </button>
                </div>
              )}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-right text-sm">
                <thead className="bg-zinc-50 border-b border-zinc-200 text-xs text-zinc-500">
                  <tr>
                    <th className="px-5 py-3 font-semibold">الصنف</th>
                    <th className="px-4 py-3 font-semibold">المجموعة</th>
                    <th className="px-4 py-3 font-semibold">الوحدة</th>
                    <th className="px-4 py-3 font-semibold">عدد الوحدات المباعة</th>
                    {isSubmitted && !isSessionClosed && (
                      <th className="px-4 py-3 font-semibold">تصحيح</th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {filteredProducts.map((prod) => (
                    <tr key={prod.id} className="hover:bg-zinc-50/70">
                      <td className="px-5 py-3 font-semibold text-zinc-900">{prod.name}</td>
                      <td className="px-4 py-3 text-zinc-600">
                        {categoryMap.get(prod.categoryId) || '—'}
                      </td>
                      <td className="px-4 py-3 text-zinc-600">{prod.unit}</td>
                      <td className="px-4 py-3">
                        <input
                          type="number"
                          min="0"
                          step="any"
                          disabled={isSubmitted || isSessionClosed}
                          value={salesMap[prod.id] ?? ''}
                          onChange={(e) =>
                            setSalesMap((prev) => ({ ...prev, [prod.id]: e.target.value }))
                          }
                          placeholder="لم يُدخل"
                          className="w-32 min-h-[40px] rounded-xl border border-zinc-200 px-3 text-center font-semibold tabular-nums focus:outline-none focus:border-[#D91B23] disabled:bg-zinc-100"
                        />
                      </td>
                      {isSubmitted && !isSessionClosed && (
                        <td className="px-4 py-3">
                          <button
                            type="button"
                            onClick={() => {
                              setCorrTarget(prod);
                              setCorrNewVal(salesMap[prod.id] ?? '0');
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
        </>
      ) : (
        <div className="bg-white border border-zinc-200 rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-100">
            <h3 className="text-base font-bold text-zinc-900 font-display">
              نتائج الجرد النهائية لليوم (قراءة فقط)
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-right text-sm">
              <thead className="bg-zinc-50 border-b border-zinc-200 text-xs text-zinc-500">
                <tr>
                  <th className="px-4 py-3 font-semibold">الصنف</th>
                  <th className="px-3 py-3 font-semibold">المتاح</th>
                  <th className="px-3 py-3 font-semibold">المبيعات</th>
                  <th className="px-3 py-3 font-semibold">النتيجة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {resultsReadOnly.map((r) => (
                  <tr key={r.id}>
                    <td className="px-4 py-3 font-semibold text-zinc-900">{r.productName}</td>
                    <td className="px-3 py-3 tabular-nums">{r.totalAvailable}</td>
                    <td className="px-3 py-3 tabular-nums">{r.salesQty}</td>
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
        open={confirmOpen}
        title="تأكيد ترحيل تقرير المبيعات"
        description={`سيتم ترحيل مبيعات ${enteredCount} صنف بإجمالي ${totalSoldUnits} وحدة مباعة لتاريخ ${currentSession?.inventoryDate || ''}.`}
        confirmLabel="ترحيل التقرير"
        variant="danger"
        busy={busy}
        onConfirm={() => void handleSubmit()}
        onCancel={() => setConfirmOpen(false)}
      />

      {corrTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white border border-zinc-200 p-6 space-y-4">
            <h3 className="text-lg font-bold text-zinc-900 font-display">
              طلب تصحيح المبيعات — {corrTarget.name}
            </h3>
            <input
              type="number"
              min="0"
              step="any"
              value={corrNewVal}
              onChange={(e) => setCorrNewVal(e.target.value)}
              className="w-full min-h-[42px] rounded-xl border border-zinc-200 px-3 text-sm tabular-nums"
            />
            <textarea
              rows={2}
              value={corrReason}
              onChange={(e) => setCorrReason(e.target.value)}
              placeholder="سبب التصحيح..."
              className="w-full rounded-xl border border-zinc-200 p-3 text-sm"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCorrTarget(null)}
                className="min-h-[40px] px-4 rounded-xl border border-zinc-200 text-xs font-semibold cursor-pointer"
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
