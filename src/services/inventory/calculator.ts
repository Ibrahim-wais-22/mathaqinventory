import type {
  DailySession,
  DepartmentReport,
  FactoryTransfer,
  VarianceType,
} from '../../types/inventory';

export interface ProductInventoryInputs {
  openingBalance: number;
  factorySentQty: number;
  factoryReceivedQty: number;
  factoryReturnedQty?: number;
  independentProductionQty: number;
  salesQty: number;
  damagedQty: number;
  validRemainingQty: number;
  invalidRemainingQty: number;
}

export interface ProductInventoryCalculation extends ProductInventoryInputs {
  factoryReturnedQty: number;
  deliveryVarianceQty: number;
  totalProduction: number;
  totalAvailable: number;
  variance: number;
  varianceType: VarianceType;
}

/**
 * Centralized, deterministic inventory calculation engine.
 * Equations (PRD Section 6 + Same-Day Factory Returns):
 * 1. factorySentQty = max(0, grossFactorySent - factoryReturnedQty)
 * 2. factoryReceivedQty = max(0, grossFactoryReceived - factoryReturnedQty)
 * 3. totalProduction = factoryReceivedQty + independentProductionQty
 * 4. totalAvailable = max(0, openingBalance + totalProduction - max(0, factoryReturnedQty - grossFactoryReceived))
 * 5. variance = totalAvailable - salesQty - damagedQty - validRemainingQty - invalidRemainingQty
 *    - variance === 0 => matched
 *    - variance > 0   => deficit (عجز)
 *    - variance < 0   => surplus (زيادة)
 * 6. deliveryVarianceQty = grossFactorySent - grossFactoryReceived (tracked separately)
 */
export function calculateProductInventory(
  input: ProductInventoryInputs
): ProductInventoryCalculation {
  const openingBalance = safeNum(input.openingBalance);
  const grossFactorySentQty = safeNum(input.factorySentQty);
  const grossFactoryReceivedQty = safeNum(input.factoryReceivedQty);
  const factoryReturnedQty = safeNum(input.factoryReturnedQty);
  const independentProductionQty = safeNum(input.independentProductionQty);
  const salesQty = safeNum(input.salesQty);
  const damagedQty = safeNum(input.damagedQty);
  const validRemainingQty = safeNum(input.validRemainingQty);
  const invalidRemainingQty = safeNum(input.invalidRemainingQty);

  const factorySentQty = Math.max(0, roundQty(grossFactorySentQty - factoryReturnedQty));
  const factoryReceivedQty = Math.max(0, roundQty(grossFactoryReceivedQty - factoryReturnedQty));
  const deliveryVarianceQty = roundQty(grossFactorySentQty - grossFactoryReceivedQty);
  const unabsorbedReturn = Math.max(0, roundQty(factoryReturnedQty - grossFactoryReceivedQty));
  const totalProduction = roundQty(factoryReceivedQty + independentProductionQty);
  const totalAvailable = Math.max(
    0,
    roundQty(openingBalance + totalProduction - unabsorbedReturn)
  );
  const variance = roundQty(
    totalAvailable - salesQty - damagedQty - validRemainingQty - invalidRemainingQty
  );

  let varianceType: VarianceType = 'matched';
  if (variance > 0) {
    varianceType = 'deficit';
  } else if (variance < 0) {
    varianceType = 'surplus';
  }

  return {
    openingBalance,
    factorySentQty,
    factoryReceivedQty,
    factoryReturnedQty,
    deliveryVarianceQty,
    independentProductionQty,
    totalProduction,
    totalAvailable,
    salesQty,
    damagedQty,
    validRemainingQty,
    invalidRemainingQty,
    variance,
    varianceType,
  };
}

export function safeNum(val: unknown): number {
  if (typeof val !== 'number' || Number.isNaN(val) || !Number.isFinite(val)) return 0;
  return val < 0 ? 0 : roundQty(val);
}

export function roundQty(val: number): number {
  return Math.round(val * 1000) / 1000;
}

export function sanitizeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
}

export interface SessionReadiness {
  canClose: boolean;
  blockers: string[];
}

/**
 * Verifies all PRD Section 8 closing preconditions:
 * - Session must currently be open or reopened
 * - All factory transfers for the day must be received/settled (none pending_receipt)
 * - Sales & Waste reports must be submitted/approved
 * - Production report (or entries) and Factory report checked
 */
export function checkSessionClosingReadiness(
  session: DailySession | null,
  reports: DepartmentReport[],
  transfers: FactoryTransfer[]
): SessionReadiness {
  const blockers: string[] = [];

  if (!session) {
    return { canClose: false, blockers: ['لا توجد جلسة جرد نشطة لهذا اليوم.'] };
  }
  if (session.status === 'closed') {
    return { canClose: false, blockers: ['يوم الجرد مغلق بالفعل.'] };
  }

  const pendingTransfers = transfers.filter((t) => t.status === 'pending_receipt');
  if (pendingTransfers.length > 0) {
    blockers.push(`يوجد ${pendingTransfers.length} توريد من المعمل بانتظار تأكيد استلام الإنتاج.`);
  }

  const requiredDepts: Array<{ dept: DepartmentReport['department']; label: string }> = [
    { dept: 'sales', label: 'تقرير المبيعات' },
    { dept: 'waste', label: 'تقرير الهدر والمتبقي' },
  ];

  for (const { dept, label } of requiredDepts) {
    const rep = reports.find((r) => r.department === dept);
    if (!rep || rep.status === 'draft') {
      blockers.push(`لم يتم ترحيل ${label} بعد.`);
    }
  }

  const factoryRep = reports.find((r) => r.department === 'factory');
  if (factoryRep && factoryRep.status === 'draft' && factoryRep.itemCount > 0) {
    blockers.push('تقرير المعمل ما زال في حالة مسودة ولم يتم ترحيله.');
  }

  const prodRep = reports.find((r) => r.department === 'production');
  if (prodRep && prodRep.status === 'draft' && prodRep.itemCount > 0) {
    blockers.push('تقرير الإنتاج المستقل ما زال في حالة مسودة ولم يتم ترحيله.');
  }

  return {
    canClose: blockers.length === 0,
    blockers,
  };
}
