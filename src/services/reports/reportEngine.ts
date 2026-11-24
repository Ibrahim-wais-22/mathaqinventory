import * as XLSX from 'xlsx';
import {
  DEPARTMENT_LABELS,
  REPORT_STATUS_LABELS,
  TRANSFER_STATUS_LABELS,
  VARIANCE_LABELS,
} from '../../constants/departments';
import type {
  DailySession,
  DepartmentReport,
  FactoryTransfer,
  ProductResult,
  ProductionEntry,
} from '../../types/inventory';
import { formatTimestampAden } from '../../utils/dateAden';
import { roundQty } from '../inventory/calculator';

export type ReportTypeId =
  | 'daily_detailed'
  | 'shortage_surplus'
  | 'product_movement'
  | 'factory_transfers'
  | 'delivery_discrepancies'
  | 'independent_production'
  | 'sales_by_product'
  | 'waste_report'
  | 'department_compliance'
  | 'recurring_shortages'
  | 'day_comparison'
  | 'matched_products';

export interface ReportDefinition {
  id: ReportTypeId;
  title: string;
  description: string;
}

export const ALL_REPORTS: ReportDefinition[] = [
  {
    id: 'daily_detailed',
    title: '1. تقرير الجرد اليومي التفصيلي',
    description: 'الحركة الكاملة لكل صنف من الرصيد الافتتاحي وحتى نتيجة الجرد النهائية.',
  },
  {
    id: 'shortage_surplus',
    title: '2. تقرير العجز والزيادة',
    description: 'الأصناف التي سُجّل فيها عجز أو زيادة خلال الفترة المحددة.',
  },
  {
    id: 'product_movement',
    title: '3. تقرير حركة كل صنف',
    description: 'تجميع تراكمي لحركة كل صنف عبر الأيام (الوارد، الإنتاج، المبيعات، الهدر).',
  },
  {
    id: 'factory_transfers',
    title: '4. تقرير توريدات المعمل',
    description: 'سجل توريدات المعمل المرسلة والمستلمة وحالاتها وتوقيتها.',
  },
  {
    id: 'delivery_discrepancies',
    title: '5. تقرير فروقات الاستلام',
    description: 'الفروقات المسجلة بين كميات المعمل المرسلة وكميات الإنتاج المستلمة فعلياً.',
  },
  {
    id: 'independent_production',
    title: '6. تقرير الإنتاج المستقل',
    description: 'الكميات المنتجة مباشرة في قسم الإنتاج دون توريد من المعمل.',
  },
  {
    id: 'sales_by_product',
    title: '7. تقرير المبيعات حسب الصنف',
    description: 'عدد الوحدات المباعة لكل صنف بدون قيم مالية.',
  },
  {
    id: 'waste_report',
    title: '8. تقرير الهدر',
    description: 'تفصيل التالف، المتبقي الصالح (المرحل لليوم التالي)، والمتبقي غير الصالح.',
  },
  {
    id: 'department_compliance',
    title: '9. تقرير أداء الإدارات والالتزام بالترحيل',
    description: 'حالة تقارير الإدارات الأربع والالتزام بالترحيل والاعتماد لكل يوم.',
  },
  {
    id: 'recurring_shortages',
    title: '10. تقرير الأصناف الأكثر تكراراً في العجز',
    description: 'ترتيب الأصناف حسب عدد مرات تكرار العجز وإجمالي كمية العجز.',
  },
  {
    id: 'day_comparison',
    title: '11. تقرير مقارنة الجرد بين الأيام',
    description: 'ملخص إجمالي المتاح والمبيعات والهدر والعجز والزيادة عبر الأيام.',
  },
  {
    id: 'matched_products',
    title: '12. تقرير مطابقة الأصناف',
    description: 'الأصناف التي حققت تطابقاً صفرياً دقيقاً (الفرق = 0).',
  },
];

