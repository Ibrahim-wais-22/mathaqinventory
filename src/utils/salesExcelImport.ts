import * as XLSX from 'xlsx';
import type { Product, ProductUnitOption, UnitBreakdown } from '../types/inventory';
import {
  decomposeTotalToUnitCounts,
  getEffectiveProductUnits,
  roundQty3,
} from './productUnits';

export type ExcelMatchReason =
  | 'exact'
  | 'normalized'
  | 'reordered'
  | 'unit_variant'
  | 'subset'
  | 'fuzzy'
  | 'manual';

export interface ParsedExcelSheet {
  name: string;
  rows: unknown[][];
}

export interface ParsedExcelWorkbook {
  fileName: string;
  sheets: ParsedExcelSheet[];
  defaultSheetName: string;
}

export interface MatchedExcelItem {
  rowKey: string;
  product: Product;
  effectiveUnits: ProductUnitOption[];
  excelNames: string[];
  sourceRowNumbers: number[];
  extractedQty: number;
  unitBreakdown?: UnitBreakdown;
  counts: Record<string, string>;
  matchReason: ExcelMatchReason;
  matchedUnitLabel?: string;
}

export interface UnrecognizedExcelItem {
  rowKey: string;
  excelName: string;
  normalizedName: string;
  sourceRowNumbers: number[];
  extractedQty: number;
  manualProductId?: string;
}

export interface IgnoredExcelRow {
  rowNumber: number;
  rawName: string;
  rawQty: string;
  reason: string;
}

export interface ColumnDetectionResult {
  headerRowIndex: number; // -1 if no explicit header row found
  nameCol: number;
  qtyCol: number;
  headers: string[];
  autoDetected: boolean;
}

export interface ExcelImportAnalysis {
  sheetName: string;
  detection: ColumnDetectionResult;
  matched: MatchedExcelItem[];
  unrecognized: UnrecognizedExcelItem[];
  ignoredRows: IgnoredExcelRow[];
  totalMatchedQty: number;
}

const MAX_SCAN_HEADER_ROWS = 30;
const MAX_COL_CHECK = 30;

const ARABIC_INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

export function convertToAsciiDigits(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const arIdx = ARABIC_INDIC_DIGITS.indexOf(ch);
    if (arIdx !== -1) {
      out += String(arIdx);
      continue;
    }
    const faIdx = PERSIAN_DIGITS.indexOf(ch);
    if (faIdx !== -1) {
      out += String(faIdx);
      continue;
    }
    out += ch;
  }
  return out;
}

export function normalizeArabicText(raw: string): string {
  if (!raw) return '';
  let text = convertToAsciiDigits(String(raw));
  // Remove Arabic diacritics (tashkeel) and tatweel
  text = text.replace(/[\u064B-\u065F\u0670\u0640]/g, '');
  // Unify Alef forms (أ إ آ ٱ -> ا)
  text = text.replace(/[أإآٱ]/g, 'ا');
  // Unify Teh Marbuta (ة -> ه)
  text = text.replace(/ة/g, 'ه');
  // Unify Alef Maksura (ى -> ي)
  text = text.replace(/ى/g, 'ي');
  // Replace common punctuation/separators with spaces
  text = text.replace(/[\-_/\\()[\]{}،,;:.+*|]+/g, ' ');
  // Lowercase Latin characters & collapse whitespace
  text = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return text;
}

function stripAlPrefixFromToken(token: string): string {
  if (token.length > 3 && token.startsWith('ال')) {
    return token.slice(2);
  }
  if (token.length > 4 && (token.startsWith('وال') || token.startsWith('بال') || token.startsWith('كال'))) {
    return token.slice(0, 1) + token.slice(3);
  }
  return token;
}

function tokenizeNormalized(normText: string, stripAl = false): string[] {
  if (!normText) return [];
  const parts = normText.split(' ').filter(Boolean);
  return stripAl ? parts.map(stripAlPrefixFromToken) : parts;
}

