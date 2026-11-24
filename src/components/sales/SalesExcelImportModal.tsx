import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FileSpreadsheet,
  X,
} from 'lucide-react';
import type { Product, ProductUnitOption, UnitBreakdown } from '../../types/inventory';
import {
  decomposeTotalToUnitCounts,
  formatBreakdownText,
  getEffectiveProductUnits,
  roundQty3,
} from '../../utils/productUnits';
import {
  analyzeExcelSheet,
  type ExcelMatchReason,
  type ParsedExcelWorkbook,
} from '../../utils/salesExcelImport';

export interface ApprovedExcelImportRow {
  product: Product;
  qty: number;
  counts: Record<string, string>;
  breakdown?: UnitBreakdown;
}

interface SalesExcelImportModalProps {
  workbook: ParsedExcelWorkbook;
  products: Product[];
  existingSalesMap: Record<string, string>;
  onConfirm: (rows: ApprovedExcelImportRow[]) => void;
  onClose: () => void;
}

const MATCH_REASON_LABELS: Record<ExcelMatchReason, string> = {
  exact: 'مطابقة مباشرة',
  normalized: 'بعد توحيد النص',
  reordered: 'ترتيب كلمات مختلف',
  unit_variant: 'مطابقة بالصنف والوحدة',
  subset: 'مطابقة جزئية دقيقة',
  fuzzy: 'تشابه إملائي',
  manual: 'ربط يدوي',
};

