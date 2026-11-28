import type { Product, ProductUnitOption, UnitBreakdown } from '../types/inventory';

export const DEFAULT_CHICKEN_UNITS: ProductUnitOption[] = [
  { name: 'حبة', factor: 1 },
  { name: 'نص', factor: 0.5 },
  { name: 'ربع', factor: 0.25 },
];

export const DEFAULT_MEAT_UNITS: ProductUnitOption[] = [
  { name: 'نفر', factor: 1 },
  { name: 'نص نفر', factor: 0.5 },
  { name: 'ربع نفر', factor: 0.25 },
];

export const DEFAULT_CARCASS_UNITS: ProductUnitOption[] = [
  { name: 'ذبيحة', factor: 1 },
  { name: 'نص ذبيحة', factor: 0.5 },
  { name: 'ربع ذبيحة', factor: 0.25 },
  { name: 'نفر', factor: 0.0625 },
];

export function roundQty3(val: number): number {
  return Math.round(val * 10000) / 10000;
}

export function roundFactor4(val: number): number {
  return Math.round(val * 10000) / 10000;
}

export function buildHalvesAndQuartersPreset(baseUnit: string): ProductUnitOption[] {
  const clean = baseUnit.trim().slice(0, 40) || 'حبة';
  if (clean === 'حبة') {
    return DEFAULT_CHICKEN_UNITS.map((u) => ({ ...u }));
  }
  if (clean === 'نفر') {
    return DEFAULT_MEAT_UNITS.map((u) => ({ ...u }));
  }
  if (clean === 'ذبيحة' || clean === 'ذبيحه') {
    return DEFAULT_CARCASS_UNITS.map((u) => ({
      ...u,
      name: u.name === 'ذبيحة' ? clean : u.name,
    }));
  }
  return [
    { name: clean, factor: 1 },
    { name: `نص ${clean}`.slice(0, 40), factor: 0.5 },
    { name: `ربع ${clean}`.slice(0, 40), factor: 0.25 },
  ];
}

export function getDefaultUnitsForProduct(
  unit: string,
  categoryId?: string
): ProductUnitOption[] {
  const cleanUnit = (unit || '').trim().slice(0, 40) || 'وحدة';
  if (
    categoryId === 'cat_chicken' ||
    categoryId === 'cat_meats' ||
    cleanUnit === 'حبة' ||
    cleanUnit === 'نفر' ||
    cleanUnit === 'ذبيحة' ||
    cleanUnit === 'ذبيحه'
  ) {
    return buildHalvesAndQuartersPreset(cleanUnit);
  }
  return [{ name: cleanUnit, factor: 1 }];
}

export function buildNormalizedProductUnits(
  baseUnitName: string,
  candidateUnits?: ProductUnitOption[] | null
): ProductUnitOption[] {
  const cleanBase = baseUnitName.trim().slice(0, 40) || 'وحدة';
  const result: ProductUnitOption[] = [{ name: cleanBase, factor: 1 }];
  const seenNames = new Set<string>([cleanBase.toLowerCase()]);

  if (Array.isArray(candidateUnits)) {
    for (const raw of candidateUnits) {
      if (result.length >= 10) break;
      const name = typeof raw?.name === 'string' ? raw.name.trim().slice(0, 40) : '';
      const factor = typeof raw?.factor === 'number' ? raw.factor : Number(raw?.factor);
      if (!name || !Number.isFinite(factor) || factor <= 0 || factor > 10000) {
        continue;
      }
      const lower = name.toLowerCase();
      if (seenNames.has(lower)) {
        continue;
      }
      seenNames.add(lower);
      result.push({ name, factor: roundFactor4(factor) });
    }
  }

  return result;
}

export function getEffectiveProductUnits(
  product?: Pick<Product, 'unit' | 'categoryId' | 'units'> | null
): ProductUnitOption[] {
  if (!product) return [{ name: 'وحدة', factor: 1 }];
  if (Array.isArray(product.units) && product.units.length > 0) {
    return buildNormalizedProductUnits(product.unit, product.units);
  }
  return getDefaultUnitsForProduct(product.unit, product.categoryId);
}