export interface ReportTableData {
  columns: string[];
  rows: Array<Array<string | number>>;
}

export function buildReportTable(params: {
  reportId: ReportTypeId;
  results: ProductResult[];
  transfers: FactoryTransfer[];
  productionEntries: ProductionEntry[];
  reports: DepartmentReport[];
  sessions: DailySession[];
  productMap: Map<string, { name: string; unit: string; categoryName: string }>;
}): ReportTableData {
  const { reportId, results, transfers, productionEntries, reports, productMap } = params;

  switch (reportId) {
    case 'daily_detailed':
      return {
        columns: [
          'التاريخ',
          'الصنف',
          'المجموعة',
          'الوحدة',
          'أول اليوم',
          'توريد المعمل (صافي)',
          'مرتجع للمعمل',
          'إنتاج مستقل',
          'إجمالي المتاح',
          'المبيعات',
          'التالف',
          'متبقي صالح',
          'متبقي غير صالح',
          'النتيجة',
          'الفرق',
        ],
        rows: results.map((r) => [
          r.inventoryDate,
          r.productName,
          r.categoryName,
          r.unit,
          r.openingBalance,
          r.factoryReceivedQty,
          r.factoryReturnedQty ?? 0,
          r.independentProductionQty,
          r.totalAvailable,
          r.salesQty,
          r.damagedQty,
          r.validRemainingQty,
          r.invalidRemainingQty,
          VARIANCE_LABELS[r.varianceType],
          r.variance,
        ]),
      };

    case 'shortage_surplus': {
      const filtered = results.filter((r) => r.variance !== 0);
      return {
        columns: ['التاريخ', 'الصنف', 'المجموعة', 'إجمالي المتاح', 'المحسوب والمباع والمتبقي', 'الحالة', 'قيمة الفرق'],
        rows: filtered.map((r) => [
          r.inventoryDate,
          r.productName,
          r.categoryName,
          r.totalAvailable,
          roundQty(r.salesQty + r.damagedQty + r.validRemainingQty + r.invalidRemainingQty),
          VARIANCE_LABELS[r.varianceType],
          r.variance,
        ]),
      };
    }

    case 'product_movement': {
      const grouped = new Map<
        string,
        {
          name: string;
          categoryName: string;
          unit: string;
          received: number;
          returned: number;
          ind: number;
          sales: number;
          damaged: number;
          validRem: number;
          invalidRem: number;
          netVariance: number;
        }
      >();
      for (const r of results) {
        const cur = grouped.get(r.productId) || {
          name: r.productName,
          categoryName: r.categoryName,
          unit: r.unit,
          received: 0,
          returned: 0,
          ind: 0,
          sales: 0,
          damaged: 0,
          validRem: 0,
          invalidRem: 0,
          netVariance: 0,
        };
        cur.received = roundQty(cur.received + r.factoryReceivedQty);
        cur.returned = roundQty(cur.returned + (r.factoryReturnedQty ?? 0));
        cur.ind = roundQty(cur.ind + r.independentProductionQty);
        cur.sales = roundQty(cur.sales + r.salesQty);
        cur.damaged = roundQty(cur.damaged + r.damagedQty);
        cur.validRem = roundQty(cur.validRem + r.validRemainingQty);
        cur.invalidRem = roundQty(cur.invalidRem + r.invalidRemainingQty);
        cur.netVariance = roundQty(cur.netVariance + r.variance);
        grouped.set(r.productId, cur);
      }
      return {
        columns: ['الصنف', 'المجموعة', 'الوحدة', 'وارد المعمل (صافي)', 'مرتجع للمعمل', 'إنتاج مستقل', 'المبيعات', 'التالف', 'صالح', 'غير صالح', 'صافي الفرق'],
        rows: Array.from(grouped.values()).map((g) => [
          g.name,
          g.categoryName,
          g.unit,
          g.received,
          g.returned,
          g.ind,
          g.sales,
          g.damaged,
          g.validRem,
          g.invalidRem,
          g.netVariance,
        ]),
      };
    }

    case 'factory_transfers':
      return {
        columns: ['رقم الحركة', 'نوع الحركة', 'تاريخ الجرد', 'المسؤول', 'الكمية المرسلة / المرتجعة', 'الكمية المستلمة', 'فرق التسليم', 'الحالة', 'المستلم'],
        rows: transfers.map((t) => {
          const isReturn = t.transferType === 'return' || t.status === 'returned';
          return [
            t.transferNumber,
            isReturn ? 'مرتجع من الإنتاج للمعمل' : 'توريد من المعمل للإنتاج',
            t.inventoryDate,
            t.createdByName,
            isReturn ? -t.totalSentQty : t.totalSentQty,
            isReturn ? -t.totalReceivedQty : t.totalReceivedQty,
            t.totalVarianceQty,
            TRANSFER_STATUS_LABELS[t.status],
            t.receivedByName || '—',
          ];
        }),
      };

    case 'delivery_discrepancies': {
      const withDiff = transfers.filter(
        (t) =>
          t.transferType !== 'return' &&
          t.status !== 'returned' &&
          (t.totalVarianceQty !== 0 || t.status === 'discrepancy_logged')
      );
      return {
        columns: ['رقم التوريد', 'التاريخ', 'المرسل', 'المستلم', 'المُرسل (معمل)', 'المُستلم (إنتاج)', 'فرق التسليم', 'ملاحظة الإنتاج'],
        rows: withDiff.map((t) => [
          t.transferNumber,
          t.inventoryDate,
          t.createdByName,
          t.receivedByName || '—',
          t.totalSentQty,
          t.totalReceivedQty,
          t.totalVarianceQty,
          t.productionNote || '—',
        ]),
      };
    }

    case 'independent_production':
      return {
        columns: ['تاريخ الجرد', 'الصنف', 'المجموعة', 'الكمية المنتجة', 'الوحدة', 'المسجل', 'ملاحظة', 'وقت التسجيل'],
        rows: productionEntries.map((e) => {
          const p = productMap.get(e.productId);
          return [
            e.inventoryDate,
            p?.name || e.productId,
            p?.categoryName || '—',
            e.qty,
            p?.unit || 'وحدة',
            e.createdByName,
            e.note || '—',
            formatTimestampAden(e.createdAt),
          ];
        }),
      };

    case 'sales_by_product': {
      const grouped = new Map<string, { name: string; categoryName: string; unit: string; qty: number }>();
      for (const r of results) {
        const cur = grouped.get(r.productId) || {
          name: r.productName,
          categoryName: r.categoryName,
          unit: r.unit,
          qty: 0,
        };
        cur.qty = roundQty(cur.qty + r.salesQty);
        grouped.set(r.productId, cur);
      }
      return {
        columns: ['الصنف', 'المجموعة', 'الوحدة', 'إجمالي الوحدات المباعة'],
        rows: Array.from(grouped.values())
          .sort((a, b) => b.qty - a.qty)
          .map((g) => [g.name, g.categoryName, g.unit, g.qty]),
      };
    }

    case 'waste_report':
      return {
        columns: ['التاريخ', 'الصنف', 'المجموعة', 'الوحدة', 'التالف', 'المتبقي الصالح', 'المتبقي غير الصالح', 'إجمالي الفاقد (تالف + غير صالح)'],
        rows: results.map((r) => [
          r.inventoryDate,
          r.productName,
          r.categoryName,
          r.unit,
          r.damagedQty,
          r.validRemainingQty,
          r.invalidRemainingQty,
          roundQty(r.damagedQty + r.invalidRemainingQty),
        ]),
      };

    case 'department_compliance':
      return {
        columns: ['تاريخ الجرد', 'الإدارة', 'حالة التقرير', 'عدد الأصناف المدخلة', 'المرحل', 'المعتمد'],
        rows: reports.map((rep) => [
          rep.inventoryDate,
          DEPARTMENT_LABELS[rep.department],
          REPORT_STATUS_LABELS[rep.status],
          rep.itemCount,
          rep.submittedByName || '—',
          rep.approvedByName || '—',
        ]),
      };

    case 'recurring_shortages': {
      const counts = new Map<string, { name: string; categoryName: string; occurrences: number; totalDeficit: number }>();
      for (const r of results) {
        if (r.variance > 0) {
          const cur = counts.get(r.productId) || {
            name: r.productName,
            categoryName: r.categoryName,
            occurrences: 0,
            totalDeficit: 0,
          };
          cur.occurrences += 1;
          cur.totalDeficit = roundQty(cur.totalDeficit + r.variance);
          counts.set(r.productId, cur);
        }
      }
      return {
        columns: ['الصنف', 'المجموعة', 'عدد مرات العجز', 'إجمالي كمية العجز'],
        rows: Array.from(counts.values())
          .sort((a, b) => b.occurrences - a.occurrences || b.totalDeficit - a.totalDeficit)
          .map((c) => [c.name, c.categoryName, c.occurrences, c.totalDeficit]),
      };
    }

    case 'day_comparison': {
      const byDay = new Map<
        string,
        {
          date: string;
          available: number;
          sales: number;
          damaged: number;
          validRem: number;
          invalidRem: number;
          netVariance: number;
        }
      >();
      for (const r of results) {
        const cur = byDay.get(r.inventoryDate) || {
          date: r.inventoryDate,
          available: 0,
          sales: 0,
          damaged: 0,
          validRem: 0,
          invalidRem: 0,
          netVariance: 0,
        };
        cur.available = roundQty(cur.available + r.totalAvailable);
        cur.sales = roundQty(cur.sales + r.salesQty);
        cur.damaged = roundQty(cur.damaged + r.damagedQty);
        cur.validRem = roundQty(cur.validRem + r.validRemainingQty);
        cur.invalidRem = roundQty(cur.invalidRem + r.invalidRemainingQty);
        cur.netVariance = roundQty(cur.netVariance + r.variance);
        byDay.set(r.inventoryDate, cur);
      }
      return {
        columns: ['التاريخ', 'إجمالي المتاح', 'المبيعات', 'التالف', 'المتبقي الصالح', 'غير الصالح', 'صافي الفرق'],
        rows: Array.from(byDay.values())
          .sort((a, b) => b.date.localeCompare(a.date))
          .map((d) => [d.date, d.available, d.sales, d.damaged, d.validRem, d.invalidRem, d.netVariance]),
      };
    }

    case 'matched_products': {
      const matched = results.filter((r) => r.variance === 0);
      return {
        columns: ['التاريخ', 'الصنف', 'المجموعة', 'إجمالي المتاح', 'المبيعات', 'المتبقي الصالح', 'الحالة'],
        rows: matched.map((r) => [
          r.inventoryDate,
          r.productName,
          r.categoryName,
          r.totalAvailable,
          r.salesQty,
          r.validRemainingQty,
          'مطابق 100%',
        ]),
      };
    }
  }
}

export function exportReportToExcel(title: string, table: ReportTableData, dateLabel: string): void {
  const wsData = [
    ['شركة مطاعم المذاق اليمني — نظام متابعة الجرد اليومي'],
    [title, `الفترة / التاريخ: ${dateLabel}`],
    [],
    table.columns,
    ...table.rows,
  ];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!views'] = [{ rightToLeft: true }];
  ws['!cols'] = table.columns.map(() => ({ wch: 18 }));

  XLSX.utils.book_append_sheet(wb, ws, 'التقرير');
  const safeFile = `${title.replace(/[^\u0600-\u06FFa-zA-Z0-9_-]/g, '_')}_${dateLabel}.xlsx`;
  XLSX.writeFile(wb, safeFile);
}
