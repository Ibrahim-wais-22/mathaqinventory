import React from 'react';
import type { Product, UnitBreakdown } from '../../types/inventory';
import {
  formatBreakdownText,
  getEffectiveProductUnits,
  roundQty3,
  sumUnitCounts,
} from '../../utils/productUnits';

interface MultiUnitQtyInputProps {
  product: Pick<Product, 'id' | 'name' | 'unit' | 'categoryId' | 'units'>;
  counts: Record<string, string>;
  totalValue: string;
  onChange: (
    nextCounts: Record<string, string>,
    nextTotalStr: string,
    breakdown?: UnitBreakdown
  ) => void;
  disabled?: boolean;
  readOnly?: boolean;
  compact?: boolean;
  fullWidth?: boolean;
  tone?: 'default' | 'emerald';
  placeholder?: string;
}

export const MultiUnitQtyInput: React.FC<MultiUnitQtyInputProps> = ({
  product,
  counts,
  totalValue,
  onChange,
  disabled = false,
  readOnly = false,
  compact = false,
  fullWidth = false,
  tone = 'default',
  placeholder = '0',
}) => {
  const units = getEffectiveProductUnits(product);
  const isMulti = units.length > 1;

  const borderClass =
    tone === 'emerald'
      ? 'border-emerald-200 bg-emerald-50/30 focus:border-emerald-600'
      : 'border-zinc-200 bg-white focus:border-[#D91B23]';

  if (readOnly) {
    if (totalValue === '') {
      return (
        <span className="inline-block min-w-[48px] text-center font-semibold tabular-nums text-zinc-400">
          —
        </span>
      );
    }
    const { breakdown } = isMulti
      ? sumUnitCounts(units, counts)
      : { breakdown: undefined };
    const breakdownStr = formatBreakdownText(breakdown, units);
    return (
      <div className="inline-flex flex-col items-start">
        <span
          className={`font-bold tabular-nums ${
            tone === 'emerald' ? 'text-emerald-700' : 'text-zinc-800'
          }`}
        >
          {totalValue} {product.unit}
        </span>
        {isMulti && breakdownStr && (
          <span className="text-[11px] text-zinc-500 tabular-nums">{breakdownStr}</span>
        )}
      </div>
    );
  }

  // Single-unit mode
  if (!isMulti) {
    const baseName = units[0]?.name || product.unit;
    return (
      <input
        type="number"
        min="0"
        step="any"
        disabled={disabled}
        value={totalValue}
        onChange={(e) => {
          const val = e.target.value;
          if (val === '') {
            onChange({}, '', undefined);
            return;
          }
          const num = Number(val);
          const breakdown =
            Number.isFinite(num) && num > 0 ? { [baseName]: roundQty3(num) } : undefined;
          onChange({ [baseName]: val }, val, breakdown);
        }}
        placeholder={placeholder}
        className={`${
          fullWidth ? 'w-full min-h-[42px]' : compact ? 'w-24 min-h-[40px]' : 'w-32 min-h-[40px]'
        } rounded-xl border ${borderClass} px-2.5 text-center text-sm font-semibold tabular-nums focus:outline-none disabled:bg-zinc-100 disabled:text-zinc-500`}
      />
    );
  }

  // Multi-unit mode
  const handleUnitChange = (unitName: string, rawVal: string) => {
    const nextCounts = { ...counts, [unitName]: rawVal };
    if (rawVal === '') {
      delete nextCounts[unitName];
    }
    const { total, breakdown, hasInvalid } = sumUnitCounts(units, nextCounts);
    if (hasInvalid) {
      onChange(nextCounts, totalValue, undefined);
      return;
    }
    onChange(nextCounts, total === null ? '' : String(total), breakdown);
  };

  const hasEntered = totalValue !== '';

  if (compact) {
    return (
      <div className="space-y-1 min-w-[126px]">
        {units.map((u) => (
          <div key={u.name} className="flex items-center gap-1.5">
            <input
              type="number"
              min="0"
              step="any"
              disabled={disabled}
              value={counts[u.name] ?? ''}
              onChange={(e) => handleUnitChange(u.name, e.target.value)}
              placeholder="0"
              aria-label={`${product.name} - ${u.name}`}
              className={`w-16 min-h-[34px] rounded-lg border ${borderClass} px-1.5 text-center text-xs font-semibold tabular-nums focus:outline-none disabled:bg-zinc-100 disabled:text-zinc-500`}
            />
            <span className="text-[11px] font-medium text-zinc-600 truncate max-w-[58px]">
              {u.name}
            </span>
          </div>
        ))}
        {hasEntered && (
          <div
            className={`text-[10px] font-bold tabular-nums pt-0.5 ${
              tone === 'emerald' ? 'text-emerald-700' : 'text-zinc-500'
            }`}
          >
            = {totalValue} {product.unit}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {units.map((u) => (
          <label
            key={u.name}
            className={`inline-flex items-center gap-1.5 rounded-xl border px-2 py-1 ${
              disabled
                ? 'border-zinc-200 bg-zinc-100'
                : tone === 'emerald'
                ? 'border-emerald-200 bg-emerald-50/30'
                : 'border-zinc-200 bg-white focus-within:border-[#D91B23]'
            }`}
          >
            <input
              type="number"
              min="0"
              step="any"
              disabled={disabled}
              value={counts[u.name] ?? ''}
              onChange={(e) => handleUnitChange(u.name, e.target.value)}
              placeholder="0"
              aria-label={`${product.name} - ${u.name}`}
              className="w-14 min-h-[30px] bg-transparent text-center text-sm font-bold tabular-nums text-zinc-900 focus:outline-none disabled:text-zinc-500"
            />
            <span className="text-[11px] font-semibold text-zinc-600 whitespace-nowrap">
              {u.name}
            </span>
          </label>
        ))}
      </div>
      {hasEntered && (
        <div className="text-[11px] font-semibold text-zinc-500 tabular-nums">
          الإجمالي: <strong className="text-zinc-800">{totalValue}</strong> {product.unit}
        </div>
      )}
    </div>
  );
};
