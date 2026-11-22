import React, { useEffect, useMemo, useState } from 'react';
import {
  collection,
  doc,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';
import { Edit3, Info, Save, Search, Send } from 'lucide-react';
import { REPORT_STATUS_LABELS } from '../../constants/departments';
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
} from '../../types/inventory';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';
import { StatusBadge } from '../../components/common/StatusBadge';

interface WasteDraftRow {
  damagedQty: string;
  validRemainingQty: string;
  invalidRemainingQty: string;
}

export const WasteWorkspace: React.FC = () => {
  const { account, currentSession, categories, products } = useFirebase();

  const [report, setReport] = useState<DepartmentReport | null>(null);
  const [wasteMap, setWasteMap] = useState<Record<string, WasteDraftRow>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const [corrTarget, setCorrTarget] = useState<Product | null>(null);
  const [corrField, setCorrField] = useState<
    'damagedQty' | 'validRemainingQty' | 'invalidRemainingQty'
  >('validRemainingQty');
  const [corrNewVal, setCorrNewVal] = useState('');
  const [corrReason, setCorrReason] = useState('');

  const isSessionClosed = currentSession?.status === 'closed';
  const isSubmitted = report ? report.status !== 'draft' : false;

  const approvedProducts = useMemo(
    () =>
      products.filter(
        (p) =>
          p.approvalStatus === 'approved' && p.isActive && p.allowedDepartments.includes('waste')
      ),
    [products]
  );

  const categoryMap = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories]);

  useEffect(() => {
    if (!account || !currentSession) return;
    let active = true;
    ensureDepartmentReport(account, currentSession, 'waste')
      .then((rep) => {
        if (active) setReport(rep);
      })
      .catch((err) => {
        if (active) {
          setFeedback({ type: 'error', text: formatActionError(err, 'تعذر تحميل تقرير الهدر.') });
        }
      });

    const reportId = `${currentSession.id}_waste`;
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
        where('department', '==', 'waste')
      ),
      (snap) => {
        const next: Record<string, WasteDraftRow> = {};
        snap.forEach((docSnap) => {
          const item = docSnap.data() as DepartmentReportItem;
          next[item.productId] = {
            damagedQty:
              item.damagedQty !== null && item.damagedQty !== undefined
                ? String(item.damagedQty)
                : '',
            validRemainingQty:
              item.validRemainingQty !== null && item.validRemainingQty !== undefined
                ? String(item.validRemainingQty)
                : '',
            invalidRemainingQty:
              item.invalidRemainingQty !== null && item.invalidRemainingQty !== undefined
                ? String(item.invalidRemainingQty)
                : '',
          };
        });
        setWasteMap(next);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, `departmentReports/${reportId}/items`)
    );

    return () => {
      active = false;
      unsubRep();
      unsubItems();
    };
  }, [account?.uid, currentSession?.id]);

  const filteredProducts = useMemo(() => {
    return approvedProducts.filter((p) => {
      const matchesCat = selectedCategory === 'all' || p.categoryId === selectedCategory;
      const matchesSearch = !searchQuery.trim() || p.name.includes(searchQuery.trim());
      return matchesCat && matchesSearch;
    });
  }, [approvedProducts, selectedCategory, searchQuery]);

  const setField = (productId: string, key: keyof WasteDraftRow, val: string) => {
    setWasteMap((prev) => ({
      ...prev,
      [productId]: {
        damagedQty: prev[productId]?.damagedQty ?? '',
        validRemainingQty: prev[productId]?.validRemainingQty ?? '',
        invalidRemainingQty: prev[productId]?.invalidRemainingQty ?? '',
        [key]: val,
      },
    }));
  };

  const enteredCount = useMemo(() => {
    return Object.values(wasteMap).filter(
      (r) => r.damagedQty !== '' || r.validRemainingQty !== '' || r.invalidRemainingQty !== ''
    ).length;
  }, [wasteMap]);

  const parseItemsForSave = () => {
    return approvedProducts.map((p) => {
      const row = wasteMap[p.id];
      const parseVal = (raw?: string) => {
        if (raw === undefined || raw === '') return null;
        const num = Number(raw);
        if (Number.isNaN(num) || num < 0) {
          throw new Error(`القيمة المدخلة للصنف "${p.name}" يجب أن تكون رقماً غير سالب.`);
        }
        return num;
      };
      return {
        productId: p.id,
        categoryId: p.categoryId,
        damagedQty: parseVal(row?.damagedQty),
        validRemainingQty: parseVal(row?.validRemainingQty),
        invalidRemainingQty: parseVal(row?.invalidRemainingQty),
      };
    });
  };

  const handleSaveDraft = async () => {
    if (!account || !report) return;
    setBusy(true);
    setFeedback(null);
    try {
      const items = parseItemsForSave();
      await saveDepartmentReportDraft(account, report, items);
      setFeedback({ type: 'success', text: 'تم حفظ مسودة الهدر والمتبقي بنجاح.' });
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
      const items = parseItemsForSave();
      await saveDepartmentReportDraft(account, report, items);
      const count = items.filter(
        (i) =>
          i.damagedQty !== null ||
          i.validRemainingQty !== null ||
          i.invalidRemainingQty !== null
      ).length;
      await submitDepartmentReport(account, report, count);
      setConfirmOpen(false);
      setFeedback({ type: 'success', text: 'تم ترحيل تقرير الهدر والمتبقي بنجاح.' });
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
      const curRow = wasteMap[corrTarget.id];
      const oldV = curRow?.[corrField] ? Number(curRow[corrField]) : 0;
      const newV = Number(corrNewVal);
      if (Number.isNaN(newV) || newV < 0) throw new Error('أدخل كمية صحيحة.');
      await requestReportCorrection(account, report, corrTarget, corrField, oldV, newV, corrReason);
      setCorrTarget(null);
      setCorrNewVal('');
      setCorrReason('');
      setFeedback({ type: 'success', text: 'تم إرسال طلب التصحيح إلى الإدارة العليا.' });
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
          <h2 className="text-xl font-bold text-zinc-900 font-display">
            مساحة عمل الهدر والمتبقي
          </h2>
          <p className="mt-1 text-sm text-zinc-500">
            ثلاث خانات مستقلة لكل صنف — يمنع تسجيل نفس الوحدة في أكثر من خانة
          </p>
        </div>
        {report && (
          <StatusBadge
            label={`الحالة: ${REPORT_STATUS_LABELS[report.status]}`}
            tone={report.status === 'draft' ? 'warning' : 'success'}
            icon={report.status === 'draft' ? 'clock' : 'check'}
          />
        )}
      </div>

      {/* Clear distinction notice per PRD Section 7 */}
      <div className="rounded-2xl border border-zinc-200 bg-white p-4 flex items-start gap-3 text-xs text-zinc-600">
        <Info className="h-4 w-4 text-[#F39200] shrink-0 mt-0.5" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 w-full">
          <div>
            <strong className="text-zinc-900">التالف:</strong> منتج تلف أثناء العمل وتم استبعاده
            نهائياً.
          </div>
          <div>
            <strong className="text-emerald-700">المتبقي الصالح:</strong> بقي صالحاً وينتقل وحده
            كرصيد أول اليوم التالي.
          </div>
          <div>
            <strong className="text-red-700">المتبقي غير الصالح:</strong> بقي بنهاية اليوم وغير
            صالح للبيع أو الترحيل.
          </div>
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
            عدد الأصناف المدخلة: <strong className="tabular-nums">{enteredCount}</strong>
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
                <span>ترحيل تقرير الهدر</span>
              </button>
            </div>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-right text-sm">
            <thead className="bg-zinc-50 border-b border-zinc-200 text-xs text-zinc-500">
              <tr>
                <th className="px-5 py-3 font-semibold">الصنف</th>
                <th className="px-3 py-3 font-semibold">المجموعة</th>
                <th className="px-3 py-3 font-semibold">التالف</th>
                <th className="px-3 py-3 font-semibold">المتبقي الصالح</th>
                <th className="px-3 py-3 font-semibold">المتبقي غير الصالح</th>
                {isSubmitted && !isSessionClosed && (
                  <th className="px-4 py-3 font-semibold">تصحيح</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {filteredProducts.map((prod) => {
                const row = wasteMap[prod.id] || {
                  damagedQty: '',
                  validRemainingQty: '',
                  invalidRemainingQty: '',
                };
                return (
                  <tr key={prod.id} className="hover:bg-zinc-50/70">
                    <td className="px-5 py-3">
                      <div className="font-semibold text-zinc-900">{prod.name}</div>
                      <div className="text-xs text-zinc-400">{prod.unit}</div>
                    </td>
                    <td className="px-3 py-3 text-zinc-600">
                      {categoryMap.get(prod.categoryId) || '—'}
                    </td>
                    <td className="px-3 py-3">
                      <input
                        type="number"
                        min="0"
                        step="any"
                        disabled={isSubmitted || isSessionClosed}
                        value={row.damagedQty}
                        onChange={(e) => setField(prod.id, 'damagedQty', e.target.value)}
                        placeholder="0"
                        className="w-24 min-h-[40px] rounded-xl border border-zinc-200 px-2 text-center font-semibold tabular-nums disabled:bg-zinc-100"
                      />
                    </td>
                    <td className="px-3 py-3">
                      <input
                        type="number"
                        min="0"
                        step="any"
                        disabled={isSubmitted || isSessionClosed}
                        value={row.validRemainingQty}
                        onChange={(e) => setField(prod.id, 'validRemainingQty', e.target.value)}
                        placeholder="0"
                        className="w-24 min-h-[40px] rounded-xl border border-emerald-200 bg-emerald-50/30 px-2 text-center font-semibold tabular-nums disabled:bg-zinc-100"
                      />
                    </td>
                    <td className="px-3 py-3">
                      <input
                        type="number"
                        min="0"
                        step="any"
                        disabled={isSubmitted || isSessionClosed}
                        value={row.invalidRemainingQty}
                        onChange={(e) => setField(prod.id, 'invalidRemainingQty', e.target.value)}
                        placeholder="0"
                        className="w-24 min-h-[40px] rounded-xl border border-zinc-200 px-2 text-center font-semibold tabular-nums disabled:bg-zinc-100"
                      />
                    </td>
                    {isSubmitted && !isSessionClosed && (
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => {
                            setCorrTarget(prod);
                            setCorrField('validRemainingQty');
                            setCorrNewVal(row.validRemainingQty || '0');
                          }}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-[#D91B23] hover:underline cursor-pointer"
                        >
                          <Edit3 className="h-3.5 w-3.5" />
                          <span>طلب تصحيح</span>
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="تأكيد ترحيل تقرير الهدر والمتبقي"
        description="تأكد من عدم تكرار احتساب أي وحدة بين التالف والمتبقي الصالح وغير الصالح. سينتقل المتبقي الصالح فقط إلى اليوم التالي عند الإغلاق."
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
              طلب تصحيح الهدر — {corrTarget.name}
            </h3>
            <select
              value={corrField}
              onChange={(e) =>
                setCorrField(
                  e.target.value as 'damagedQty' | 'validRemainingQty' | 'invalidRemainingQty'
                )
              }
              className="w-full min-h-[42px] rounded-xl border border-zinc-200 px-3 text-sm"
            >
              <option value="damagedQty">التالف</option>
              <option value="validRemainingQty">المتبقي الصالح</option>
              <option value="invalidRemainingQty">المتبقي غير الصالح</option>
            </select>
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
                إرسال الطلب
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
