import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FileSpreadsheet,
  Search,
  X,
} from 'lucide-react';
import type { Product, ProductUnitOption, UnitBreakdown } from '../../types/inventory';
import {
  decomposeTotalToUnitCounts,
  getEffectiveProductUnits,
  roundQty3,
} from '../../utils/productUnits';
import {
  analyzeExcelSheet,
  guessUnitOptionForText,
  type ExcelMatchReason,
  type MatchedSourceLine,
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

interface ManualLinkEntry {
  productId: string;
  unitName?: string;
}

type UnitFilterTab = 'all' | 'multi' | 'single';

const MATCH_REASON_LABELS: Record<ExcelMatchReason, string> = {
  exact: 'مطابقة مباشرة',
  normalized: 'بعد توحيد النص',
  reordered: 'ترتيب كلمات مختلف',
  unit_variant: 'فصل الصنف والوحدة',
  subset: 'تمييز الصنف بدقة',
  fuzzy: 'تشابه إملائي',
  manual: 'ربط يدوي',
};

function formatFormulaLine(
  units: ProductUnitOption[],
  breakdown?: UnitBreakdown
): string {
  if (!breakdown) return '';
  const parts: string[] = [];
  for (const u of units) {
    const c = breakdown[u.name];
    if (typeof c === 'number' && c > 0) {
      parts.push(`${roundQty3(c)} ${u.name} (×${u.factor})`);
    }
  }
  return parts.join(' + ');
}

export const SalesExcelImportModal: React.FC<SalesExcelImportModalProps> = ({
  workbook,
  products,
  existingSalesMap,
  onConfirm,
  onClose,
}) => {
  const [selectedSheetName, setSelectedSheetName] = useState(workbook.defaultSheetName);
  const [columnOverride, setColumnOverride] = useState<{
    nameCol: number;
    qtyCol: number;
    unitCol: number;
  } | null>(null);
  const [deselectedProductIds, setDeselectedProductIds] = useState<Record<string, boolean>>({});
  const [manualLinks, setManualLinks] = useState<Record<string, ManualLinkEntry>>({});
  const [showIgnoredRows, setShowIgnoredRows] = useState(false);
  const [unitFilterTab, setUnitFilterTab] = useState<UnitFilterTab>('all');
  const [previewSearch, setPreviewSearch] = useState('');

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

  // Combine auto-matched items with any manually linked unrecognized items while preserving separated unit counts
  const combinedPreview = useMemo(() => {
    const mergedMap = new Map<
      string,
      {
        product: Product;
        effectiveUnits: ProductUnitOption[];
        hasMultiUnitSupport: boolean;
        qty: number;
        counts: Record<string, string>;
        breakdown?: UnitBreakdown;
        excelNames: string[];
        sourceLines: MatchedSourceLine[];
        matchReason: ExcelMatchReason;
        isManualAddition: boolean;
      }
    >();

    for (const item of analysis.matched) {
      mergedMap.set(item.product.id, {
        product: item.product,
        effectiveUnits: item.effectiveUnits,
        hasMultiUnitSupport: item.hasMultiUnitSupport,
        qty: item.extractedQty,
        counts: { ...item.counts },
        breakdown: item.unitBreakdown ? { ...item.unitBreakdown } : undefined,
        excelNames: [...item.excelNames],
        sourceLines: [...item.sourceLines],
        matchReason: item.matchReason,
        isManualAddition: false,
      });
    }

    for (const unrec of analysis.unrecognized) {
      const link = manualLinks[unrec.rowKey];
      if (!link?.productId) continue;
      const prod = productById.get(link.productId);
      if (!prod) continue;

      const units = getEffectiveProductUnits(prod);
      const chosenUnit =
        units.find((u) => u.name === link.unitName) ||
        guessUnitOptionForText(unrec.rawUnitHint || unrec.excelName, units) ||
        units[0];
      const factor = chosenUnit?.factor ?? 1;
      const unitLabel = chosenUnit?.name || prod.unit;
      const addedBase = roundQty3(unrec.extractedQty * factor);

      const manualLine: MatchedSourceLine = {
        rowNumber: unrec.sourceRowNumbers[0] || 0,
        excelName: unrec.excelName,
        rawQty: unrec.extractedQty,
        unitLabel,
        unitFactor: factor,
        baseEquivalent: addedBase,
        matchReason: 'manual',
      };

      const existing = mergedMap.get(prod.id);
      if (existing) {
        const nextTotal = roundQty3(existing.qty + addedBase);
        const nextBreakdown: UnitBreakdown = { ...(existing.breakdown || {}) };
        if (unrec.extractedQty > 0) {
          nextBreakdown[unitLabel] = roundQty3((nextBreakdown[unitLabel] || 0) + unrec.extractedQty);
        }
        const nextCounts = decomposeTotalToUnitCounts(
          nextTotal,
          units,
          Object.keys(nextBreakdown).length > 0 ? nextBreakdown : undefined
        );
        const finalBreakdown: UnitBreakdown = {};
        for (const u of units) {
          const val = Number(nextCounts[u.name] || 0);
          if (val > 0) finalBreakdown[u.name] = roundQty3(val);
        }
        existing.qty = nextTotal;
        existing.counts = nextCounts;
        existing.breakdown = Object.keys(finalBreakdown).length > 0 ? finalBreakdown : undefined;
        existing.excelNames.push(unrec.excelName);
        existing.sourceLines.push(manualLine);
      } else {
        const explicitBreakdown: UnitBreakdown = {};
        if (unrec.extractedQty > 0) {
          explicitBreakdown[unitLabel] = roundQty3(unrec.extractedQty);
        }
        const counts = decomposeTotalToUnitCounts(
          addedBase,
          units,
          Object.keys(explicitBreakdown).length > 0 ? explicitBreakdown : undefined
        );
        const breakdown: UnitBreakdown = {};
        for (const u of units) {
          const val = Number(counts[u.name] || 0);
          if (val > 0) breakdown[u.name] = roundQty3(val);
        }
        mergedMap.set(prod.id, {
          product: prod,
          effectiveUnits: units,
          hasMultiUnitSupport: units.length > 1,
          qty: addedBase,
          counts,
          breakdown: Object.keys(breakdown).length > 0 ? breakdown : undefined,
          excelNames: [unrec.excelName],
          sourceLines: [manualLine],
          matchReason: 'manual',
          isManualAddition: true,
        });
      }
    }

    return Array.from(mergedMap.values()).sort((a, b) => {
      if (a.hasMultiUnitSupport !== b.hasMultiUnitSupport) {
        return a.hasMultiUnitSupport ? -1 : 1;
      }
      return a.product.name.localeCompare(b.product.name, 'ar');
    });
  }, [analysis.matched, analysis.unrecognized, manualLinks, productById]);

  const multiUnitCount = useMemo(
    () => combinedPreview.filter((r) => r.hasMultiUnitSupport).length,
    [combinedPreview]
  );
  const singleUnitCount = useMemo(
    () => combinedPreview.filter((r) => !r.hasMultiUnitSupport).length,
    [combinedPreview]
  );

  const visiblePreview = useMemo(() => {
    const q = previewSearch.trim();
    return combinedPreview.filter((row) => {
      if (unitFilterTab === 'multi' && !row.hasMultiUnitSupport) return false;
      if (unitFilterTab === 'single' && row.hasMultiUnitSupport) return false;
      if (q) {
        const inProd = row.product.name.includes(q);
        const inExcel = row.excelNames.some((n) => n.includes(q));
        if (!inProd && !inExcel) return false;
      }
      return true;
    });
  }, [combinedPreview, unitFilterTab, previewSearch]);

  const visibleMultiRows = useMemo(
    () => visiblePreview.filter((r) => r.hasMultiUnitSupport),
    [visiblePreview]
  );
  const visibleSingleRows = useMemo(
    () => visiblePreview.filter((r) => !r.hasMultiUnitSupport),
    [visiblePreview]
  );

  const selectedRows = useMemo(
    () => combinedPreview.filter((row) => !deselectedProductIds[row.product.id]),
    [combinedPreview, deselectedProductIds]
  );

  const totalSelectedQty = useMemo(
    () => roundQty3(selectedRows.reduce((sum, r) => sum + r.qty, 0)),
    [selectedRows]
  );

  const unresolvedCount = useMemo(
    () => analysis.unrecognized.filter((u) => !manualLinks[u.rowKey]?.productId).length,
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

  const renderPreviewRow = (row: (typeof combinedPreview)[number]) => {
    const checked = !deselectedProductIds[row.product.id];
    const existingVal = existingSalesMap[row.product.id];
    const hasExisting = existingVal !== undefined && existingVal !== '';
    const formulaLine = row.hasMultiUnitSupport
      ? formatFormulaLine(row.effectiveUnits, row.breakdown)
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
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-bold text-zinc-900 text-sm">{row.product.name}</span>
            <span className="rounded-md bg-zinc-100 border border-zinc-200 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-600">
              {MATCH_REASON_LABELS[row.matchReason]}
            </span>
          </div>
          {row.sourceLines.length > 0 && (
            <div className="mt-1 space-y-0.5 text-[11px] text-zinc-500">
              {row.sourceLines.map((sl, idx) => (
                <div key={`${row.product.id}-sl-${idx}`} className="flex flex-wrap items-center gap-x-1.5">
                  <span className="text-zinc-700 font-medium">{sl.excelName}</span>
                  <span aria-hidden="true">←</span>
                  <span className="tabular-nums">
                    {sl.rawQty} {sl.unitLabel}
                  </span>
                  {sl.unitFactor !== 1 && (
                    <span className="text-zinc-400 tabular-nums">
                      (= {sl.baseEquivalent} {row.product.unit})
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </td>
        <td className="px-3 py-2.5 align-top">
          {row.hasMultiUnitSupport ? (
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-1.5 tabular-nums">
                {row.effectiveUnits.map((u) => {
                  const val = row.breakdown?.[u.name] ?? 0;
                  return (
                    <div
                      key={u.name}
                      className={`inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 text-[11px] ${
                        val > 0
                          ? 'border-emerald-200 bg-emerald-50 text-emerald-900 font-bold'
                          : 'border-zinc-200 bg-zinc-50 text-zinc-400'
                      }`}
                    >
                      <span>{u.name}:</span>
                      <span>{val}</span>
                    </div>
                  );
                })}
              </div>
              {formulaLine && (
                <div className="text-[10px] text-zinc-500 tabular-nums">{formulaLine}</div>
              )}
            </div>
          ) : (
            <span className="inline-flex items-center rounded-lg border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[11px] text-zinc-600">
              وحدة واحدة ({row.product.unit})
            </span>
          )}
        </td>
        <td className="px-3 py-2.5 align-top tabular-nums whitespace-nowrap">
          <div className="font-bold text-zinc-900 text-sm">
            {row.qty}{' '}
            <span className="font-normal text-xs text-zinc-500">{row.product.unit}</span>
          </div>
          {hasExisting && (
            <div className="text-[11px] text-amber-700 mt-0.5">
              الحالي: {existingVal}
            </div>
          )}
        </td>
      </tr>
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 sm:p-5"
      role="dialog"
      aria-modal="true"
      aria-labelledby="excel-import-preview-title"
    >
      <div className="w-full max-w-6xl max-h-[92vh] flex flex-col rounded-2xl bg-white border border-zinc-200 overflow-hidden">
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
        <div className="px-5 py-3 bg-zinc-50 border-b border-zinc-200 flex flex-col xl:flex-row xl:items-center justify-between gap-3">
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
                  const currentUnit = analysis.detection.unitCol;
                  setColumnOverride({
                    nameCol: nextNameCol,
                    qtyCol:
                      nextNameCol === currentQty
                        ? (nextNameCol + 1) % Math.max(headerOptions.length, 2)
                        : currentQty,
                    unitCol: currentUnit === nextNameCol ? -1 : currentUnit,
                  });
                }}
                className="min-h-[38px] rounded-lg border border-zinc-200 bg-white px-2.5 text-xs text-zinc-900 max-w-[160px]"
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
                  const currentUnit = analysis.detection.unitCol;
                  setColumnOverride({
                    nameCol:
                      nextQtyCol === currentName
                        ? (nextQtyCol + 1) % Math.max(headerOptions.length, 2)
                        : currentName,
                    qtyCol: nextQtyCol,
                    unitCol: currentUnit === nextQtyCol ? -1 : currentUnit,
                  });
                }}
                className="min-h-[38px] rounded-lg border border-zinc-200 bg-white px-2.5 text-xs text-zinc-900 max-w-[160px]"
              >
                {headerOptions.map((label, idx) => (
                  <option key={`qty-col-${idx}`} value={idx}>
                    {label}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-2 text-xs text-zinc-600">
              <span className="font-semibold whitespace-nowrap">عمود الوحدة:</span>
              <select
                value={analysis.detection.unitCol}
                onChange={(e) => {
                  const nextUnitCol = Number(e.target.value);
                  setColumnOverride({
                    nameCol: analysis.detection.nameCol,
                    qtyCol: analysis.detection.qtyCol,
                    unitCol: nextUnitCol,
                  });
                }}
                className="min-h-[38px] rounded-lg border border-zinc-200 bg-white px-2.5 text-xs text-zinc-900 max-w-[160px]"
              >
                <option value={-1}>تلقائي من اسم الصنف</option>
                {headerOptions.map((label, idx) => (
                  <option
                    key={`unit-col-${idx}`}
                    value={idx}
                    disabled={idx === analysis.detection.nameCol || idx === analysis.detection.qtyCol}
                  >
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
              بنص وربع:{' '}
              <strong className="text-zinc-900 font-bold">{multiUnitCount}</strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              وحدة واحدة:{' '}
              <strong className="text-zinc-900 font-bold">{singleUnitCount}</strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              غير معروفة:{' '}
              <strong className="text-amber-700 font-bold">{unresolvedCount}</strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              الصافي:{' '}
              <strong className="text-zinc-900 font-bold">{totalSelectedQty}</strong>
            </span>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
            {/* Matched Products Table */}
            <div className="lg:col-span-8 border border-zinc-200 rounded-xl overflow-hidden bg-white">
              <div className="px-4 py-3 border-b border-zinc-100 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
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

                {combinedPreview.length > 0 && (
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div className="inline-flex rounded-lg border border-zinc-200 bg-zinc-50 p-0.5">
                      <button
                        type="button"
                        onClick={() => setUnitFilterTab('all')}
                        className={`px-2.5 py-1.5 rounded-md text-xs font-semibold cursor-pointer whitespace-nowrap ${
                          unitFilterTab === 'all'
                            ? 'bg-white text-zinc-900 shadow-xs'
                            : 'text-zinc-600 hover:text-zinc-900'
                        }`}
                      >
                        الكل ({combinedPreview.length})
                      </button>
                      <button
                        type="button"
                        onClick={() => setUnitFilterTab('multi')}
                        className={`px-2.5 py-1.5 rounded-md text-xs font-semibold cursor-pointer whitespace-nowrap ${
                          unitFilterTab === 'multi'
                            ? 'bg-white text-[#D91B23] shadow-xs'
                            : 'text-zinc-600 hover:text-zinc-900'
                        }`}
                      >
                        أصناف بنص وربع ({multiUnitCount})
                      </button>
                      <button
                        type="button"
                        onClick={() => setUnitFilterTab('single')}
                        className={`px-2.5 py-1.5 rounded-md text-xs font-semibold cursor-pointer whitespace-nowrap ${
                          unitFilterTab === 'single'
                            ? 'bg-white text-zinc-900 shadow-xs'
                            : 'text-zinc-600 hover:text-zinc-900'
                        }`}
                      >
                        وحدة واحدة ({singleUnitCount})
                      </button>
                    </div>

                    <div className="relative">
                      <Search className="h-3.5 w-3.5 text-zinc-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        type="text"
                        value={previewSearch}
                        onChange={(e) => setPreviewSearch(e.target.value)}
                        placeholder="بحث: شواية، مضغوط، بروست..."
                        className="w-full sm:w-52 min-h-[34px] rounded-lg border border-zinc-200 bg-white pr-8 pl-2.5 text-xs text-zinc-800 placeholder:text-zinc-400 focus:border-[#D91B23] focus:outline-none"
                      />
                    </div>
                  </div>
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
              ) : visiblePreview.length === 0 ? (
                <div className="p-6 text-center text-xs text-zinc-500">
                  لا توجد أصناف مطابقة لخيار الفلترة أو البحث الحالي.
                </div>
              ) : (
                <div className="overflow-x-auto max-h-[440px] overflow-y-auto">
                  <table className="w-full text-right text-xs">
                    <thead className="bg-zinc-50 border-b border-zinc-200 text-zinc-500 sticky top-0 z-10">
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
                        <th className="px-3 py-2.5 font-semibold">الصنف وبنود الإكسل</th>
                        <th className="px-3 py-2.5 font-semibold">
                          الوحدات المفصولة (كامل / نص / ربع)
                        </th>
                        <th className="px-3 py-2.5 font-semibold">الصافي المعادل</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-100">
                      {unitFilterTab === 'all' ? (
                        <>
                          {visibleMultiRows.length > 0 && (
                            <tr className="bg-zinc-50/90 border-y border-zinc-200">
                              <td
                                colSpan={4}
                                className="px-3 py-1.5 text-[11px] font-bold text-zinc-700"
                              >
                                أصناف متعددة الوحدات (حبة / نفر · نص · ربع) — {visibleMultiRows.length}
                              </td>
                            </tr>
                          )}
                          {visibleMultiRows.map(renderPreviewRow)}
                          {visibleSingleRows.length > 0 && (
                            <tr className="bg-zinc-50/90 border-y border-zinc-200">
                              <td
                                colSpan={4}
                                className="px-3 py-1.5 text-[11px] font-bold text-zinc-700"
                              >
                                أصناف بوحدة واحدة — {visibleSingleRows.length}
                              </td>
                            </tr>
                          )}
                          {visibleSingleRows.map(renderPreviewRow)}
                        </>
                      ) : (
                        visiblePreview.map(renderPreviewRow)
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Side Panel: Unrecognized & Ignored */}
            <div className="lg:col-span-4 space-y-4">
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
                  <div className="divide-y divide-zinc-100 max-h-[340px] overflow-y-auto">
                    {analysis.unrecognized.map((item) => {
                      const currentLink = manualLinks[item.rowKey];
                      const linkedId = currentLink?.productId || '';
                      const linkedProduct = linkedId ? productById.get(linkedId) : undefined;
                      const linkedUnits = linkedProduct
                        ? getEffectiveProductUnits(linkedProduct)
                        : [];
                      const selectedUnitName =
                        currentLink?.unitName ||
                        (linkedUnits.length > 0
                          ? guessUnitOptionForText(
                              item.rawUnitHint || item.excelName,
                              linkedUnits
                            )?.name || linkedUnits[0].name
                          : '');

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
                              العدد: {item.extractedQty}
                            </div>
                          </div>

                          <select
                            value={linkedId}
                            onChange={(e) => {
                              const nextProdId = e.target.value;
                              if (!nextProdId) {
                                setManualLinks((prev) => {
                                  const next = { ...prev };
                                  delete next[item.rowKey];
                                  return next;
                                });
                                return;
                              }
                              const p = productById.get(nextProdId);
                              const pUnits = p ? getEffectiveProductUnits(p) : [];
                              const guessed =
                                guessUnitOptionForText(
                                  item.rawUnitHint || item.excelName,
                                  pUnits
                                ) || pUnits[0];
                              setManualLinks((prev) => ({
                                ...prev,
                                [item.rowKey]: {
                                  productId: nextProdId,
                                  unitName: guessed?.name,
                                },
                              }));
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

                          {linkedProduct && linkedUnits.length > 1 && (
                            <label className="flex items-center justify-between gap-2 text-[11px] text-zinc-600">
                              <span className="font-semibold whitespace-nowrap">وحدة البند:</span>
                              <select
                                value={selectedUnitName}
                                onChange={(e) => {
                                  const uName = e.target.value;
                                  setManualLinks((prev) => ({
                                    ...prev,
                                    [item.rowKey]: {
                                      productId: linkedProduct.id,
                                      unitName: uName,
                                    },
                                  }));
                                }}
                                aria-label={`وحدة ${item.excelName}`}
                                className="flex-1 min-h-[34px] rounded-lg border border-zinc-200 bg-white px-2 text-xs text-zinc-800"
                              >
                                {linkedUnits.map((u) => (
                                  <option key={u.name} value={u.name}>
                                    {u.name} (×{u.factor})
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
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
                ستُعبأ الكميات والأجزاء المفصولة (كامل/نص/ربع) في جدول المبيعات للمراجعة قبل الحفظ
                أو الترحيل.
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