function sortedTokensKey(tokens: string[]): string {
  return [...tokens].sort().join(' ');
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

function stringSimilarity(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

export function parseArabicNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  let raw = convertToAsciiDigits(String(value)).trim();
  if (!raw) return null;

  // Reject date-like strings (e.g. 2026-11-23 or 23/11/2026)
  if (/^\d{1,4}[-/]\d{1,2}[-/]\d{1,4}$/.test(raw)) return null;

  // Normalize Arabic decimal/thousands marks
  raw = raw.replace(/\u066B/g, '.').replace(/\u066C/g, ',');

  // Remove harmless trailing unit/currency text if preceded by a pure number
  // e.g. "12.5 حبة" or "10 qty" -> keep numeric prefix only if there isn't another number inside
  const unitCleaned = raw
    .replace(/(حبه|حبة|نفر|صحن|علبه|علبة|برام|كيلو|وحدة|وحده|قطعه|قطعة|pcs|unit|units|qty)/gi, '')
    .trim();
  if (unitCleaned) raw = unitCleaned;

  // Handle parentheses negative like (5)
  const parenNeg = raw.match(/^\((.+)\)$/);
  if (parenNeg) {
    raw = `-${parenNeg[1].trim()}`;
  }

  // Handle thousand separators vs decimal commas
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(raw)) {
    raw = raw.replace(/,/g, '');
  } else if (/^-?\d+,\d{1,3}$/.test(raw) && !raw.includes('.')) {
    raw = raw.replace(',', '.');
  } else {
    raw = raw.replace(/,/g, '');
  }

  // Must now be a clean numeric string
  if (!/^-?\d+(\.\d+)?$/.test(raw)) return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

const NAME_HEADER_EXACT = new Map<string, number>([
  ['اسم الصنف', 100],
  ['الصنف', 95],
  ['اسم الماده', 95],
  ['الماده', 90],
  ['اسم المنتج', 95],
  ['المنتج', 90],
  ['البيان', 88],
  ['الصنف البيان', 85],
  ['البند', 82],
  ['الوصف', 78],
  ['الطبق', 78],
  ['الوجبه', 75],
  ['اسم الطلب', 75],
  ['التفاصيل', 70],
  ['item name', 100],
  ['product name', 98],
  ['item', 92],
  ['product', 90],
  ['description', 82],
  ['name', 80],
  ['dish', 76],
  ['article', 76],
]);

const QTY_HEADER_EXACT = new Map<string, number>([
  ['الكميه المباعه', 100],
  ['كميه المبيعات', 98],
  ['الكميه', 96],
  ['عدد الوحدات', 96],
  ['العدد المباع', 96],
  ['العدد', 92],
  ['المباع', 88],
  ['كميه', 86],
  ['عدد', 84],
  ['مباع', 80],
  ['صافي الكميه', 94],
  ['اجمالي الكميه', 94],
  ['مجموع الكميه', 92],
  ['sold qty', 100],
  ['sold quantity', 100],
  ['quantity', 96],
  ['qty', 94],
  ['units sold', 94],
  ['units', 84],
  ['count', 82],
  ['sold', 78],
]);

const NON_QTY_PENALTY_KEYWORDS = [
  'سعر',
  'مبلغ',
  'قيمه',
  'تكلفه',
  'ضريب',
  'خصم',
  'ربح',
  'نقد',
  'شبكه',
  'بطاقه',
  'كود',
  'رقم',
  'باركود',
  'تسلسل',
  'تاريخ',
  'وقت',
  'price',
  'amount',
  'cost',
  'vat',
  'tax',
  'discount',
  'revenue',
  'sales value',
  'code',
  'barcode',
  'sku',
  'id',
  'date',
  'time',
];

const SUMMARY_ROW_KEYWORDS = new Set([
  'الاجمالي',
  'اجمالي',
  'المجموع',
  'مجموع',
  'اجمالي المبيعات',
  'المجموع الكلي',
  'الاجمالي الكلي',
  'صافي المبيعات',
  'الصافي',
  'الضريبه',
  'ضريبه القيمه المضافه',
  'الخصم',
  'المتوسط',
  'عدد الاصناف',
  'total',
  'grand total',
  'subtotal',
  'sub total',
  'sum',
  'net total',
  'tax',
  'vat',
  'discount',
  'summary',
]);

function scoreNameHeader(normHeader: string): number {
  if (!normHeader) return 0;
  const direct = NAME_HEADER_EXACT.get(normHeader);
  if (direct) return direct;
  let best = 0;
  for (const [kw, score] of NAME_HEADER_EXACT.entries()) {
    if (normHeader.includes(kw)) {
      best = Math.max(best, score - 12);
    }
  }
  if (
    normHeader.includes('سعر') ||
    normHeader.includes('كميه') ||
    normHeader.includes('العدد') ||
    normHeader.includes('اجمالي') ||
    normHeader.includes('مجموع') ||
    normHeader.includes('ملاحظ')
  ) {
    best = Math.max(0, best - 45);
  }
  return best;
}

function scoreQtyHeader(normHeader: string): number {
  if (!normHeader) return 0;
  const direct = QTY_HEADER_EXACT.get(normHeader);
  if (direct) return direct;

  for (const bad of NON_QTY_PENALTY_KEYWORDS) {
    if (normHeader.includes(bad)) {
      return 0;
    }
  }

  let best = 0;
  for (const [kw, score] of QTY_HEADER_EXACT.entries()) {
    if (normHeader.includes(kw)) {
      best = Math.max(best, score - 10);
    }
  }
  return best;
}

function isSummaryOrHeaderRow(normName: string, headerNameNorms: string[]): boolean {
  if (!normName) return true;
  if (SUMMARY_ROW_KEYWORDS.has(normName)) return true;
  for (const kw of SUMMARY_ROW_KEYWORDS) {
    if (normName === kw || normName.startsWith(`${kw} `) || normName.endsWith(` ${kw}`)) {
      return true;
    }
  }
  if (headerNameNorms.includes(normName)) return true;
  return false;
}

export function detectColumns(rows: unknown[][]): ColumnDetectionResult {
  const maxRow = Math.min(rows.length, MAX_SCAN_HEADER_ROWS);
  let bestPair: {
    rowIndex: number;
    nameCol: number;
    qtyCol: number;
    score: number;
    headers: string[];
  } | null = null;

  for (let r = 0; r < maxRow; r++) {
    const row = rows[r] || [];
    const colCount = Math.min(row.length, MAX_COL_CHECK);
    if (colCount < 2) continue;

    const normCells: string[] = [];
    const rawHeaders: string[] = [];
    for (let c = 0; c < colCount; c++) {
      const rawText = String(row[c] ?? '').trim();
      rawHeaders.push(rawText || `عمود ${c + 1}`);
      normCells.push(normalizeArabicText(rawText));
    }

    let bestNameCol = -1;
    let bestNameScore = 0;
    for (let c = 0; c < colCount; c++) {
      const s = scoreNameHeader(normCells[c]);
      if (s > bestNameScore) {
        bestNameScore = s;
        bestNameCol = c;
      }
    }

    let bestQtyCol = -1;
    let bestQtyScore = 0;
    for (let c = 0; c < colCount; c++) {
      if (c === bestNameCol) continue;
      const s = scoreQtyHeader(normCells[c]);
      if (s > bestQtyScore) {
        bestQtyScore = s;
        bestQtyCol = c;
      }
    }

    if (bestNameCol !== -1 && bestQtyCol !== -1 && bestNameScore >= 55 && bestQtyScore >= 55) {
      const totalScore = bestNameScore + bestQtyScore;
      if (!bestPair || totalScore > bestPair.score) {
        bestPair = {
          rowIndex: r,
          nameCol: bestNameCol,
          qtyCol: bestQtyCol,
          score: totalScore,
          headers: rawHeaders,
        };
      }
    }
  }

  if (bestPair) {
    return {
      headerRowIndex: bestPair.rowIndex,
      nameCol: bestPair.nameCol,
      qtyCol: bestPair.qtyCol,
      headers: bestPair.headers,
      autoDetected: true,
    };
  }

  // Fallback for headerless sheets: inspect column value types
  const maxCols = Math.min(
    MAX_COL_CHECK,
    rows.slice(0, 40).reduce((mx, r) => Math.max(mx, r?.length || 0), 0)
  );
  const textCounts = new Array<number>(maxCols).fill(0);
  const numCounts = new Array<number>(maxCols).fill(0);
  const sampleLimit = Math.min(rows.length, 60);

  for (let r = 0; r < sampleLimit; r++) {
    const row = rows[r] || [];
    for (let c = 0; c < maxCols; c++) {
      const val = row[c];
      const str = String(val ?? '').trim();
      if (!str) continue;
      const parsed = parseArabicNumber(val);
      if (parsed !== null) {
        numCounts[c]++;
      } else if (/[\u0600-\u06FFa-zA-Z]{2,}/.test(str)) {
        textCounts[c]++;
      }
    }
  }

  let fallbackNameCol = 0;
  let maxText = -1;
  for (let c = 0; c < maxCols; c++) {
    if (textCounts[c] > maxText) {
      maxText = textCounts[c];
      fallbackNameCol = c;
    }
  }

  let fallbackQtyCol = fallbackNameCol === 0 ? 1 : 0;
  let maxNum = -1;
  for (let c = 0; c < maxCols; c++) {
    if (c === fallbackNameCol) continue;
    if (numCounts[c] > maxNum) {
      maxNum = numCounts[c];
      fallbackQtyCol = c;
    }
  }

  const headers = Array.from({ length: Math.max(maxCols, 2) }, (_, c) => {
    const firstVal = String(rows[0]?.[c] ?? '').trim();
    return firstVal ? `${firstVal} (عمود ${c + 1})` : `عمود ${c + 1}`;
  });

  return {
    headerRowIndex: -1,
    nameCol: fallbackNameCol,
    qtyCol: Math.min(fallbackQtyCol, Math.max(maxCols - 1, 1)),
    headers,
    autoDetected: false,
  };
}

interface IndexedProduct {
  product: Product;
  effectiveUnits: ProductUnitOption[];
  normName: string;
  tokens: string[];
  noAlTokens: string[];
  sortedKey: string;
  sortedNoAlKey: string;
  unitMatchers: Array<{ normUnit: string; option: ProductUnitOption }>;
}

const GENERIC_UNIT_ALIASES: Array<{ normAlias: string; factor: number; preferName?: string }> = [
  { normAlias: 'نص نفر', factor: 0.5 },
  { normAlias: 'نصف نفر', factor: 0.5 },
  { normAlias: 'ربع نفر', factor: 0.25 },
  { normAlias: 'نص حبه', factor: 0.5 },
  { normAlias: 'نصف حبه', factor: 0.5 },
  { normAlias: 'ربع حبه', factor: 0.25 },
  { normAlias: 'نص', factor: 0.5 },
  { normAlias: 'نصف', factor: 0.5 },
  { normAlias: 'ربع', factor: 0.25 },
  { normAlias: 'حبه', factor: 1 },
  { normAlias: 'نفر', factor: 1 },
];

function buildProductIndex(products: Product[]): IndexedProduct[] {
  return products.map((product) => {
    const effectiveUnits = getEffectiveProductUnits(product);
    const normName = normalizeArabicText(product.name);
    const tokens = tokenizeNormalized(normName, false);
    const noAlTokens = tokenizeNormalized(normName, true);

    const unitMatchers: Array<{ normUnit: string; option: ProductUnitOption }> = [];
    for (const option of effectiveUnits) {
      const normUnit = normalizeArabicText(option.name);
      if (normUnit) {
        unitMatchers.push({ normUnit, option });
      }
      if (normUnit === 'نص') {
        unitMatchers.push({ normUnit: 'نصف', option });
        unitMatchers.push({ normUnit: 'نص حبه', option });
        unitMatchers.push({ normUnit: 'نصف حبه', option });
      } else if (normUnit === 'نص نفر') {
        unitMatchers.push({ normUnit: 'نصف نفر', option });
        unitMatchers.push({ normUnit: 'نص', option });
        unitMatchers.push({ normUnit: 'نصف', option });
      } else if (normUnit === 'ربع نفر') {
        unitMatchers.push({ normUnit: 'ربع', option });
      } else if (normUnit === 'ربع') {
        unitMatchers.push({ normUnit: 'ربع حبه', option });
      }
    }
    // Sort longer unit phrases first so "نص نفر" matches before "نص"
    unitMatchers.sort((a, b) => b.normUnit.length - a.normUnit.length);

    return {
      product,
      effectiveUnits,
      normName,
      tokens,
      noAlTokens,
      sortedKey: sortedTokensKey(tokens),
      sortedNoAlKey: sortedTokensKey(noAlTokens),
      unitMatchers,
    };
  });
}

function matchProductCore(
  normQuery: string,
  indexed: IndexedProduct[]
): { item: IndexedProduct; reason: Exclude<ExcelMatchReason, 'unit_variant' | 'manual'> } | null {
  if (!normQuery) return null;

  // 1. Exact normalized match
  for (const item of indexed) {
    if (item.normName === normQuery) {
      return { item, reason: 'exact' };
    }
  }

  const qTokens = tokenizeNormalized(normQuery, false);
  const qNoAlTokens = tokenizeNormalized(normQuery, true);
  const qNoAlJoined = qNoAlTokens.join(' ');

  // 2. Normalized without leading "ال"
  for (const item of indexed) {
    if (item.noAlTokens.join(' ') === qNoAlJoined) {
      return { item, reason: 'normalized' };
    }
  }

  // 3. Reordered token-set match (order-independent)
  const qSortedKey = sortedTokensKey(qTokens);
  const qSortedNoAlKey = sortedTokensKey(qNoAlTokens);
  for (const item of indexed) {
    if (item.sortedKey === qSortedKey || item.sortedNoAlKey === qSortedNoAlKey) {
      return { item, reason: 'reordered' };
    }
  }

  // 4. Unique token-subset match (when POS omits trailing descriptor like "على الحجر" or "بلدي")
  // Requires at least 2 meaningful tokens in query (or exact 1-token product) to stay safe.
  if (qNoAlTokens.length >= 2) {
    const subsetCandidates = indexed.filter((item) => {
      const prodSet = new Set(item.noAlTokens);
      const qSet = new Set(qNoAlTokens);
      const qInProd = qNoAlTokens.every((t) => prodSet.has(t));
      const prodInQ = item.noAlTokens.length >= 2 && item.noAlTokens.every((t) => qSet.has(t));
      return qInProd || prodInQ;
    });
    if (subsetCandidates.length === 1) {
      return { item: subsetCandidates[0], reason: 'subset' };
    }
  }

  // 5. Controlled fuzzy similarity match for minor Arabic spelling variations
  let bestCandidate: IndexedProduct | null = null;
  let bestScore = 0;
  let secondScore = 0;

  for (const item of indexed) {
    const s1 = stringSimilarity(normQuery, item.normName);
    const s2 = stringSimilarity(qSortedNoAlKey, item.sortedNoAlKey);
    const score = Math.max(s1, s2);
    if (score > bestScore) {
      secondScore = bestScore;
      bestScore = score;
      bestCandidate = item;
    } else if (score > secondScore) {
      secondScore = score;
    }
  }

  if (bestCandidate && bestScore >= 0.82 && bestScore - secondScore >= 0.06) {
    return { item: bestCandidate, reason: 'fuzzy' };
  }

  return null;
}

function matchExcelNameToProduct(
  rawExcelName: string,
  indexed: IndexedProduct[]
): {
  item: IndexedProduct;
  reason: Exclude<ExcelMatchReason, 'manual'>;
  unitFactor: number;
  matchedUnitOption?: ProductUnitOption;
} | null {
  const normQuery = normalizeArabicText(rawExcelName);
  if (!normQuery) return null;

  // Direct match first (never interpret unit prefix if exact/direct product exists)
  const direct = matchProductCore(normQuery, indexed);
  if (direct) {
    return {
      item: direct.item,
      reason: direct.reason,
      unitFactor: 1,
    };
  }

  // Check if Excel name carries a unit phrase at start or end (e.g. "نص مندي دجاج" or "مندي دجاج نص")
  for (const alias of GENERIC_UNIT_ALIASES) {
    const phrase = alias.normAlias;
    let stripped = '';
    if (normQuery.startsWith(`${phrase} `)) {
      stripped = normQuery.slice(phrase.length).trim();
    } else if (normQuery.endsWith(` ${phrase}`)) {
      stripped = normQuery.slice(0, normQuery.length - phrase.length).trim();
    }
    if (!stripped) continue;

    const baseMatch = matchProductCore(stripped, indexed);
    if (baseMatch) {
      const matchedOpt = baseMatch.item.unitMatchers.find((m) => m.normUnit === phrase)?.option
        ?? baseMatch.item.effectiveUnits.find((u) => Math.abs(u.factor - alias.factor) < 0.001);
      const factor = matchedOpt ? matchedOpt.factor : alias.factor;
      return {
        item: baseMatch.item,
        reason: 'unit_variant',
        unitFactor: factor,
        matchedUnitOption: matchedOpt,
      };
    }
  }

  return null;
}

export async function parseWorkbookFile(file: File): Promise<ParsedExcelWorkbook> {
  const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB safety limit
  if (file.size > MAX_SIZE_BYTES) {
    throw new Error('حجم الملف كبير جداً (الحد الأقصى 10 ميجابايت).');
  }

  const buffer = await file.arrayBuffer();
  const isCsv = file.name.toLowerCase().endsWith('.csv');

  let workbook: XLSX.WorkBook;
  if (isCsv) {
    const bytes = new Uint8Array(buffer);
    let text = '';
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      try {
        text = new TextDecoder('windows-1256').decode(bytes);
      } catch {
        text = new TextDecoder('utf-8').decode(bytes);
      }
    }
    workbook = XLSX.read(text, { type: 'string' });
  } else {
    workbook = XLSX.read(buffer, { type: 'array' });
  }

  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    throw new Error('الملف لا يحتوي على أي أوراق بيانات صالحة.');
  }

  const sheets: ParsedExcelSheet[] = workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: '',
      raw: true,
    });
    return { name, rows };
  }).filter((s) => s.rows.some((r) => Array.isArray(r) && r.some((cell) => String(cell ?? '').trim() !== '')));

  if (sheets.length === 0) {
    throw new Error('جميع أوراق الملف فارغة ولا تحتوي على بيانات.');
  }

  return {
    fileName: file.name,
    sheets,
    defaultSheetName: sheets[0].name,
  };
}