export function sanitizeUnitBreakdown(
  raw?: Record<string, unknown> | null
): UnitBreakdown | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const clean: UnitBreakdown = {};
  let count = 0;
  for (const [key, val] of Object.entries(raw)) {
    if (count >= 10) break;
    const cleanKey = key.trim().slice(0, 40);
    const num = typeof val === 'number' ? val : Number(val);
    if (!cleanKey || !Number.isFinite(num) || num < 0 || num > 1000000) continue;
    const rounded = roundQty3(num);
    if (rounded > 0) {
      clean[cleanKey] = rounded;
      count++;
    }
  }
  return count > 0 ? clean : undefined;
}

export function sumUnitCounts(
  units: ProductUnitOption[],
  counts: Record<string, string>
): { total: number | null; breakdown?: UnitBreakdown; hasInvalid: boolean } {
  let hasAnyEntered = false;
  let total = 0;
  const breakdown: UnitBreakdown = {};

  for (const unit of units) {
    const raw = counts[unit.name];
    if (raw === undefined || raw.trim() === '') continue;
    hasAnyEntered = true;
    const num = Number(raw);
    if (!Number.isFinite(num) || num < 0 || num > 1000000) {
      return { total: null, breakdown: undefined, hasInvalid: true };
    }
    const roundedCount = roundQty3(num);
    if (roundedCount > 0) {
      breakdown[unit.name] = roundedCount;
      total += roundedCount * unit.factor;
    }
  }

  if (!hasAnyEntered) {
    return { total: null, breakdown: undefined, hasInvalid: false };
  }

  return {
    total: roundQty3(total),
    breakdown: Object.keys(breakdown).length > 0 ? breakdown : undefined,
    hasInvalid: false,
  };
}

export function decomposeTotalToUnitCounts(
  total: number | null | undefined,
  units: ProductUnitOption[],
  savedBreakdown?: UnitBreakdown | null
): Record<string, string> {
  if (total === null || total === undefined || !Number.isFinite(total)) {
    return {};
  }

  const safeTotal = Math.max(0, roundQty3(total));
  const counts: Record<string, string> = {};

  // Check if savedBreakdown accurately represents safeTotal
  if (savedBreakdown && typeof savedBreakdown === 'object') {
    let breakdownSum = 0;
    let validEntries = 0;
    for (const unit of units) {
      const q = savedBreakdown[unit.name];
      if (typeof q === 'number' && Number.isFinite(q) && q >= 0) {
        breakdownSum += q * unit.factor;
        if (q > 0) {
          counts[unit.name] = String(roundQty3(q));
          validEntries++;
        }
      }
    }
    if (validEntries > 0 && Math.abs(roundQty3(breakdownSum) - safeTotal) <= 0.002) {
      return counts;
    }
  }

  // Explicitly entered zero
  if (safeTotal === 0) {
    if (units[0]) {
      counts[units[0].name] = '0';
    }
    return counts;
  }

  // Greedy decomposition from largest factor to smallest
  const sorted = [...units].sort((a, b) => b.factor - a.factor);
  let remaining = safeTotal;
  const freshCounts: Record<string, string> = {};

  for (let i = 0; i < sorted.length; i++) {
    const unit = sorted[i];
    if (unit.factor <= 0) continue;
    if (i === sorted.length - 1) {
      const remQty = roundQty3(remaining / unit.factor);
      if (remQty > 0) {
        freshCounts[unit.name] = String(remQty);
      }
      remaining = 0;
    } else {
      const whole = Math.floor((remaining + 1e-9) / unit.factor);
      if (whole > 0) {
        freshCounts[unit.name] = String(whole);
        remaining = roundQty3(remaining - whole * unit.factor);
      }
    }
  }

  return freshCounts;
}

export function formatUnitsSummary(units: ProductUnitOption[]): string {
  return units
    .map((u) => (u.factor === 1 ? u.name : `${u.name} (${u.factor})`))
    .join(' · ');
}

export function formatBreakdownText(
  breakdown?: UnitBreakdown | null,
  units?: ProductUnitOption[]
): string {
  if (!breakdown) return '';
  const orderedNames = units ? units.map((u) => u.name) : Object.keys(breakdown);
  const parts: string[] = [];
  const used = new Set<string>();

  for (const name of orderedNames) {
    const qty = breakdown[name];
    if (typeof qty === 'number' && qty > 0) {
      parts.push(`${roundQty3(qty)} ${name}`);
      used.add(name);
    }
  }
  for (const [name, qty] of Object.entries(breakdown)) {
    if (!used.has(name) && typeof qty === 'number' && qty > 0) {
      parts.push(`${roundQty3(qty)} ${name}`);
    }
  }
  return parts.join(' + ');
}
