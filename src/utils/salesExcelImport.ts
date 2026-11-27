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

export interface MatchedSourceLine {
  rowNumber: number;
  excelName: string;
  rawQty: number;
  unitLabel: string;
  unitFactor: number;
  baseEquivalent: number;
  matchReason: ExcelMatchReason;
}

export interface MatchedExcelItem {
  rowKey: string;
  product: Product;
  effectiveUnits: ProductUnitOption[];
  hasMultiUnitSupport: boolean;
  excelNames: string[];
  sourceRowNumbers: number[];
  sourceLines: MatchedSourceLine[];
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
  rawUnitHint?: string;
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
  unitCol: number; // -1 if unit is embedded in product name
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

/**
 * Replaces fraction notations (1/2, 1/4, 0.5, 0.25, ½, ¼) before punctuation stripping
 * so POS names like "1/2 دجاج شواية" or "شوايه 0.25" preserve their unit semantics.
 */
function preprocessFractionTokens(text: string): string {
  let out = text;
  out = out.replace(/½/g, ' نص ');
  out = out.replace(/¼/g, ' ربع ');
  // 1/2 or 1/4 when not part of a longer numeric date like 2026/1/2
  out = out.replace(/(^|[^\d/])1\s*\/\s*2([^\d/]|$)/g, '$1 نص $2');
  out = out.replace(/(^|[^\d/])1\s*\/\s*4([^\d/]|$)/g, '$1 ربع $2');
  // 0.5 or 0.25 standalone unit fractions
  out = out.replace(/(^|[^\d.])0\.5(0*)([^\d.]|$)/g, '$1 نص $3');
  out = out.replace(/(^|[^\d.])0\.25(0*)([^\d.]|$)/g, '$1 ربع $3');
  return out;
}

export function normalizeArabicText(raw: string): string {
  if (!raw) return '';
  let text = convertToAsciiDigits(String(raw));
  text = preprocessFractionTokens(text);
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
  if (
    token.length > 4 &&
    (token.startsWith('وال') || token.startsWith('بال') || token.startsWith('كال') || token.startsWith('لل'))
  ) {
    if (token.startsWith('لل')) {
      return token.slice(2);
    }
    return token.slice(3);
  }
  if (token.length > 3 && token.startsWith('و')) {
    // Do not strip leading waw on actual words starting with waw unless followed by ال (handled above)
    return token;
  }
  return token;
}

// Safe word-level canonicalization for Yemeni restaurant POS naming differences
const TOKEN_CANONICAL_ALIASES: Record<string, string> = {
  دجاجه: 'دجاج',
  فراخ: 'دجاج',
  فروج: 'دجاج',
  بروستد: 'بروست',
  بروستي: 'بروست',
  مضبي: 'مظبي',
  شويه: 'شوايه',
  شوايا: 'شوايه',
  مضغوطه: 'مضغوط',
  حنيذه: 'حنيذ',
  نصف: 'نص',
  half: 'نص',
  quarter: 'ربع',
  full: 'كامل',
  whole: 'كامل',
};

function canonicalizeToken(token: string, stripAl: boolean): string {
  const base = stripAl ? stripAlPrefixFromToken(token) : token;
  return TOKEN_CANONICAL_ALIASES[base] || base;
}

function tokenizeNormalized(normText: string, stripAl = false): string[] {
  if (!normText) return [];
  const parts = normText.split(' ').filter(Boolean);
  return parts.map((t) => canonicalizeToken(t, stripAl));
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
  const unitCleaned = raw
    .replace(/(حبه|حبة|نفر|صحن|علبه|علبة|برام|كيلو|وحدة|وحده|قطعه|قطعة|نص|ربع|pcs|unit|units|qty)/gi, '')
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

const UNIT_HEADER_EXACT = new Map<string, number>([
  ['الوحده', 100],
  ['وحده', 95],
  ['وحده القياس', 96],
  ['وحده البيع', 96],
  ['الحجم', 86],
  ['حجم', 82],
  ['unit', 95],
  ['uom', 95],
  ['size', 82],
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

function scoreUnitHeader(normHeader: string): number {
  if (!normHeader) return 0;
  const direct = UNIT_HEADER_EXACT.get(normHeader);
  if (direct) return direct;
  for (const bad of NON_QTY_PENALTY_KEYWORDS) {
    if (normHeader.includes(bad)) return 0;
  }
  return 0;
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
    unitCol: number;
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

    let bestUnitCol = -1;
    let bestUnitScore = 0;
    for (let c = 0; c < colCount; c++) {
      if (c === bestNameCol || c === bestQtyCol) continue;
      const s = scoreUnitHeader(normCells[c]);
      if (s > bestUnitScore) {
        bestUnitScore = s;
        bestUnitCol = c;
      }
    }

    if (bestNameCol !== -1 && bestQtyCol !== -1 && bestNameScore >= 55 && bestQtyScore >= 55) {
      const totalScore = bestNameScore + bestQtyScore;
      if (!bestPair || totalScore > bestPair.score) {
        bestPair = {
          rowIndex: r,
          nameCol: bestNameCol,
          qtyCol: bestQtyCol,
          unitCol: bestUnitScore >= 80 ? bestUnitCol : -1,
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
      unitCol: bestPair.unitCol,
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
    unitCol: -1,
    headers,
    autoDetected: false,
  };
}

/**
 * Domain classifiers to strictly separate Yemeni restaurant dish styles
 * (e.g., شواية vs مضغوط vs بروست vs مندي vs مظبي) and proteins (دجاج vs لحم vs سمك).
 */
const COOKING_STYLE_TOKEN_TO_GROUP: Record<string, string> = {
  شوايه: 'shawayah',
  مضغوط: 'madghout',
  ضغط: 'madghout',
  بروست: 'broast',
  مندي: 'mandi',
  مظبي: 'madhbi',
  حنيذ: 'haneeth',
  زربيان: 'zurbian',
  مدفون: 'madfoon',
  فحم: 'faham',
  مشوي: 'faham',
  كبسه: 'kabsa',
  كابلي: 'kabli',
  برياني: 'biryani',
  بخاري: 'bukhari',
  مثلوثه: 'mathlotha',
  سليق: 'saleeq',
  سلته: 'saltah',
  فحسه: 'fahsa',
  عقده: 'uqda',
  شفوت: 'shafout',
  سحاوق: 'sahawiq',
  مقلقل: 'muqalqal',
  شاورما: 'shawarma',
  عريكه: 'areeka',
  معصوب: 'masoub',
  فته: 'fattah',
  مسحب: 'musahab',
};

const PROTEIN_TOKEN_TO_GROUP: Record<string, string> = {
  دجاج: 'chicken',
  مسحب: 'chicken',
  لحم: 'meat',
  تيس: 'meat',
  غنم: 'meat',
  خروف: 'meat',
  حاشي: 'meat',
  عجل: 'meat',
  بقر: 'meat',
  ضان: 'meat',
  سمك: 'fish',
  كنعد: 'fish',
  هامور: 'fish',
  ديرك: 'fish',
  جمبري: 'fish',
  روبيان: 'fish',
};

const GENERIC_NON_UNIQUE_TOKENS = new Set([
  'دجاج',
  'لحم',
  'سمك',
  'حبه',
  'نفر',
  'نص',
  'ربع',
  'كامل',
  'كامله',
  'صحن',
  'علبه',
  'برام',
  'رز',
  'مع',
  'علي',
  'من',
  'في',
  'بالرز',
  'ساده',
  'عادي',
  'حراق',
  'سبايسي',
  'محلي',
  'سفري',
  'كبير',
  'وسط',
  'صغير',
]);

const OPTIONAL_POS_FILLER_TOKENS = new Set([
  'مع',
  'رز',
  'بالرز',
  'علي',
  'الحجر',
  'بلدي',
  'عدني',
  'يمني',
  'ساده',
  'بدون',
  'عادي',
  'حراق',
  'سبايسي',
  'محلي',
  'سفري',
  'وجبه',
  'طبق',
]);

interface DomainSignature {
  styles: Set<string>;
  proteins: Set<string>;
}

function extractDomainSignature(noAlTokens: string[]): DomainSignature {
  const styles = new Set<string>();
  const proteins = new Set<string>();
  for (const t of noAlTokens) {
    const s = COOKING_STYLE_TOKEN_TO_GROUP[t];
    if (s) styles.add(s);
    const p = PROTEIN_TOKEN_TO_GROUP[t];
    if (p) proteins.add(p);
  }
  return { styles, proteins };
}

function hasDomainConflict(qSig: DomainSignature, pSig: DomainSignature): boolean {
  // If query names any cooking style (e.g. شوايه, مضغوط, بروست), product MUST share at least one style
  if (qSig.styles.size > 0) {
    if (pSig.styles.size === 0) return true;
    let hasSharedStyle = false;
    for (const s of qSig.styles) {
      if (pSig.styles.has(s)) {
        hasSharedStyle = true;
        break;
      }
    }
    if (!hasSharedStyle) return true;
  }

  // If product names a style and query names a different style -> already blocked above.
  // Also block if protein conflicts (e.g. دجاج vs لحم vs سمك)
  if (qSig.proteins.size > 0 && pSig.proteins.size > 0) {
    let hasSharedProtein = false;
    for (const p of qSig.proteins) {
      if (pSig.proteins.has(p)) {
        hasSharedProtein = true;
        break;
      }
    }
    if (!hasSharedProtein) return true;
  }

  return false;
}

interface IndexedProduct {
  product: Product;
  effectiveUnits: ProductUnitOption[];
  normName: string;
  tokens: string[];
  noAlTokens: string[];
  sortedKey: string;
  sortedNoAlKey: string;
  domain: DomainSignature;
  unitMatchers: Array<{ normUnit: string; option: ProductUnitOption }>;
}

interface UnitPhraseDef {
  tokens: string[];
  phrase: string;
  factor: number;
}

const GENERIC_UNIT_PHRASES: UnitPhraseDef[] = [
  { tokens: ['نص', 'نفر'], phrase: 'نص نفر', factor: 0.5 },
  { tokens: ['ربع', 'نفر'], phrase: 'ربع نفر', factor: 0.25 },
  { tokens: ['نص', 'حبه'], phrase: 'نص حبه', factor: 0.5 },
  { tokens: ['ربع', 'حبه'], phrase: 'ربع حبه', factor: 0.25 },
  { tokens: ['حبه', 'كامل'], phrase: 'حبه كامل', factor: 1 },
  { tokens: ['حبه', 'كامله'], phrase: 'حبه كامله', factor: 1 },
  { tokens: ['نفر', 'كامل'], phrase: 'نفر كامل', factor: 1 },
  { tokens: ['حبتين'], phrase: 'حبتين', factor: 2 },
  { tokens: ['نفرين'], phrase: 'نفرين', factor: 2 },
  { tokens: ['نص'], phrase: 'نص', factor: 0.5 },
  { tokens: ['ربع'], phrase: 'ربع', factor: 0.25 },
  { tokens: ['حبه'], phrase: 'حبه', factor: 1 },
  { tokens: ['نفر'], phrase: 'نفر', factor: 1 },
  { tokens: ['كامل'], phrase: 'كامل', factor: 1 },
  { tokens: ['كامله'], phrase: 'كامله', factor: 1 },
];

function buildProductIndex(products: Product[]): IndexedProduct[] {
  return products.map((product) => {
    const effectiveUnits = getEffectiveProductUnits(product);
    const normName = normalizeArabicText(product.name);
    const tokens = tokenizeNormalized(normName, false);
    const noAlTokens = tokenizeNormalized(normName, true);
    const domain = extractDomainSignature(noAlTokens);

    const unitMatchers: Array<{ normUnit: string; option: ProductUnitOption }> = [];
    for (const option of effectiveUnits) {
      const normUnit = normalizeArabicText(option.name);
      if (normUnit) {
        const canonUnit = tokenizeNormalized(normUnit, true).join(' ');
        unitMatchers.push({ normUnit, option });
        if (canonUnit && canonUnit !== normUnit) {
          unitMatchers.push({ normUnit: canonUnit, option });
        }
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
      domain,
      unitMatchers,
    };
  });
}

function matchProductStrictDirect(
  normQuery: string,
  indexed: IndexedProduct[]
): { item: IndexedProduct; reason: 'exact' | 'normalized' | 'reordered' } | null {
  if (!normQuery) return null;

  for (const item of indexed) {
    if (item.normName === normQuery) {
      return { item, reason: 'exact' };
    }
  }

  const qTokens = tokenizeNormalized(normQuery, false);
  const qNoAlTokens = tokenizeNormalized(normQuery, true);
  const qNoAlJoined = qNoAlTokens.join(' ');

  for (const item of indexed) {
    if (item.noAlTokens.join(' ') === qNoAlJoined) {
      return { item, reason: 'normalized' };
    }
  }

  const qSortedKey = sortedTokensKey(qTokens);
  const qSortedNoAlKey = sortedTokensKey(qNoAlTokens);
  for (const item of indexed) {
    if (item.sortedKey === qSortedKey || item.sortedNoAlKey === qSortedNoAlKey) {
      return { item, reason: 'reordered' };
    }
  }

  return null;
}

function matchProductFlexible(
  normQuery: string,
  indexed: IndexedProduct[]
): { item: IndexedProduct; reason: Exclude<ExcelMatchReason, 'unit_variant' | 'manual'> } | null {
  if (!normQuery) return null;

  const strict = matchProductStrictDirect(normQuery, indexed);
  if (strict) return strict;

  const qNoAlTokens = tokenizeNormalized(normQuery, true);
  if (qNoAlTokens.length === 0) return null;

  const qSig = extractDomainSignature(qNoAlTokens);
  const qSortedNoAlKey = sortedTokensKey(qNoAlTokens);

  // Filter eligible products that never violate cooking style or protein boundaries
  const compatibleProducts = indexed.filter((item) => !hasDomainConflict(qSig, item.domain));
  if (compatibleProducts.length === 0) return null;

  // 4A. Unique token-subset match (2+ tokens in query, e.g., "مضغوط دجاج بلدي" vs "مضغوط دجاج")
  if (qNoAlTokens.length >= 2) {
    const subsetCandidates = compatibleProducts.filter((item) => {
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

  // 4B. Safe 1-token or style-driven unique match (e.g. "شواية" -> "دجاج شواية",
  // "بروست" -> "بروست دجاج", "شواية مع رز" -> "دجاج شواية" when only 1 shawayah product exists).
  const coreQueryTokens = qNoAlTokens.filter((t) => !OPTIONAL_POS_FILLER_TOKENS.has(t));
  if (coreQueryTokens.length === 1) {
    const singleTok = coreQueryTokens[0];
    if (!GENERIC_NON_UNIQUE_TOKENS.has(singleTok)) {
      const styleOrTokenCandidates = compatibleProducts.filter((item) => {
        if (item.noAlTokens.includes(singleTok)) return true;
        const singleStyle = COOKING_STYLE_TOKEN_TO_GROUP[singleTok];
        return Boolean(singleStyle && item.domain.styles.has(singleStyle));
      });
      if (styleOrTokenCandidates.length === 1) {
        return { item: styleOrTokenCandidates[0], reason: 'subset' };
      }
    }
  } else if (coreQueryTokens.length >= 2 && qSig.styles.size > 0) {
    // Query had extra POS descriptors like "بروست حراق سبايسي" when catalog only has "بروست دجاج"
    // Only apply if style + protein uniquely identifies a SINGLE product in compatibleProducts
    const matchingStyleProducts = compatibleProducts.filter((item) => {
      for (const s of qSig.styles) {
        if (!item.domain.styles.has(s)) return false;
      }
      return true;
    });
    if (matchingStyleProducts.length === 1) {
      // Ensure query doesn't introduce an unknown distinct word that might mean another flavor in catalog
      const onlyItem = matchingStyleProducts[0];
      const meaningfulOverlap = coreQueryTokens.some((t) => onlyItem.noAlTokens.includes(t));
      if (meaningfulOverlap) {
        return { item: onlyItem, reason: 'subset' };
      }
    }
  }

  // 5. Controlled fuzzy similarity match ONLY within compatible style/protein products
  let bestCandidate: IndexedProduct | null = null;
  let bestScore = 0;
  let secondScore = 0;

  for (const item of compatibleProducts) {
    // Extra guard: if product has a cooking style and query has NONE, don't fuzzy-guess
    // unless string similarity is very high (handles minor spelling typo on the style word itself)
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

  if (bestCandidate && bestScore >= 0.84 && bestScore - secondScore >= 0.06) {
    return { item: bestCandidate, reason: 'fuzzy' };
  }

  return null;
}

/**
 * Finds and removes a unit phrase from ANY position (start, middle, OR end) of token list.
 */
function extractUnitCandidates(
  normQuery: string,
  extraProductUnits: IndexedProduct[]
): Array<{ phrase: string; factor: number; strippedQuery: string }> {
  const tokens = tokenizeNormalized(normQuery, true);
  if (tokens.length < 2) return [];

  const results: Array<{ phrase: string; factor: number; strippedQuery: string }> = [];
  const seenStripped = new Set<string>();

  // Collect custom product unit phrases as well (e.g., "نص كيلو", "ربع كيلو", "علبه")
  const customPhrases: UnitPhraseDef[] = [];
  const seenCustom = new Set<string>(GENERIC_UNIT_PHRASES.map((g) => g.phrase));
  for (const item of extraProductUnits) {
    for (const um of item.unitMatchers) {
      const pTokens = tokenizeNormalized(um.normUnit, true);
      const key = pTokens.join(' ');
      if (pTokens.length > 0 && !seenCustom.has(key)) {
        seenCustom.add(key);
        customPhrases.push({ tokens: pTokens, phrase: key, factor: um.option.factor });
      }
    }
  }

  const allPhrases = [...customPhrases, ...GENERIC_UNIT_PHRASES].sort(
    (a, b) => b.tokens.length - a.tokens.length
  );

  for (const def of allPhrases) {
    const len = def.tokens.length;
    if (tokens.length <= len) continue;

    // Scan start, middle, and end for contiguous phrase match
    for (let i = 0; i <= tokens.length - len; i++) {
      let matched = true;
      for (let j = 0; j < len; j++) {
        if (tokens[i + j] !== def.tokens[j]) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;

      const remaining = [...tokens.slice(0, i), ...tokens.slice(i + len)].join(' ').trim();
      if (!remaining) continue;
      const dedupeKey = `${def.phrase}::${remaining}`;
      if (seenStripped.has(dedupeKey)) continue;
      seenStripped.add(dedupeKey);
      results.push({
        phrase: def.phrase,
        factor: def.factor,
        strippedQuery: remaining,
      });
    }
  }

  return results;
}

export function guessUnitOptionForText(
  rawText: string,
  units: ProductUnitOption[]
): ProductUnitOption | undefined {
  if (!rawText || units.length <= 1) return units[0];
  const norm = normalizeArabicText(rawText);
  const tokens = tokenizeNormalized(norm, true);
  if (tokens.length === 0) return units[0];

  for (const def of GENERIC_UNIT_PHRASES) {
    const len = def.tokens.length;
    for (let i = 0; i <= tokens.length - len; i++) {
      let ok = true;
      for (let j = 0; j < len; j++) {
        if (tokens[i + j] !== def.tokens[j]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        const match = units.find((u) => Math.abs(u.factor - def.factor) < 0.001);
        if (match) return match;
      }
    }
  }
  return units[0];
}

function resolveMatchedUnitOption(
  item: IndexedProduct,
  phrase: string,
  factor: number
): ProductUnitOption | undefined {
  const byPhrase = item.unitMatchers.find((m) => m.normUnit === phrase)?.option;
  if (byPhrase) return byPhrase;
  return item.effectiveUnits.find((u) => Math.abs(u.factor - factor) < 0.001);
}

function matchExcelNameToProduct(
  rawExcelName: string,
  rawUnitCell: string,
  indexed: IndexedProduct[]
): {
  item: IndexedProduct;
  reason: Exclude<ExcelMatchReason, 'manual'>;
  unitFactor: number;
  matchedUnitOption?: ProductUnitOption;
} | null {
  const normQuery = normalizeArabicText(rawExcelName);
  if (!normQuery) return null;

  const normUnitCol = normalizeArabicText(rawUnitCell);

  // 1. Strict direct match FIRST (exact / normalized / reordered only —
  // never run subset/fuzzy before stripping "نص" or "ربع"!)
  const strictDirect = matchProductStrictDirect(normQuery, indexed);
  if (strictDirect) {
    if (normUnitCol) {
      const colUnitMatch = guessUnitOptionForText(normUnitCol, strictDirect.item.effectiveUnits);
      if (colUnitMatch && Math.abs(colUnitMatch.factor - 1) > 0.001) {
        return {
          item: strictDirect.item,
          reason: 'unit_variant',
          unitFactor: colUnitMatch.factor,
          matchedUnitOption: colUnitMatch,
        };
      }
    }
    return {
      item: strictDirect.item,
      reason: strictDirect.reason,
      unitFactor: 1,
    };
  }

  // 2. Extract unit phrases from start, middle, OR end (e.g. "نص دجاج شوايه", "دجاج نص شوايه", "شوايه 1/4")
  const unitCandidates = extractUnitCandidates(normQuery, indexed);
  for (const cand of unitCandidates) {
    const baseMatch = matchProductFlexible(cand.strippedQuery, indexed);
    if (baseMatch) {
      const matchedOpt = resolveMatchedUnitOption(baseMatch.item, cand.phrase, cand.factor);
      const factor = matchedOpt ? matchedOpt.factor : cand.factor;
      return {
        item: baseMatch.item,
        reason: 'unit_variant',
        unitFactor: factor,
        matchedUnitOption: matchedOpt,
      };
    }
  }

  // 3. Fallback to flexible subset / fuzzy match ONLY when no unresolved unit phrase interfered
  const flexibleDirect = matchProductFlexible(normQuery, indexed);
  if (flexibleDirect) {
    if (normUnitCol) {
      const colUnitMatch = guessUnitOptionForText(normUnitCol, flexibleDirect.item.effectiveUnits);
      if (colUnitMatch && Math.abs(colUnitMatch.factor - 1) > 0.001) {
        return {
          item: flexibleDirect.item,
          reason: 'unit_variant',
          unitFactor: colUnitMatch.factor,
          matchedUnitOption: colUnitMatch,
        };
      }
    }
    return {
      item: flexibleDirect.item,
      reason: flexibleDirect.reason,
      unitFactor: 1,
    };
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
  }).filter((s) =>
    s.rows.some((r) => Array.isArray(r) && r.some((cell) => String(cell ?? '').trim() !== ''))
  );

  if (sheets.length === 0) {
    throw new Error('جميع أوراق الملف فارغة ولا تحتوي على بيانات.');
  }

  return {
    fileName: file.name,
    sheets,
    defaultSheetName: sheets[0].name,
  };
}

function addUnitCountsIntoBreakdown(
  target: UnitBreakdown,
  sourceCounts: Record<string, string>
): void {
  for (const [unitName, rawVal] of Object.entries(sourceCounts)) {
    const n = Number(rawVal);
    if (Number.isFinite(n) && n > 0) {
      target[unitName] = roundQty3((target[unitName] || 0) + n);
    }
  }
}

export function analyzeExcelSheet(
  sheet: ParsedExcelSheet,
  products: Product[],
  columnOverride?: { nameCol: number; qtyCol: number; unitCol?: number; headerRowIndex?: number }
): ExcelImportAnalysis {
  const autoDetection = detectColumns(sheet.rows);
  const detection: ColumnDetectionResult = columnOverride
    ? {
        ...autoDetection,
        nameCol: columnOverride.nameCol,
        qtyCol: columnOverride.qtyCol,
        unitCol:
          columnOverride.unitCol !== undefined ? columnOverride.unitCol : autoDetection.unitCol,
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
      sourceLines: MatchedSourceLine[];
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
    const rawUnitCell = detection.unitCol >= 0 ? String(row[detection.unitCol] ?? '').trim() : '';

    const rawName = String(rawNameCell ?? '').trim();
    const rawQtyStr = String(rawQtyCell ?? '').trim();

    if (!rawName && !rawQtyStr) continue;

    const normName = normalizeArabicText(rawName);
    const excelRowNum = r + 1;

    if (!rawName) {
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

    const match = matchExcelNameToProduct(rawName, rawUnitCell, indexed);
    if (match) {
      const prod = match.item.product;
      const effectiveUnits = match.item.effectiveUnits;
      const addedBaseQty = roundQty3(parsedQty * match.unitFactor);
      const unitLabel =
        match.matchedUnitOption?.name ||
        (match.unitFactor === 2
          ? `×2 (${effectiveUnits[0]?.name || prod.unit})`
          : effectiveUnits[0]?.name || prod.unit);

      const sourceLine: MatchedSourceLine = {
        rowNumber: excelRowNum,
        excelName: rawUnitCell ? `${rawName} [${rawUnitCell}]` : rawName,
        rawQty: roundQty3(parsedQty),
        unitLabel,
        unitFactor: match.unitFactor,
        baseEquivalent: addedBaseQty,
        matchReason: match.reason,
      };

      let existing = matchedByProductId.get(prod.id);
      if (!existing) {
        existing = {
          product: prod,
          effectiveUnits,
          excelNames: new Set(),
          sourceRowNumbers: [],
          sourceLines: [],
          totalQty: 0,
          explicitBreakdown: {},
          hasExplicitUnitVariant: false,
          hasPlainBaseQty: false,
          matchReason: match.reason,
          matchedUnitLabel: match.matchedUnitOption?.name,
        };
        matchedByProductId.set(prod.id, existing);
      }

      existing.excelNames.add(sourceLine.excelName);
      existing.sourceRowNumbers.push(excelRowNum);
      existing.sourceLines.push(sourceLine);
      existing.totalQty = roundQty3(existing.totalQty + addedBaseQty);

      if (match.matchedUnitOption) {
        existing.hasExplicitUnitVariant = true;
        if (parsedQty > 0) {
          const uName = match.matchedUnitOption.name;
          existing.explicitBreakdown[uName] = roundQty3(
            (existing.explicitBreakdown[uName] || 0) + parsedQty
          );
        }
      } else {
        existing.hasPlainBaseQty = true;
        if (addedBaseQty > 0) {
          if (effectiveUnits.length > 1) {
            // If a plain base row carries a decimal fraction like 2.5 or 1.25,
            // split its fractional part cleanly into حبة/نص/ربع counts!
            const splitPlain = decomposeTotalToUnitCounts(addedBaseQty, effectiveUnits);
            addUnitCountsIntoBreakdown(existing.explicitBreakdown, splitPlain);
            existing.hasExplicitUnitVariant = true;
          } else if (effectiveUnits[0]) {
            const baseName = effectiveUnits[0].name;
            existing.explicitBreakdown[baseName] = roundQty3(
              (existing.explicitBreakdown[baseName] || 0) + addedBaseQty
            );
          }
        }
      }
    } else {
      const displayExcelName = rawUnitCell ? `${rawName} [${rawUnitCell}]` : rawName;
      const key = `${normName || rawName}::${normalizeArabicText(rawUnitCell)}`;
      const existingUnrec = unrecognizedByKey.get(key);
      if (!existingUnrec) {
        unrecognizedByKey.set(key, {
          rowKey: `unrec_${key}`,
          excelName: displayExcelName,
          normalizedName: normName,
          sourceRowNumbers: [excelRowNum],
          extractedQty: roundQty3(parsedQty),
          rawUnitHint: rawUnitCell || undefined,
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
      hasMultiUnitSupport: entry.effectiveUnits.length > 1,
      excelNames: Array.from(entry.excelNames),
      sourceRowNumbers: entry.sourceRowNumbers,
      sourceLines: entry.sourceLines,
      extractedQty: entry.totalQty,
      unitBreakdown: Object.keys(computedBreakdown).length > 0 ? computedBreakdown : undefined,
      counts,
      matchReason: entry.matchReason,
      matchedUnitLabel: entry.matchedUnitLabel,
    };
  });

  // Sort multi-unit products first so حبة/نص/ربع items are grouped clearly
  matched.sort((a, b) => {
    if (a.hasMultiUnitSupport !== b.hasMultiUnitSupport) {
      return a.hasMultiUnitSupport ? -1 : 1;
    }
    return a.product.name.localeCompare(b.product.name, 'ar');
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