export function analyzeExcelSheet(
  sheet: ParsedExcelSheet,
  products: Product[],
  columnOverride?: { nameCol: number; qtyCol: number; headerRowIndex?: number }
): ExcelImportAnalysis {
  const autoDetection = detectColumns(sheet.rows);
  const detection: ColumnDetectionResult = columnOverride
    ? {
        ...autoDetection,
        nameCol: columnOverride.nameCol,
        qtyCol: columnOverride.qtyCol,
        headerRowIndex:
          columnOverride.headerRowIndex !== undefined
            ? columnOverride.headerRowIndex
            : autoDetection.headerRowIndex,
        autoDetected: false,
      }
    : autoDetection;

  const indexed = buildProductIndex(products);
  const headerNamesNorm = Array.from(NAME_HEADER_EXACT.keys());

  const startRow = detection.headerRowIndex >= 0 ? detection.headerRowIndex + 1 : 0;

  const matchedByProductId = new Map<
    string,
    {
      product: Product;
      effectiveUnits: ProductUnitOption[];
      excelNames: Set<string>;
      sourceRowNumbers: number[];
      totalQty: number;
      explicitBreakdown: UnitBreakdown;
      hasExplicitUnitVariant: boolean;
      hasPlainBaseQty: boolean;
      matchReason: ExcelMatchReason;
      matchedUnitLabel?: string;
    }
  >();

  const unrecognizedByKey = new Map<string, UnrecognizedExcelItem>();
  const ignoredRows: IgnoredExcelRow[] = [];

  for (let r = startRow; r < sheet.rows.length; r++) {
    const row = sheet.rows[r] || [];
    const rawNameCell = row[detection.nameCol];
    const rawQtyCell = row[detection.qtyCol];

    const rawName = String(rawNameCell ?? '').trim();
    const rawQtyStr = String(rawQtyCell ?? '').trim();

    if (!rawName && !rawQtyStr) continue;

    const normName = normalizeArabicText(rawName);
    const excelRowNum = r + 1;

    if (!rawName) {
      // Pure empty-name row (often a total line without label)
      if (rawQtyStr) {
        ignoredRows.push({
          rowNumber: excelRowNum,
          rawName: '—',
          rawQty: rawQtyStr,
          reason: 'صف بدون اسم صنف',
        });
      }
      continue;
    }

    if (isSummaryOrHeaderRow(normName, headerNamesNorm)) {
      ignoredRows.push({
        rowNumber: excelRowNum,
        rawName,
        rawQty: rawQtyStr || '—',
        reason: 'صف إجمالي أو عنوان متكرر',
      });
      continue;
    }

    // Ignore purely numeric codes in the name column
    if (/^\d+$/.test(normName)) {
      ignoredRows.push({
        rowNumber: excelRowNum,
        rawName,
        rawQty: rawQtyStr || '—',
        reason: 'قيمة رقمية وليست اسم صنف',
      });
      continue;
    }

    const parsedQty = parseArabicNumber(rawQtyCell);
    if (parsedQty === null) {
      ignoredRows.push({
        rowNumber: excelRowNum,
        rawName,
        rawQty: rawQtyStr || 'فارغ',
        reason: 'لا توجد كمية رقمية صالحة',
      });
      continue;
    }

    if (parsedQty < 0) {
      ignoredRows.push({
        rowNumber: excelRowNum,
        rawName,
        rawQty: rawQtyStr,
        reason: 'كمية سالبة (مرتجع أو خصم)',
      });
      continue;
    }

    const match = matchExcelNameToProduct(rawName, indexed);
    if (match) {
      const prod = match.item.product;
      const effectiveUnits = match.item.effectiveUnits;
      const addedBaseQty = roundQty3(parsedQty * match.unitFactor);
      const existing = matchedByProductId.get(prod.id);

      if (!existing) {
        const explicitBreakdown: UnitBreakdown = {};
        if (match.matchedUnitOption && parsedQty > 0) {
          explicitBreakdown[match.matchedUnitOption.name] = roundQty3(parsedQty);
        } else if (!match.matchedUnitOption && parsedQty > 0 && effectiveUnits[0]) {
          explicitBreakdown[effectiveUnits[0].name] = roundQty3(parsedQty);
        }
        matchedByProductId.set(prod.id, {
          product: prod,
          effectiveUnits,
          excelNames: new Set([rawName]),
          sourceRowNumbers: [excelRowNum],
          totalQty: addedBaseQty,
          explicitBreakdown,
          hasExplicitUnitVariant: Boolean(match.matchedUnitOption),
          hasPlainBaseQty: !match.matchedUnitOption,
          matchReason: match.reason,
          matchedUnitLabel: match.matchedUnitOption?.name,
        });
      } else {
        existing.excelNames.add(rawName);
        existing.sourceRowNumbers.push(excelRowNum);
        existing.totalQty = roundQty3(existing.totalQty + addedBaseQty);
        if (match.matchedUnitOption) {
          existing.hasExplicitUnitVariant = true;
          const uName = match.matchedUnitOption.name;
          existing.explicitBreakdown[uName] = roundQty3(
            (existing.explicitBreakdown[uName] || 0) + parsedQty
          );
        } else {
          existing.hasPlainBaseQty = true;
          if (effectiveUnits[0]) {
            const baseName = effectiveUnits[0].name;
            existing.explicitBreakdown[baseName] = roundQty3(
              (existing.explicitBreakdown[baseName] || 0) + parsedQty
            );
          }
        }
      }
    } else {
      const key = normName || rawName;
      const existingUnrec = unrecognizedByKey.get(key);
      if (!existingUnrec) {
        unrecognizedByKey.set(key, {
          rowKey: `unrec_${key}`,
          excelName: rawName,
          normalizedName: normName,
          sourceRowNumbers: [excelRowNum],
          extractedQty: roundQty3(parsedQty),
        });
      } else {
        existingUnrec.sourceRowNumbers.push(excelRowNum);
        existingUnrec.extractedQty = roundQty3(existingUnrec.extractedQty + parsedQty);
      }
    }
  }

  const matched: MatchedExcelItem[] = Array.from(matchedByProductId.values()).map((entry) => {
    const useExplicit =
      entry.hasExplicitUnitVariant &&
      Object.keys(entry.explicitBreakdown).length > 0 &&
      Math.abs(
        roundQty3(
          entry.effectiveUnits.reduce(
            (sum, u) => sum + (entry.explicitBreakdown[u.name] || 0) * u.factor,
            0
          )
        ) - entry.totalQty
      ) <= 0.002;

    const counts = decomposeTotalToUnitCounts(
      entry.totalQty,
      entry.effectiveUnits,
      useExplicit ? entry.explicitBreakdown : undefined
    );

    const computedBreakdown: UnitBreakdown = {};
    for (const u of entry.effectiveUnits) {
      const cVal = Number(counts[u.name] || 0);
      if (cVal > 0) computedBreakdown[u.name] = roundQty3(cVal);
    }

    return {
      rowKey: `match_${entry.product.id}`,
      product: entry.product,
      effectiveUnits: entry.effectiveUnits,
      excelNames: Array.from(entry.excelNames),
      sourceRowNumbers: entry.sourceRowNumbers,
      extractedQty: entry.totalQty,
      unitBreakdown: Object.keys(computedBreakdown).length > 0 ? computedBreakdown : undefined,
      counts,
      matchReason: entry.matchReason,
      matchedUnitLabel: entry.matchedUnitLabel,
    };
  });

  const totalMatchedQty = roundQty3(matched.reduce((s, m) => s + m.extractedQty, 0));

  return {
    sheetName: sheet.name,
    detection,
    matched,
    unrecognized: Array.from(unrecognizedByKey.values()),
    ignoredRows,
    totalMatchedQty,
  };
}
