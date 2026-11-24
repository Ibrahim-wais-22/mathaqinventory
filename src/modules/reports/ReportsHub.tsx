import React, { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { FileSpreadsheet, Printer, Search } from 'lucide-react';
import { BRAND_NAME } from '../../constants/departments';
import { useFirebase } from '../../app/providers/FirebaseProvider';
import { OperationType, db, handleFirestoreError } from '../../services/firebase/config';
import {
  ALL_REPORTS,
  type ReportTypeId,
  buildReportTable,
  exportReportToExcel,
} from '../../services/reports/reportEngine';
import { recalculateSessionResults } from '../../services/inventory/firestoreService';
import type {
  DailySession,
  DepartmentReport,
  FactoryTransfer,
  ProductResult,
  ProductionEntry,
} from '../../types/inventory';
import { BrandLogo } from '../../components/common/BrandLogo';

export const ReportsHub: React.FC<{ initialReportId?: string }> = ({ initialReportId }) => {
  const { account, isAdmin, hasPermission, categories, products, inventoryDate } = useFirebase();

  const [selectedReport, setSelectedReport] = useState<ReportTypeId>(
    (initialReportId as ReportTypeId) || 'daily_detailed'
  );
  const [fromDate, setFromDate] = useState(inventoryDate);
  const [toDate, setToDate] = useState(inventoryDate);
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [productSearch, setProductSearch] = useState('');

  const [results, setResults] = useState<ProductResult[]>([]);
  const [transfers, setTransfers] = useState<FactoryTransfer[]>([]);
  const [prodEntries, setProdEntries] = useState<ProductionEntry[]>([]);
  const [deptReports, setDeptReports] = useState<DepartmentReport[]>([]);
  const [sessions, setSessions] = useState<DailySession[]>([]);

  const canViewResults = isAdmin || hasPermission('view_results') || hasPermission('view_reports');
  const canViewTransfers =
    isAdmin || account?.department === 'factory' || account?.department === 'production';
  const canViewProductionEntries = isAdmin || account?.department === 'production';

  useEffect(() => {
    if (initialReportId && ALL_REPORTS.some((r) => r.id === initialReportId)) {
      setSelectedReport(initialReportId as ReportTypeId);
    }
  }, [initialReportId]);

  useEffect(() => {
    setFromDate(inventoryDate);
    setToDate(inventoryDate);
  }, [inventoryDate]);

  useEffect(() => {
    if (!account || account.status !== 'active') return;
    const start = fromDate <= toDate ? fromDate : toDate;
    const end = fromDate <= toDate ? toDate : fromDate;

    const unsubs: Array<() => void> = [];

    if (canViewResults) {
      unsubs.push(
        onSnapshot(
          query(
            collection(db, 'productResults'),
            where('inventoryDate', '>=', start),
            where('inventoryDate', '<=', end)
          ),
          (snap) => {
            setResults(
              snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<ProductResult, 'id'>) }))
            );
          },
          (err) => handleFirestoreError(err, OperationType.LIST, 'productResults')
        )
      );
    } else {
      setResults([]);
    }

    if (canViewTransfers) {
      unsubs.push(
        onSnapshot(
          query(
            collection(db, 'factoryTransfers'),
            where('inventoryDate', '>=', start),
            where('inventoryDate', '<=', end)
          ),
          (snap) => {
            setTransfers(
              snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<FactoryTransfer, 'id'>) }))
            );
          },
          (err) => handleFirestoreError(err, OperationType.LIST, 'factoryTransfers')
        )
      );
    } else {
      setTransfers([]);
    }

    if (canViewProductionEntries) {
      unsubs.push(
        onSnapshot(
          query(
            collection(db, 'productionEntries'),
            where('inventoryDate', '>=', start),
            where('inventoryDate', '<=', end)
          ),
          (snap) => {
            setProdEntries(
              snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<ProductionEntry, 'id'>) }))
            );
          },
          (err) => handleFirestoreError(err, OperationType.LIST, 'productionEntries')
        )
      );
    } else {
      setProdEntries([]);
    }

    const repQ = isAdmin
      ? query(
          collection(db, 'departmentReports'),
          where('inventoryDate', '>=', start),
          where('inventoryDate', '<=', end)
        )
      : query(
          collection(db, 'departmentReports'),
          where('department', '==', account.department)
        );

    unsubs.push(
      onSnapshot(
        repQ,
        (snap) => {
          const mapped = snap.docs
            .map((d) => ({ id: d.id, ...(d.data() as Omit<DepartmentReport, 'id'>) }))
            .filter((r) => isAdmin || (r.inventoryDate >= start && r.inventoryDate <= end));
          setDeptReports(mapped);
        },
        (err) => handleFirestoreError(err, OperationType.LIST, 'departmentReports')
      )
    );

    unsubs.push(
      onSnapshot(
        query(
          collection(db, 'dailySessions'),
          where('inventoryDate', '>=', start),
          where('inventoryDate', '<=', end)
        ),
        (snap) => {
          setSessions(
            snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<DailySession, 'id'>) }))
          );
        },
        (err) => handleFirestoreError(err, OperationType.LIST, 'dailySessions')
      )
    );

    return () => {
      unsubs.forEach((u) => u());
    };
  }, [
    account?.uid,
    account?.status,
    account?.department,
    isAdmin,
    canViewResults,
    canViewTransfers,
    canViewProductionEntries,
    fromDate,
    toDate,
  ]);

  // Keep open/reopened sessions' central results numerically updated when viewing reports
  useEffect(() => {
    if (!account || !isAdmin || products.length === 0 || categories.length === 0) return;
    const openSessions = sessions.filter((s) => s.status !== 'closed');
    if (openSessions.length === 0) return;
    const timer = setTimeout(() => {
      openSessions.forEach((sess) => {
        void recalculateSessionResults(account, sess, products, categories);
      });
    }, 350);
    return () => clearTimeout(timer);
  }, [
    account?.uid,
    isAdmin,
    sessions,
    transfers.length,
    deptReports.length,
    products.length,
    categories.length,
  ]);

  const categoryMap = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories]);

  const productMap = useMemo(() => {
    const m = new Map<string, { name: string; unit: string; categoryName: string }>();
    products.forEach((p) =>
      m.set(p.id, {
        name: p.name,
        unit: p.unit,
        categoryName: categoryMap.get(p.categoryId) || 'عام',
      })
    );
    return m;
  }, [products, categoryMap]);

  const filteredResults = useMemo(() => {
    return results.filter((r) => {
      const catOk = categoryFilter === 'all' || r.categoryId === categoryFilter;
      const searchOk = !productSearch.trim() || r.productName.includes(productSearch.trim());
      return catOk && searchOk;
    });
  }, [results, categoryFilter, productSearch]);

  const reportDef = ALL_REPORTS.find((r) => r.id === selectedReport) || ALL_REPORTS[0];

  const tableData = useMemo(
    () =>
      buildReportTable({
        reportId: selectedReport,
        results: filteredResults,
        transfers,
        productionEntries: prodEntries,
        reports: deptReports,
        sessions,
        productMap,
      }),
    [selectedReport, filteredResults, transfers, prodEntries, deptReports, sessions, productMap]
  );

  const dateLabel = fromDate === toDate ? fromDate : `${fromDate}_إلى_${toDate}`;

  return (
    <div className="space-y-6">
      <div className="bg-white border border-zinc-200 rounded-2xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 no-print">
        <div>
          <h2 className="text-xl font-bold text-zinc-900 font-display">التقارير الإدارية المعتمدة</h2>
          <p className="mt-1 text-sm text-zinc-500">
            12 تقريراً تشغيلياً وتحليلياً قابلة للتصفية والتصدير إلى Excel و PDF باللغة العربية
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => exportReportToExcel(reportDef.title, tableData, dateLabel)}
            className="min-h-[42px] inline-flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs font-bold text-emerald-800 hover:bg-emerald-100 cursor-pointer"
          >
            <FileSpreadsheet className="h-4 w-4" />
            <span>تصدير Excel</span>
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className="min-h-[42px] inline-flex items-center gap-2 rounded-xl bg-[#D91B23] px-4 py-2 text-xs font-bold text-white hover:bg-[#B9141B] cursor-pointer"
          >
            <Printer className="h-4 w-4" />
            <span>طباعة / PDF عربي</span>
          </button>
        </div>
      </div>

      {/* Report Selector Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2.5 no-print">
        {ALL_REPORTS.map((rep) => (
          <button
            key={rep.id}
            type="button"
            onClick={() => setSelectedReport(rep.id)}
            className={`text-right p-3 rounded-xl border text-xs transition-colors cursor-pointer ${
              selectedReport === rep.id
                ? 'bg-[#D91B23] text-white border-[#D91B23] font-bold'
                : 'bg-white text-zinc-700 border-zinc-200 hover:border-zinc-400 font-medium'
            }`}
          >
            <div className="truncate">{rep.title}</div>
          </button>
        ))}
      </div>

      {/* Filter Bar */}
      <div className="bg-white border border-zinc-200 rounded-2xl p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 no-print">
        <div>
          <label className="block text-[11px] font-semibold text-zinc-500 mb-1">من تاريخ</label>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="w-full min-h-[40px] rounded-xl border border-zinc-200 px-3 text-xs tabular-nums"
          />
        </div>
        <div>
          <label className="block text-[11px] font-semibold text-zinc-500 mb-1">إلى تاريخ</label>
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="w-full min-h-[40px] rounded-xl border border-zinc-200 px-3 text-xs tabular-nums"
          />
        </div>
        <div>
          <label className="block text-[11px] font-semibold text-zinc-500 mb-1">المجموعة</label>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="w-full min-h-[40px] rounded-xl border border-zinc-200 px-3 text-xs"
          >
            <option value="all">جميع المجموعات</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[11px] font-semibold text-zinc-500 mb-1">بحث بالصنف</label>
          <div className="relative">
            <Search className="h-3.5 w-3.5 text-zinc-400 absolute right-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={productSearch}
              onChange={(e) => setProductSearch(e.target.value)}
              placeholder="اسم الصنف..."
              className="w-full min-h-[40px] rounded-xl border border-zinc-200 pr-8 pl-3 text-xs"
            />
          </div>
        </div>
      </div>

      {/* Printable Report Sheet */}
      <div className="bg-white border border-zinc-200 rounded-2xl overflow-hidden">
        {/* Print-only Brand Header */}
        <div className="hidden print:flex items-center justify-between p-4 border-b border-zinc-300">
          <div className="flex items-center gap-3">
            <BrandLogo size="sm" />
            <div>
              <div className="font-bold text-base">{BRAND_NAME}</div>
              <div className="text-xs text-zinc-600">{reportDef.title}</div>
            </div>
          </div>
          <div className="text-xs text-zinc-600 tabular-nums">
            الفترة: {fromDate === toDate ? fromDate : `${fromDate} إلى ${toDate}`}
          </div>
        </div>

        <div className="px-5 py-4 border-b border-zinc-100 no-print">
          <h3 className="text-base font-bold text-zinc-900 font-display">{reportDef.title}</h3>
          <p className="text-xs text-zinc-500 mt-0.5">{reportDef.description}</p>
        </div>

        {tableData.rows.length === 0 ? (
          <div className="p-10 text-center text-sm text-zinc-500">
            لا توجد بيانات مطابقة للمعايير المحددة في هذا التقرير.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead className="bg-zinc-50 border-b border-zinc-200 text-zinc-600">
                <tr>
                  {tableData.columns.map((col) => (
                    <th key={col} className="px-3.5 py-3 font-bold whitespace-nowrap">
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {tableData.rows.map((row, idx) => (
                  <tr key={idx} className="hover:bg-zinc-50/70">
                    {row.map((cell, cIdx) => (
                      <td
                        key={cIdx}
                        className={`px-3.5 py-2.5 ${
                          typeof cell === 'number' ? 'tabular-nums font-semibold' : ''
                        }`}
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
