import React, { useEffect, useMemo, useState } from 'react';
import {
  collection,
  doc,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';
import { ArrowLeftRight, Edit3, Info, RefreshCw, Save, Search, Send } from 'lucide-react';
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
  UnitBreakdown,
} from '../../types/inventory';
import { roundQty } from '../../services/inventory/calculator';
import {
  decomposeTotalToUnitCounts,
  formatUnitsSummary,
  getEffectiveProductUnits,
  sumUnitCounts,
} from '../../utils/productUnits';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';
import { MultiUnitQtyInput } from '../../components/common/MultiUnitQtyInput';
import { StatusBadge } from '../../components/common/StatusBadge';
import { ReportDateTransferModal } from '../../components/inventory/ReportDateTransferModal';
import { getPreviousAdenDate } from '../../utils/dateAden';

interface WasteDraftRow {
  damagedQty: string;
  validRemainingQty: string;
  invalidRemainingQty: string;
}

type WasteFieldKey = keyof WasteDraftRow;
type WasteCountsRow = Partial<Record<WasteFieldKey, Record<string, string>>>;

export const WasteWorkspace: React.FC = () => {
  const {
    account,
    currentSession,
    sessionLoading,
    sessionError,
    refreshSession,
    categories,
    products,
    isAdmin,
    isDeptQtyReadOnly,
    inventoryDate,
  } = useFirebase();

  const [report, setReport] = useState<DepartmentReport | null>(null);
  const [wasteMap, setWasteMap] = useState<Record<string, WasteDraftRow>>({});
  const [wasteCountsMap, setWasteCountsMap] = useState<Record<string, WasteCountsRow>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const [corrTarget, setCorrTarget] = useState<Product | null>(null);
  const [corrField, setCorrField] = useState<WasteFieldKey>('validRemainingQty');
  const [corrNewVal, setCorrNewVal] = useState('');
  const [corrCounts, setCorrCounts] = useState<Record<string, string>>({});
  const [corrReason, setCorrReason] = useState('');
  const [transferModalOpen, setTransferModalOpen] = useState(false);

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
  const productMap = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  useEffect(() => {
    setReport(null);
    setWasteMap({});
    setWasteCountsMap({});
    if (!account || !currentSession) return;
    let active = true;
    if (!isDeptQtyReadOnly) {
      ensureDepartmentReport(account, currentSession, 'waste')
        .then((rep) => {
          if (active) setReport(rep);
        })
        .catch((err) => {
          if (active) {
            setFeedback({ type: 'error', text: formatActionError(err, 'تعذر تحميل تقرير الهدر.') });
          }
        });
    }

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
        const nextCounts: Record<string, WasteCountsRow> = {};
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
          const prod = productMap.get(item.productId);
          if (prod) {
            const units = getEffectiveProductUnits(prod);
            nextCounts[item.productId] = {
              damagedQty: decomposeTotalToUnitCounts(
                item.damagedQty,
                units,
                item.unitBreakdowns?.damagedQty
              ),
              validRemainingQty: decomposeTotalToUnitCounts(
                item.validRemainingQty,
                units,
                item.unitBreakdowns?.validRemainingQty
              ),
              invalidRemainingQty: decomposeTotalToUnitCounts(
                item.invalidRemainingQty,
                units,
                item.unitBreakdowns?.invalidRemainingQty
              ),
            };
          }
        });
        setWasteMap(next);
        setWasteCountsMap(nextCounts);
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

  const setFieldWithCounts = (
    productId: string,
    key: WasteFieldKey,
    val: string,
    counts: Record<string, string>
  ) => {
    setWasteMap((prev) => ({
      ...prev,
      [productId]: {
        damagedQty: prev[productId]?.damagedQty ?? '',
        validRemainingQty: prev[productId]?.validRemainingQty ?? '',
        invalidRemainingQty: prev[productId]?.invalidRemainingQty ?? '',
        [key]: val,
      },
    }));
    setWasteCountsMap((prev) => ({
      ...prev,
      [productId]: {
        ...(prev[productId] || {}),
        [key]: counts,
      },
    }));
  };

  const enteredCount = useMemo(() => {
    return approvedProducts.filter((p) => {
      const r = wasteMap[p.id];
      return r && (r.damagedQty !== '' || r.validRemainingQty !== '' || r.invalidRemainingQty !== '');
    }).length;
  }, [approvedProducts, wasteMap]);

  const parseItemsForSave = () => {
    return approvedProducts.map((p) => {
      const row = wasteMap[p.id];
      const countsRow = wasteCountsMap[p.id];
      const units = getEffectiveProductUnits(p);

      const resolveField = (key: WasteFieldKey) => {
        const counts = countsRow?.[key];
        if (counts && Object.keys(counts).length > 0) {
          const summed = sumUnitCounts(units, counts);
          if (summed.hasInvalid) {
            throw new Error(`القيمة المدخلة للصنف "${p.name}" يجب أن تكون رقماً غير سالب.`);
          }
          return {
            val: summed.total !== null ? roundQty(summed.total) : null,
            breakdown: summed.breakdown,
          };
        }
        const raw = row?.[key];
        if (raw === undefined || raw === '') return { val: null, breakdown: undefined };
        const num = Number(raw);
        if (Number.isNaN(num) || num < 0) {
          throw new Error(`القيمة المدخلة للصنف "${p.name}" يجب أن تكون رقماً غير سالب.`);
        }
        return { val: roundQty(num), breakdown: undefined };
      };

      const damaged = resolveField('damagedQty');
      const validRem = resolveField('validRemainingQty');
      const invalidRem = resolveField('invalidRemainingQty');
      const unitBreakdowns: Partial<Record<WasteFieldKey, UnitBreakdown>> = {};
      if (damaged.breakdown) unitBreakdowns.damagedQty = damaged.breakdown;
      if (validRem.breakdown) unitBreakdowns.validRemainingQty = validRem.breakdown;
      if (invalidRem.breakdown) unitBreakdowns.invalidRemainingQty = invalidRem.breakdown;

      return {
        productId: p.id,
        categoryId: p.categoryId,
        damagedQty: damaged.val,
        validRemainingQty: validRem.val,
        invalidRemainingQty: invalidRem.val,
        unitBreakdowns: Object.keys(unitBreakdowns).length > 0 ? unitBreakdowns : null,
      };
    });
  };

  const resolveActiveReport = async (): Promise<DepartmentReport> => {
    if (!account) throw new Error('يرجى تسجيل الدخول بحساب نشط أولاً.');
    if (!currentSession) {
      throw new Error(sessionError || 'جلسة الجرد اليومية غير جاهزة بعد.');
    }
    if (report && report.sessionId === currentSession.id) return report;
    const ensured = await ensureDepartmentReport(account, currentSession, 'waste');
    setReport(ensured);
    return ensured;
  };

  const handleSaveDraft = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      const activeReport = await resolveActiveReport();
      const items = parseItemsForSave();
      await saveDepartmentReportDraft(account!, activeReport, items);
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
    setBusy(true);
    setFeedback(null);
    try {
      const activeReport = await resolveActiveReport();
      const items = parseItemsForSave();
      await saveDepartmentReportDraft(account!, activeReport, items);
      const count = items.filter(
        (i) =>
          i.damagedQty !== null ||
          i.validRemainingQty !== null ||
          i.invalidRemainingQty !== null
      ).length;
      await submitDepartmentReport(account!, activeReport, count);
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
      await requestReportCorrection(
        account,
        report,
        corrTarget,
        corrField,
        oldV,
        roundQty(newV),
        corrReason
      );
      setCorrTarget(null);
      setCorrNewVal('');
      setCorrCounts({});
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
        <div className="flex flex-wrap items-center gap-2.5">
          {report && (
            <StatusBadge
              label={`الحالة: ${REPORT_STATUS_LABELS[report.status]}`}
              tone={report.status === 'draft' ? 'warning' : 'success'}
              icon={report.status === 'draft' ? 'clock' : 'check'}
            />
          )}
          {isAdmin && (
            <button
              type="button"
              onClick={() => setTransferModalOpen(true)}
              className="min-h-[38px] inline-flex items-center gap-1.5 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs font-bold text-zinc-700 hover:border-[#D91B23] hover:text-[#D91B23] cursor-pointer whitespace-nowrap"
              title="نقل تقرير الهدر والمتبقي (حتى بعد الترحيل) إلى تاريخ آخر — للإدارة فقط"
            >
              <ArrowLeftRight className="h-3.5 w-3.5" />
              <span>نقل لتاريخ آخر</span>
            </button>
          )}
        </div>
      </div>

      {isDeptQtyReadOnly && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-semibold text-amber-900">
          وضع الاطلاع فقط — صلاحيات إدخال أو تعديل كميات الهدر والمتبقي مقتصرة على موظفي الهدر ومخفية عن المدير التنفيذي ومدير الفرع.
        </div>
      )}

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
          {!isDeptQtyReadOnly && !isSubmitted && !isSessionClosed && (
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
                {!isDeptQtyReadOnly && isSubmitted && !isSessionClosed && (
                  <th className="px-4 py-3 font-semibold">تصحيح</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {filteredProducts.map((prod) => {
                const effectiveUnits = getEffectiveProductUnits(prod);
                const row = wasteMap[prod.id] || {
                  damagedQty: '',
                  validRemainingQty: '',
                  invalidRemainingQty: '',
                };
                const countsRow = wasteCountsMap[prod.id];
                const getCountsFor = (key: WasteFieldKey) =>
                  countsRow?.[key] ??
                  (row[key] !== ''
                    ? decomposeTotalToUnitCounts(Number(row[key]), effectiveUnits)
                    : {});
                return (
                  <tr key={prod.id} className="hover:bg-zinc-50/70">
                    <td className="px-5 py-3">
                      <div className="font-semibold text-zinc-900">{prod.name}</div>
                      <div className="text-xs text-zinc-400">
                        {effectiveUnits.length > 1
                          ? formatUnitsSummary(effectiveUnits)
                          : prod.unit}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-zinc-600">
                      {categoryMap.get(prod.categoryId) || '—'}
                    </td>
                    <td className="px-3 py-3">
                      <MultiUnitQtyInput
                        product={prod}
                        counts={getCountsFor('damagedQty')}
                        totalValue={row.damagedQty}
                        readOnly={isDeptQtyReadOnly}
                        disabled={isSubmitted || isSessionClosed}
                        compact
                        placeholder="0"
                        onChange={(nextCounts, nextTotalStr) =>
                          setFieldWithCounts(prod.id, 'damagedQty', nextTotalStr, nextCounts)
                        }
                      />
                    </td>
                    <td className="px-3 py-3">
                      <MultiUnitQtyInput
                        product={prod}
                        counts={getCountsFor('validRemainingQty')}
                        totalValue={row.validRemainingQty}
                        readOnly={isDeptQtyReadOnly}
                        disabled={isSubmitted || isSessionClosed}
                        compact
                        tone="emerald"
                        placeholder="0"
                        onChange={(nextCounts, nextTotalStr) =>
                          setFieldWithCounts(prod.id, 'validRemainingQty', nextTotalStr, nextCounts)
                        }
                      />
                    </td>
                    <td className="px-3 py-3">
                      <MultiUnitQtyInput
                        product={prod}
                        counts={getCountsFor('invalidRemainingQty')}
                        totalValue={row.invalidRemainingQty}
                        readOnly={isDeptQtyReadOnly}
                        disabled={isSubmitted || isSessionClosed}
                        compact
                        placeholder="0"
                        onChange={(nextCounts, nextTotalStr) =>
                          setFieldWithCounts(prod.id, 'invalidRemainingQty', nextTotalStr, nextCounts)
                        }
                      />
                    </td>
                    {!isDeptQtyReadOnly && isSubmitted && !isSessionClosed && (
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => {
                            const initVal = row.validRemainingQty || '0';
                            setCorrTarget(prod);
                            setCorrField('validRemainingQty');
                            setCorrNewVal(initVal);
                            setCorrCounts(
                              decomposeTotalToUnitCounts(Number(initVal || 0), effectiveUnits)
                            );
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
              onChange={(e) => {
                const nextField = e.target.value as WasteFieldKey;
                const initVal = wasteMap[corrTarget.id]?.[nextField] || '0';
                setCorrField(nextField);
                setCorrNewVal(initVal);
                setCorrCounts(
                  decomposeTotalToUnitCounts(
                    Number(initVal || 0),
                    getEffectiveProductUnits(corrTarget)
                  )
                );
              }}
              className="w-full min-h-[42px] rounded-xl border border-zinc-200 px-3 text-sm"
            >
              <option value="damagedQty">التالف</option>
              <option value="validRemainingQty">المتبقي الصالح</option>
              <option value="invalidRemainingQty">المتبقي غير الصالح</option>
            </select>
            <MultiUnitQtyInput
              product={corrTarget}
              counts={corrCounts}
              totalValue={corrNewVal}
              fullWidth
              onChange={(nextCounts, nextTotalStr) => {
                setCorrCounts(nextCounts);
                setCorrNewVal(nextTotalStr);
              }}
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
      <ReportDateTransferModal
        open={transferModalOpen}
        initialDepartment="waste"
        initialFromDate={inventoryDate}
        initialToDate={getPreviousAdenDate(inventoryDate)}
        onClose={() => setTransferModalOpen(false)}
        onSuccess={(msg) => setFeedback({ type: 'success', text: msg })}
      />
    </div>
  );
};