export const SalesExcelImportModal: React.FC<SalesExcelImportModalProps> = ({
  workbook,
  products,
  existingSalesMap,
  onConfirm,
  onClose,
}) => {
  const [selectedSheetName, setSelectedSheetName] = useState(workbook.defaultSheetName);
  const [columnOverride, setColumnOverride] = useState<{ nameCol: number; qtyCol: number } | null>(
    null
  );
  const [deselectedProductIds, setDeselectedProductIds] = useState<Record<string, boolean>>({});
  const [manualLinks, setManualLinks] = useState<Record<string, string>>({});
  const [showIgnoredRows, setShowIgnoredRows] = useState(false);

  const activeSheet = useMemo(
    () => workbook.sheets.find((s) => s.name === selectedSheetName) || workbook.sheets[0],
    [workbook, selectedSheetName]
  );

  const analysis = useMemo(() => {
    return analyzeExcelSheet(activeSheet, products, columnOverride || undefined);
  }, [activeSheet, products, columnOverride]);

  // Reset per-sheet selections when sheet or columns change
  useEffect(() => {
    setDeselectedProductIds({});
    setManualLinks({});
  }, [selectedSheetName, columnOverride]);

  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  // Combine auto-matched items with any manually linked unrecognized items
  const combinedPreview = useMemo(() => {
    const mergedMap = new Map<
      string,
      {
        product: Product;
        effectiveUnits: ProductUnitOption[];
        qty: number;
        counts: Record<string, string>;
        breakdown?: UnitBreakdown;
        excelNames: string[];
        matchReason: ExcelMatchReason;
        isManualAddition: boolean;
      }
    >();

    for (const item of analysis.matched) {
      mergedMap.set(item.product.id, {
        product: item.product,
        effectiveUnits: item.effectiveUnits,
        qty: item.extractedQty,
        counts: item.counts,
        breakdown: item.unitBreakdown,
        excelNames: [...item.excelNames],
        matchReason: item.matchReason,
        isManualAddition: false,
      });
    }

    for (const unrec of analysis.unrecognized) {
      const targetProdId = manualLinks[unrec.rowKey];
      if (!targetProdId) continue;
      const prod = productById.get(targetProdId);
      if (!prod) continue;
      const units = getEffectiveProductUnits(prod);
      const existing = mergedMap.get(prod.id);
      if (existing) {
        const nextTotal = roundQty3(existing.qty + unrec.extractedQty);
        const nextCounts = decomposeTotalToUnitCounts(nextTotal, units);
        const nextBreakdown: UnitBreakdown = {};
        for (const u of units) {
          const val = Number(nextCounts[u.name] || 0);
          if (val > 0) nextBreakdown[u.name] = roundQty3(val);
        }
        existing.qty = nextTotal;
        existing.counts = nextCounts;
        existing.breakdown = Object.keys(nextBreakdown).length > 0 ? nextBreakdown : undefined;
        existing.excelNames.push(unrec.excelName);
      } else {
        const counts = decomposeTotalToUnitCounts(unrec.extractedQty, units);
        const breakdown: UnitBreakdown = {};
        for (const u of units) {
          const val = Number(counts[u.name] || 0);
          if (val > 0) breakdown[u.name] = roundQty3(val);
        }
        mergedMap.set(prod.id, {
          product: prod,
          effectiveUnits: units,
          qty: unrec.extractedQty,
          counts,
          breakdown: Object.keys(breakdown).length > 0 ? breakdown : undefined,
          excelNames: [unrec.excelName],
          matchReason: 'manual',
          isManualAddition: true,
        });
      }
    }

    return Array.from(mergedMap.values());
  }, [analysis.matched, analysis.unrecognized, manualLinks, productById]);

  const selectedRows = useMemo(
    () => combinedPreview.filter((row) => !deselectedProductIds[row.product.id]),
    [combinedPreview, deselectedProductIds]
  );

  const totalSelectedQty = useMemo(
    () => roundQty3(selectedRows.reduce((sum, r) => sum + r.qty, 0)),
    [selectedRows]
  );

  const unresolvedCount = useMemo(
    () => analysis.unrecognized.filter((u) => !manualLinks[u.rowKey]).length,
    [analysis.unrecognized, manualLinks]
  );

  const overwriteCount = useMemo(
    () =>
      selectedRows.filter((r) => {
        const current = existingSalesMap[r.product.id];
        return current !== undefined && current !== '';
      }).length,
    [selectedRows, existingSalesMap]
  );

  const allSelected =
    combinedPreview.length > 0 && selectedRows.length === combinedPreview.length;

  const toggleAll = () => {
    if (allSelected) {
      const next: Record<string, boolean> = {};
      for (const row of combinedPreview) next[row.product.id] = true;
      setDeselectedProductIds(next);
    } else {
      setDeselectedProductIds({});
    }
  };

  const handleConfirmImport = () => {
    const payload: ApprovedExcelImportRow[] = selectedRows.map((r) => ({
      product: r.product,
      qty: r.qty,
      counts: r.counts,
      breakdown: r.breakdown,
    }));
    onConfirm(payload);
  };

  const headerOptions = analysis.detection.headers;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 sm:p-5"
      role="dialog"
      aria-modal="true"
      aria-labelledby="excel-import-preview-title"
    >
      <div className="w-full max-w-5xl max-h-[92vh] flex flex-col rounded-2xl bg-white border border-zinc-200 overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-zinc-200 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-zinc-900">
              <FileSpreadsheet className="h-5 w-5 text-[#D91B23] shrink-0" />
              <h3
                id="excel-import-preview-title"
                className="text-lg font-bold font-display truncate"
              >
                معاينة استيراد المبيعات من إكسل
              </h3>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
              <span className="font-medium text-zinc-700 truncate max-w-[260px]">
                {workbook.fileName}
              </span>
              <span aria-hidden="true">·</span>
              <span>ورقة: {analysis.sheetName}</span>
              <span aria-hidden="true">·</span>
              <span>
                {analysis.detection.autoDetected
                  ? 'تم التعرف على الأعمدة تلقائياً'
                  : 'تحديد الأعمدة بالاستدلال'}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق المعاينة"
            className="min-h-[40px] min-w-[40px] inline-flex items-center justify-center rounded-xl border border-zinc-200 text-zinc-500 hover:bg-zinc-50 hover:text-zinc-900 cursor-pointer shrink-0"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Sheet & Column Controls + Summary */}
        <div className="px-5 py-3 bg-zinc-50 border-b border-zinc-200 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            {workbook.sheets.length > 1 && (
              <label className="flex items-center gap-2 text-xs text-zinc-600">
                <span className="font-semibold whitespace-nowrap">الورقة:</span>
                <select
                  value={selectedSheetName}
                  onChange={(e) => {
                    setSelectedSheetName(e.target.value);
                    setColumnOverride(null);
                  }}
                  className="min-h-[38px] rounded-lg border border-zinc-200 bg-white px-2.5 text-xs text-zinc-900"
                >
                  {workbook.sheets.map((s) => (
                    <option key={s.name} value={s.name}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <label className="flex items-center gap-2 text-xs text-zinc-600">
              <span className="font-semibold whitespace-nowrap">عمود الصنف:</span>
              <select
                value={analysis.detection.nameCol}
                onChange={(e) => {
                  const nextNameCol = Number(e.target.value);
                  const currentQty = analysis.detection.qtyCol;
                  setColumnOverride({
                    nameCol: nextNameCol,
                    qtyCol:
                      nextNameCol === currentQty
                        ? (nextNameCol + 1) % Math.max(headerOptions.length, 2)
                        : currentQty,
                  });
                }}
                className="min-h-[38px] rounded-lg border border-zinc-200 bg-white px-2.5 text-xs text-zinc-900 max-w-[170px]"
              >
                {headerOptions.map((label, idx) => (
                  <option key={`name-col-${idx}`} value={idx}>
                    {label}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-2 text-xs text-zinc-600">
              <span className="font-semibold whitespace-nowrap">عمود الكمية:</span>
              <select
                value={analysis.detection.qtyCol}
                onChange={(e) => {
                  const nextQtyCol = Number(e.target.value);
                  const currentName = analysis.detection.nameCol;
                  setColumnOverride({
                    nameCol:
                      nextQtyCol === currentName
                        ? (nextQtyCol + 1) % Math.max(headerOptions.length, 2)
                        : currentName,
                    qtyCol: nextQtyCol,
                  });
                }}
                className="min-h-[38px] rounded-lg border border-zinc-200 bg-white px-2.5 text-xs text-zinc-900 max-w-[170px]"
              >
                {headerOptions.map((label, idx) => (
                  <option key={`qty-col-${idx}`} value={idx}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-600 tabular-nums">
            <span>
              مطابقة:{' '}
              <strong className="text-emerald-700 font-bold">{combinedPreview.length}</strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              غير معروفة:{' '}
              <strong className="text-amber-700 font-bold">{unresolvedCount}</strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              مهملة:{' '}
              <strong className="text-zinc-800 font-bold">{analysis.ignoredRows.length}</strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              إجمالي الكمية:{' '}
              <strong className="text-zinc-900 font-bold">{totalSelectedQty}</strong>
            </span>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
            {/* Matched Products Table */}
            <div className="lg:col-span-7 border border-zinc-200 rounded-xl overflow-hidden bg-white">
              <div className="px-4 py-3 border-b border-zinc-100 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                  <h4 className="text-sm font-bold text-zinc-900">
                    الأصناف المطابقة بنجاح ({selectedRows.length} / {combinedPreview.length})
                  </h4>
                </div>
                {combinedPreview.length > 0 && (
                  <button
                    type="button"
                    onClick={toggleAll}
                    className="text-xs font-semibold text-[#D91B23] hover:underline cursor-pointer whitespace-nowrap"
                  >
                    {allSelected ? 'إلغاء تحديد الكل' : 'تحديد الكل'}
                  </button>
                )}
              </div>

              {combinedPreview.length === 0 ? (
                <div className="p-6 text-center space-y-1.5">
                  <p className="text-sm font-semibold text-zinc-800">
                    لم تتم مطابقة أي صنف من الورقة المحددة.
                  </p>
                  <p className="text-xs text-zinc-500">
                    تحقق من اختيار «عمود الصنف» و«عمود الكمية» الصحيحين أعلاه أو اربط الأصناف من
                    القائمة الجانبية.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
                  <table className="w-full text-right text-xs">
                    <thead className="bg-zinc-50 border-b border-zinc-200 text-zinc-500 sticky top-0">
                      <tr>
                        <th className="px-3 py-2.5 w-9">
                          <input
                            type="checkbox"
                            checked={allSelected}
                            onChange={toggleAll}
                            aria-label="تحديد جميع الأصناف المطابقة"
                            className="h-4 w-4 accent-[#D91B23] cursor-pointer"
                          />
                        </th>
                        <th className="px-3 py-2.5 font-semibold">الصنف في الجرد</th>
                        <th className="px-3 py-2.5 font-semibold">الكمية المستخرجة</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-100">
                      {combinedPreview.map((row) => {
                        const checked = !deselectedProductIds[row.product.id];
                        const existingVal = existingSalesMap[row.product.id];
                        const hasExisting = existingVal !== undefined && existingVal !== '';
                        const breakdownText =
                          row.effectiveUnits.length > 1
                            ? formatBreakdownText(row.breakdown, row.effectiveUnits)
                            : '';

                        return (
                          <tr
                            key={row.product.id}
                            className={checked ? 'hover:bg-zinc-50/80' : 'opacity-50 bg-zinc-50/40'}
                          >
                            <td className="px-3 py-2.5 align-top">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() =>
                                  setDeselectedProductIds((prev) => ({
                                    ...prev,
                                    [row.product.id]: checked,
                                  }))
                                }
                                aria-label={`استيراد ${row.product.name}`}
                                className="h-4 w-4 mt-0.5 accent-[#D91B23] cursor-pointer"
                              />
                            </td>
                            <td className="px-3 py-2.5 align-top">
                              <div className="font-semibold text-zinc-900 text-sm">
                                {row.product.name}
                              </div>
                              <div className="mt-0.5 text-[11px] text-zinc-500 flex flex-wrap items-center gap-x-1.5">
                                <span>{MATCH_REASON_LABELS[row.matchReason]}</span>
                                {row.excelNames.some((n) => n !== row.product.name) && (
                                  <>
                                    <span aria-hidden="true">·</span>
                                    <span>من الملف: {row.excelNames.join('، ')}</span>
                                  </>
                                )}
                              </div>
                            </td>
                            <td className="px-3 py-2.5 align-top tabular-nums">
                              <div className="font-bold text-zinc-900 text-sm">
                                {row.qty}{' '}
                                <span className="font-normal text-xs text-zinc-500">
                                  {row.product.unit}
                                </span>
                              </div>
                              {breakdownText && (
                                <div className="text-[11px] text-zinc-500 mt-0.5">
                                  {breakdownText}
                                </div>
                              )}
                              {hasExisting && (
                                <div className="text-[11px] text-amber-700 mt-0.5">
                                  الحالي في الجدول: {existingVal}
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Side Panel: Unrecognized & Ignored */}
            <div className="lg:col-span-5 space-y-4">
              <div className="border border-zinc-200 rounded-xl overflow-hidden bg-white">
                <div className="px-4 py-3 border-b border-zinc-100 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
                    <h4 className="text-sm font-bold text-zinc-900">
                      أصناف لم يتم التعرف عليها ({analysis.unrecognized.length})
                    </h4>
                  </div>
                </div>

                {analysis.unrecognized.length === 0 ? (
                  <div className="p-4 text-xs text-zinc-500">
                    تم التعرف على جميع الأصناف ذات الكميات الصالحة في الملف.
                  </div>
                ) : (
                  <div className="divide-y divide-zinc-100 max-h-[300px] overflow-y-auto">
                    {analysis.unrecognized.map((item) => {
                      const linkedId = manualLinks[item.rowKey] || '';
                      return (
                        <div key={item.rowKey} className="p-3 space-y-2">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-xs font-semibold text-zinc-900 break-words">
                                {item.excelName}
                              </div>
                              <div className="text-[11px] text-zinc-500 tabular-nums">
                                صف {item.sourceRowNumbers.join('، ')}
                              </div>
                            </div>
                            <div className="text-xs font-bold text-zinc-800 tabular-nums shrink-0">
                              الكمية: {item.extractedQty}
                            </div>
                          </div>

                          <select
                            value={linkedId}
                            onChange={(e) => {
                              const val = e.target.value;
                              setManualLinks((prev) => ({ ...prev, [item.rowKey]: val }));
                            }}
                            aria-label={`ربط الصنف ${item.excelName}`}
                            className="w-full min-h-[36px] rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 text-xs text-zinc-700"
                          >
                            <option value="">إهمال هذا الصنف (غير مرتبط)</option>
                            {products.map((p) => (
                              <option key={p.id} value={p.id}>
                                ربط مع: {p.name} ({p.unit})
                              </option>
                            ))}
                          </select>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {analysis.ignoredRows.length > 0 && (
                <div className="border border-zinc-200 rounded-xl overflow-hidden bg-white">
                  <button
                    type="button"
                    onClick={() => setShowIgnoredRows((v) => !v)}
                    className="w-full px-4 py-3 flex items-center justify-between text-xs font-semibold text-zinc-700 hover:bg-zinc-50 cursor-pointer"
                  >
                    <span>
                      صفوف مهملة تلقائياً (إجماليات / عناوين / غير رقمية):{' '}
                      <strong className="tabular-nums">{analysis.ignoredRows.length}</strong>
                    </span>
                    {showIgnoredRows ? (
                      <ChevronUp className="h-4 w-4 text-zinc-400" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-zinc-400" />
                    )}
                  </button>

                  {showIgnoredRows && (
                    <div className="border-t border-zinc-100 divide-y divide-zinc-100 max-h-[180px] overflow-y-auto">
                      {analysis.ignoredRows.map((ig, idx) => (
                        <div
                          key={`ig-${ig.rowNumber}-${idx}`}
                          className="px-4 py-2 text-[11px] text-zinc-600 flex items-center justify-between gap-2"
                        >
                          <span className="truncate">
                            صف {ig.rowNumber}: {ig.rawName} ({ig.rawQty})
                          </span>
                          <span className="text-zinc-400 shrink-0">{ig.reason}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-zinc-200 bg-zinc-50 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="text-xs text-zinc-600">
            {overwriteCount > 0 ? (
              <span className="text-amber-700 font-medium">
                ملاحظة: سيتم تحديث الكميات لـ {overwriteCount} صنف مدخل مسبقاً وإدخال البقية دون
                ترحيل نهائي حتى تضغط حفظ أو ترحيل.
              </span>
            ) : (
              <span>
                ستُعبأ الكميات في جدول المبيعات للمراجعة، ولن تُحفظ في الجرد إلا بعد الضغط على حفظ
                المسودة أو ترحيل التقرير.
              </span>
            )}
          </div>
          <div className="flex items-center justify-end gap-2 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[42px] px-4 py-2 rounded-xl border border-zinc-200 bg-white text-xs font-semibold text-zinc-700 hover:bg-zinc-100 cursor-pointer whitespace-nowrap"
            >
              إلغاء
            </button>
            <button
              type="button"
              disabled={selectedRows.length === 0}
              onClick={handleConfirmImport}
              className="min-h-[42px] px-5 py-2 rounded-xl bg-[#D91B23] text-xs font-bold text-white hover:bg-[#B9141B] cursor-pointer disabled:opacity-50 whitespace-nowrap"
            >
              اعتماد وإدخال في الجدول ({selectedRows.length})
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
