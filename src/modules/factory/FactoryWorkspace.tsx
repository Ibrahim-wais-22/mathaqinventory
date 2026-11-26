import React, { useEffect, useMemo, useState } from 'react';
import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';
import * as XLSX from 'xlsx';
import {
  ArrowLeftRight,
  CopyCheck,
  Edit3,
  FileSpreadsheet,
  PackagePlus,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Send,
  Trash2,
  Truck,
  X,
} from 'lucide-react';
import {
  PRODUCT_APPROVAL_LABELS,
  REPORT_STATUS_LABELS,
  TRANSFER_STATUS_LABELS,
} from '../../constants/departments';
import { useFirebase } from '../../app/providers/FirebaseProvider';
import { OperationType, db, handleFirestoreError } from '../../services/firebase/config';
import {
  createFactoryReturn,
  createFactoryTransfer,
  deleteFactoryTransfer,
  ensureDepartmentReport,
  formatActionError,
  proposeProductByFactory,
  saveDepartmentReportDraft,
  submitDepartmentReport,
  updateFactoryTransfer,
} from '../../services/inventory/firestoreService';
import type {
  DepartmentReport,
  DepartmentReportItem,
  FactoryTransfer,
  FactoryTransferItem,
  Product,
  ProductUnitOption,
  UnitBreakdown,
} from '../../types/inventory';
import { roundQty } from '../../services/inventory/calculator';
import {
  buildHalvesAndQuartersPreset,
  decomposeTotalToUnitCounts,
  formatBreakdownText,
  formatUnitsSummary,
  getEffectiveProductUnits,
  sumUnitCounts,
} from '../../utils/productUnits';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';
import { MultiUnitQtyInput } from '../../components/common/MultiUnitQtyInput';
import { StatusBadge } from '../../components/common/StatusBadge';
import { ReportDateTransferModal } from '../../components/inventory/ReportDateTransferModal';
import { formatTimestampAden, getPreviousAdenDate } from '../../utils/dateAden';

export const FactoryWorkspace: React.FC = () => {
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
  const [preparedMap, setPreparedMap] = useState<Record<string, string>>({});
  const [preparedCountsMap, setPreparedCountsMap] = useState<Record<string, Record<string, string>>>({});
  const [transferQtyMap, setTransferQtyMap] = useState<Record<string, string>>({});
  const [transferCountsMap, setTransferCountsMap] = useState<Record<string, Record<string, string>>>({});
  const [transferNote, setTransferNote] = useState('');
  const [returnQtyMap, setReturnQtyMap] = useState<Record<string, string>>({});
  const [returnCountsMap, setReturnCountsMap] = useState<Record<string, Record<string, string>>>({});
  const [returnNote, setReturnNote] = useState('');
  const [transfers, setTransfers] = useState<FactoryTransfer[]>([]);
  const [todayMovement, setTodayMovement] = useState<{
    sent: Record<string, number>;
    returned: Record<string, number>;
    net: Record<string, number>;
  }>({ sent: {}, returned: {}, net: {} });
  const [proposedProducts, setProposedProducts] = useState<Product[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [activeSubTab, setActiveSubTab] = useState<'dispatch' | 'returns' | 'prepared' | 'proposals'>('dispatch');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [confirmSubmitOpen, setConfirmSubmitOpen] = useState(false);
  const [confirmTransferOpen, setConfirmTransferOpen] = useState(false);
  const [confirmReturnOpen, setConfirmReturnOpen] = useState(false);
  const [transferModalOpen, setTransferModalOpen] = useState(false);

  // Propose new product modal state
  const [newProdModal, setNewProdModal] = useState(false);
  const [newProdName, setNewProdName] = useState('');
  const [newProdCat, setNewProdCat] = useState('');
  const [newProdUnit, setNewProdUnit] = useState('نفر');
  const [newProdEnableParts, setNewProdEnableParts] = useState(true);
  const [newProdReason, setNewProdReason] = useState('');

  // Edit pending transfer modal
  const [editingTransfer, setEditingTransfer] = useState<FactoryTransfer | null>(null);
  const [editTransferQtyMap, setEditTransferQtyMap] = useState<Record<string, string>>({});
  const [editTransferCountsMap, setEditTransferCountsMap] = useState<
    Record<string, Record<string, string>>
  >({});
  const [editTransferNote, setEditTransferNote] = useState('');
  const [editTransferLoading, setEditTransferLoading] = useState(false);

  // Delete transfer or return confirmation
  const [deletingTransfer, setDeletingTransfer] = useState<FactoryTransfer | null>(null);
  const [exportingExcel, setExportingExcel] = useState(false);

  const approvedProducts = useMemo(
    () =>
      products.filter(
        (p) =>
          p.approvalStatus === 'approved' &&
          p.isActive &&
          p.allowedDepartments.includes('factory')
      ),
    [products]
  );

  const productMap = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  // Load or initialize Factory report + items
  useEffect(() => {
    setReport(null);
    setPreparedMap({});
    setPreparedCountsMap({});
    setTransfers([]);
    if (!account || !currentSession) return;
    let active = true;
    if (!isDeptQtyReadOnly) {
      ensureDepartmentReport(account, currentSession, 'factory')
        .then((rep) => {
          if (active) setReport(rep);
        })
        .catch((err) => {
          if (active) {
            setFeedback({ type: 'error', text: formatActionError(err, 'تعذر تحميل تقرير المعمل.') });
          }
        });
    }

    const reportId = `${currentSession.id}_factory`;
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
        where('department', '==', 'factory')
      ),
      (snap) => {
        const next: Record<string, string> = {};
        const nextCounts: Record<string, Record<string, string>> = {};
        snap.forEach((docSnap) => {
          const item = docSnap.data() as DepartmentReportItem;
          if (item.preparedQty !== null && item.preparedQty !== undefined) {
            next[item.productId] = String(item.preparedQty);
            const prod = productMap.get(item.productId);
            if (prod) {
              nextCounts[item.productId] = decomposeTotalToUnitCounts(
                item.preparedQty,
                getEffectiveProductUnits(prod),
                item.unitBreakdowns?.preparedQty
              );
            }
          }
        });
        setPreparedMap(next);
        setPreparedCountsMap(nextCounts);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, `departmentReports/${reportId}/items`)
    );

    const unsubTransfers = onSnapshot(
      query(collection(db, 'factoryTransfers'), where('sessionId', '==', currentSession.id)),
      (snap) => {
        const list = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<FactoryTransfer, 'id'>) }))
          .sort((a, b) => (b.transferNumber > a.transferNumber ? 1 : -1));
        setTransfers(list);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'factoryTransfers')
    );

    const unsubProposed = onSnapshot(
      query(collection(db, 'products'), where('createdBy', '==', account.uid)),
      (snap) => {
        setProposedProducts(
          snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Product, 'id'>) }))
        );
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'products')
    );

    return () => {
      active = false;
      unsubRep();
      unsubItems();
      unsubTransfers();
      unsubProposed();
    };
  }, [account?.uid, currentSession?.id]);

  // Compute same-day sent, returned, and net transferred quantities per product
  useEffect(() => {
    if (transfers.length === 0) {
      setTodayMovement({ sent: {}, returned: {}, net: {} });
      return;
    }
    let active = true;
    Promise.all(
      transfers.map(async (trf) => {
        const snap = await getDocs(collection(db, 'factoryTransfers', trf.id, 'items'));
        return { trf, snap };
      })
    )
      .then((results) => {
        if (!active) return;
        const sent: Record<string, number> = {};
        const returned: Record<string, number> = {};
        const net: Record<string, number> = {};
        for (const { trf, snap } of results) {
          const isReturn = trf.transferType === 'return' || trf.status === 'returned';
          snap.forEach((d) => {
            const data = d.data() as { productId?: string; sentQty?: number };
            if (!data.productId) return;
            const q = roundQty(Number(data.sentQty || 0));
            if (isReturn) {
              returned[data.productId] = roundQty((returned[data.productId] || 0) + q);
            } else {
              sent[data.productId] = roundQty((sent[data.productId] || 0) + q);
            }
          });
        }
        const allIds = new Set([...Object.keys(sent), ...Object.keys(returned)]);
        allIds.forEach((pid) => {
          net[pid] = Math.max(0, roundQty((sent[pid] || 0) - (returned[pid] || 0)));
        });
        setTodayMovement({ sent, returned, net });
      })
      .catch((err) => {
        console.warn('Could not load transfer item totals:', err);
      });

    return () => {
      active = false;
    };
  }, [transfers]);

  const dispatchTransfers = useMemo(
    () => transfers.filter((t) => t.transferType !== 'return' && t.status !== 'returned'),
    [transfers]
  );

  const returnTransfers = useMemo(
    () => transfers.filter((t) => t.transferType === 'return' || t.status === 'returned'),
    [transfers]
  );

  const filteredProducts = useMemo(() => {
    return approvedProducts.filter((p) => {
      const matchesCat = selectedCategory === 'all' || p.categoryId === selectedCategory;
      const matchesSearch = !searchQuery.trim() || p.name.includes(searchQuery.trim());
      return matchesCat && matchesSearch;
    });
  }, [approvedProducts, selectedCategory, searchQuery]);

  const categoryMap = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories]);

  const isSessionClosed = currentSession?.status === 'closed';
  const isSubmitted = report ? report.status !== 'draft' : false;

  const enteredPreparedCount = useMemo(() => {
    return approvedProducts.filter((p) => preparedMap[p.id] !== '' && preparedMap[p.id] !== undefined)
      .length;
  }, [approvedProducts, preparedMap]);

  const resolveActiveReport = async (): Promise<DepartmentReport> => {
    if (!account) {
      throw new Error('يرجى تسجيل الدخول بحساب نشط أولاً.');
    }
    if (!currentSession) {
      throw new Error(sessionError || 'جلسة الجرد اليومية غير جاهزة بعد. يرجى تحديث الجلسة.');
    }
    if (report && report.sessionId === currentSession.id) {
      return report;
    }
    const ensured = await ensureDepartmentReport(account, currentSession, 'factory');
    setReport(ensured);
    return ensured;
  };

  const buildPreparedDraftItems = () => {
    return approvedProducts.map((p) => {
      const units = getEffectiveProductUnits(p);
      const counts = preparedCountsMap[p.id];
      let val: number | null = null;
      let breakdown: UnitBreakdown | undefined;

      if (counts && Object.keys(counts).length > 0) {
        const summed = sumUnitCounts(units, counts);
        if (summed.hasInvalid) {
          throw new Error(`الكمية المدخلة للصنف "${p.name}" غير صالحة.`);
        }
        val = summed.total;
        breakdown = summed.breakdown;
      } else {
        const raw = preparedMap[p.id];
        val = raw === undefined || raw === '' ? null : Number(raw);
        if (val !== null && (Number.isNaN(val) || val < 0)) {
          throw new Error(`الكمية المدخلة للصنف "${p.name}" غير صالحة.`);
        }
      }

      return {
        productId: p.id,
        categoryId: p.categoryId,
        preparedQty: val !== null ? roundQty(val) : null,
        unitBreakdowns: breakdown ? { preparedQty: breakdown } : null,
      };
    });
  };

  const handleSaveDraft = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      const activeReport = await resolveActiveReport();
      const items = buildPreparedDraftItems();
      await saveDepartmentReportDraft(account!, activeReport, items);
      setFeedback({ type: 'success', text: 'تم حفظ مسودة تقرير المعمل بنجاح.' });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: formatActionError(err, 'تعذر حفظ المسودة.'),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleSubmitReport = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      const activeReport = await resolveActiveReport();
      const items = buildPreparedDraftItems();
      await saveDepartmentReportDraft(account!, activeReport, items);
      const count = items.filter((i) => i.preparedQty !== null).length;
      await submitDepartmentReport(account!, activeReport, count);
      setConfirmSubmitOpen(false);
      setFeedback({
        type: 'success',
        text:
          activeReport.status === 'submitted'
            ? 'تم حفظ وتحديث تقرير الكميات المجهزة بالمعمل بنجاح.'
            : 'تم ترحيل تقرير المعمل بنجاح (يبقى مفتوحاً للتعديل قبل إغلاق اليوم).',
      });
    } catch (err) {
      setConfirmSubmitOpen(false);
      setFeedback({
        type: 'error',
        text: formatActionError(err, 'تعذر ترحيل التقرير.'),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleFillPreparedFromTransfers = async () => {
    if (dispatchTransfers.length === 0) {
      setFeedback({ type: 'error', text: 'لا توجد توريدات مرسلة اليوم للنسخ منها.' });
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      const summed = new Map<string, number>();
      const summedBreakdowns = new Map<string, UnitBreakdown>();
      for (const trf of transfers) {
        const isReturn = trf.transferType === 'return' || trf.status === 'returned';
        const itemsSnap = await getDocs(collection(db, 'factoryTransfers', trf.id, 'items'));
        itemsSnap.forEach((d) => {
          const data = d.data() as {
            productId?: string;
            sentQty?: number;
            sentBreakdown?: UnitBreakdown | null;
          };
          if (data.productId) {
            const qtyDelta = Number(data.sentQty || 0);
            const curTotal = summed.get(data.productId) || 0;
            summed.set(
              data.productId,
              Math.max(0, roundQty(isReturn ? curTotal - qtyDelta : curTotal + qtyDelta))
            );
            if (data.sentBreakdown) {
              const curBd = summedBreakdowns.get(data.productId) || {};
              for (const [uName, uQty] of Object.entries(data.sentBreakdown)) {
                if (typeof uQty === 'number' && uQty > 0) {
                  const prev = curBd[uName] || 0;
                  const nextU = Math.max(0, roundQty(isReturn ? prev - uQty : prev + uQty));
                  if (nextU > 0) curBd[uName] = nextU;
                  else delete curBd[uName];
                }
              }
              summedBreakdowns.set(data.productId, curBd);
            }
          }
        });
      }
      setPreparedMap((prev) => {
        const next = { ...prev };
        summed.forEach((qty, pid) => {
          next[pid] = String(roundQty(qty));
        });
        return next;
      });
      setPreparedCountsMap((prev) => {
        const next = { ...prev };
        summed.forEach((qty, pid) => {
          const prod = productMap.get(pid);
          if (prod) {
            next[pid] = decomposeTotalToUnitCounts(
              qty,
              getEffectiveProductUnits(prod),
              summedBreakdowns.get(pid)
            );
          }
        });
        return next;
      });
      setFeedback({
        type: 'success',
        text: 'تم تعبئة الكميات المجهزة من صافي التوريدات المرسلة اليوم بعد خصم أي مرتجعات.',
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: formatActionError(err, 'تعذر جلب تفاصيل التوريدات.'),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleCreateTransfer = async () => {
    if (!account || !currentSession) {
      setConfirmTransferOpen(false);
      setFeedback({
        type: 'error',
        text: sessionError || 'جلسة الجرد اليومية غير متاحة حالياً. يرجى تحديث الصفحة.',
      });
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      const items = approvedProducts
        .map((p) => {
          const units = getEffectiveProductUnits(p);
          const counts = transferCountsMap[p.id];
          let qty = 0;
          let sentBreakdown: UnitBreakdown | undefined;

          if (counts && Object.keys(counts).length > 0) {
            const summed = sumUnitCounts(units, counts);
            if (summed.hasInvalid) {
              throw new Error(`الكمية المرسلة للصنف "${p.name}" غير صالحة.`);
            }
            qty = summed.total ?? 0;
            sentBreakdown = summed.breakdown;
          } else {
            const raw = transferQtyMap[p.id];
            if (raw !== undefined && raw !== '') {
              qty = Number(raw);
              if (Number.isNaN(qty) || qty < 0) {
                throw new Error(`الكمية المرسلة للصنف "${p.name}" غير صالحة.`);
              }
            }
          }

          return {
            product: p,
            sentQty: roundQty(qty),
            sentBreakdown,
          };
        })
        .filter((i) => i.sentQty > 0);
      await createFactoryTransfer(account, currentSession, items, transferNote);
      setTransferQtyMap({});
      setTransferCountsMap({});
      setTransferNote('');
      setConfirmTransferOpen(false);
      setFeedback({
        type: 'success',
        text: 'تم إنشاء التوريد وإرساله إلى قسم الإنتاج بانتظار تأكيد الاستلام.',
      });
    } catch (err) {
      setConfirmTransferOpen(false);
      setFeedback({
        type: 'error',
        text: formatActionError(err, 'تعذر إرسال التوريد.'),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleCreateReturn = async () => {
    if (!account || !currentSession) {
      setConfirmReturnOpen(false);
      setFeedback({
        type: 'error',
        text: sessionError || 'جلسة الجرد اليومية غير متاحة حالياً. يرجى تحديث الصفحة.',
      });
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      const items = approvedProducts
        .map((p) => {
          const units = getEffectiveProductUnits(p);
          const counts = returnCountsMap[p.id];
          let qty = 0;
          let returnedBreakdown: UnitBreakdown | undefined;

          if (counts && Object.keys(counts).length > 0) {
            const summed = sumUnitCounts(units, counts);
            if (summed.hasInvalid) {
              throw new Error(`الكمية المرتجعة للصنف "${p.name}" غير صالحة.`);
            }
            qty = summed.total ?? 0;
            returnedBreakdown = summed.breakdown;
          } else {
            const raw = returnQtyMap[p.id];
            if (raw !== undefined && raw !== '') {
              qty = Number(raw);
              if (Number.isNaN(qty) || qty < 0) {
                throw new Error(`الكمية المرتجعة للصنف "${p.name}" غير صالحة.`);
              }
            }
          }

          return {
            product: p,
            returnedQty: roundQty(qty),
            returnedBreakdown,
          };
        })
        .filter((i) => i.returnedQty > 0);

      for (const item of items) {
        const avail = todayMovement.net[item.product.id] || 0;
        if (item.returnedQty > avail + 0.0001) {
          throw new Error(
            `الكمية المرتجعة للصنف "${item.product.name}" (${item.returnedQty}) تتجاوز الكمية المرحلة المتاحة اليوم (${avail}).`
          );
        }
      }

      await createFactoryReturn(account, currentSession, items, returnNote, products, categories);
      setReturnQtyMap({});
      setReturnCountsMap({});
      setReturnNote('');
      setConfirmReturnOpen(false);
      setFeedback({
        type: 'success',
        text: 'تم تسجيل وسحب الكميات المرتجعة من الإنتاج إلى المعمل وتحديث أرقام اليوم والتقارير بنجاح.',
      });
    } catch (err) {
      setConfirmReturnOpen(false);
      setFeedback({
        type: 'error',
        text: formatActionError(err, 'تعذر تسجيل المرتجع.'),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleProposeProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!account) return;
    setBusy(true);
    setFeedback(null);
    try {
      const catId = newProdCat || categories[0]?.id || '';
      if (!newProdName.trim() || !catId) {
        throw new Error('يرجى إدخال اسم الصنف واختيار المجموعة.');
      }
      const cleanUnit = newProdUnit.trim() || 'نفر';
      const units: ProductUnitOption[] = newProdEnableParts
        ? buildHalvesAndQuartersPreset(cleanUnit)
        : [{ name: cleanUnit, factor: 1 }];
      await proposeProductByFactory(account, {
        name: newProdName,
        categoryId: catId,
        unit: cleanUnit,
        units,
        allowedDepartments: ['factory', 'production', 'sales', 'waste'],
        reason: newProdReason,
      });
      setNewProdModal(false);
      setNewProdName('');
      setNewProdReason('');
      setFeedback({
        type: 'success',
        text: 'تم إرسال الصنف الجديد إلى قسم الإنتاج للمراجعة والاعتماد الفني.',
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: formatActionError(err, 'تعذر اقتراح الصنف.'),
      });
    } finally {
      setBusy(false);
    }
  };

  const openEditTransferModal = async (trf: FactoryTransfer) => {
    setEditingTransfer(trf);
    setEditTransferNote(trf.factoryNote || '');
    setEditTransferQtyMap({});
    setEditTransferCountsMap({});
    setEditTransferLoading(true);
    setFeedback(null);
    try {
      const snap = await getDocs(collection(db, 'factoryTransfers', trf.id, 'items'));
      const nextQty: Record<string, string> = {};
      const nextCounts: Record<string, Record<string, string>> = {};
      snap.forEach((d) => {
        const it = d.data() as FactoryTransferItem;
        if (!it.productId) return;
        const q = roundQty(Number(it.sentQty || 0));
        if (q > 0) {
          nextQty[it.productId] = String(q);
          const prod = productMap.get(it.productId);
          if (prod) {
            nextCounts[it.productId] = decomposeTotalToUnitCounts(
              q,
              getEffectiveProductUnits(prod),
              it.sentBreakdown
            );
          }
        }
      });
      setEditTransferQtyMap(nextQty);
      setEditTransferCountsMap(nextCounts);
    } catch (err) {
      setEditingTransfer(null);
      setFeedback({
        type: 'error',
        text: formatActionError(err, 'تعذر تحميل أصناف التوريد للتعديل.'),
      });
    } finally {
      setEditTransferLoading(false);
    }
  };

  const handleSaveEditTransfer = async () => {
    if (!account || !editingTransfer) return;
    setBusy(true);
    setFeedback(null);
    try {
      const items = approvedProducts
        .map((p) => {
          const units = getEffectiveProductUnits(p);
          const counts = editTransferCountsMap[p.id];
          let qty = 0;
          let sentBreakdown: UnitBreakdown | undefined;

          if (counts && Object.keys(counts).length > 0) {
            const summed = sumUnitCounts(units, counts);
            if (summed.hasInvalid) {
              throw new Error(`الكمية المدخلة للصنف "${p.name}" غير صالحة.`);
            }
            qty = summed.total ?? 0;
            sentBreakdown = summed.breakdown;
          } else {
            const raw = editTransferQtyMap[p.id];
            if (raw !== undefined && raw !== '') {
              qty = Number(raw);
              if (Number.isNaN(qty) || qty < 0) {
                throw new Error(`الكمية المدخلة للصنف "${p.name}" غير صالحة.`);
              }
            }
          }

          return {
            product: p,
            sentQty: roundQty(qty),
            sentBreakdown,
          };
        })
        .filter((i) => i.sentQty > 0);

      await updateFactoryTransfer(account, editingTransfer, items, editTransferNote);
      setEditingTransfer(null);
      setEditTransferQtyMap({});
      setEditTransferCountsMap({});
      setEditTransferNote('');
      setFeedback({
        type: 'success',
        text: 'تم تعديل التوريد وتحديث كمياته بنجاح.',
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: formatActionError(err, 'تعذر تعديل التوريد.'),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmDeleteTransfer = async () => {
    if (!account || !deletingTransfer) return;
    setBusy(true);
    setFeedback(null);
    try {
      const wasReturn =
        deletingTransfer.transferType === 'return' || deletingTransfer.status === 'returned';
      await deleteFactoryTransfer(account, deletingTransfer, products, categories);
      setDeletingTransfer(null);
      setFeedback({
        type: 'success',
        text: wasReturn
          ? 'تم حذف إشعار المرتجع وإعادة الكمية إلى رصيد اليوم بنجاح.'
          : 'تم حذف إشعار التوريد بنجاح.',
      });
    } catch (err) {
      setDeletingTransfer(null);
      setFeedback({
        type: 'error',
        text: formatActionError(err, 'تعذر حذف الإشعار.'),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleExportFactoryTransfersExcel = async () => {
    if (transfers.length === 0) {
      setFeedback({ type: 'error', text: 'لا توجد توريدات مسجلة لهذا اليوم لتصديرها.' });
      return;
    }
    setExportingExcel(true);
    setFeedback(null);
    try {
      const sortedTransfers = [...transfers].sort((a, b) =>
        a.transferNumber.localeCompare(b.transferNumber)
      );
      const transferSnapshots = await Promise.all(
        sortedTransfers.map(async (trf) => {
          const snap = await getDocs(collection(db, 'factoryTransfers', trf.id, 'items'));
          return {
            trf,
            items: snap.docs.map((d) => d.data() as FactoryTransferItem),
          };
        })
      );

      interface ProductSummaryAgg {
        productId: string;
        name: string;
        categoryName: string;
        unit: string;
        sentQty: number;
        sentBreakdown: UnitBreakdown;
        receivedQty: number;
        varianceQty: number;
        returnedQty: number;
      }

      const summaryMap = new Map<string, ProductSummaryAgg>();
      const detailRows: Array<Array<string | number>> = [];

      for (const { trf, items } of transferSnapshots) {
        const isReturn = trf.transferType === 'return' || trf.status === 'returned';
        const movementLabel = isReturn ? 'مرتجع من الإنتاج' : 'توريد للإنتاج';
        const statusLabel = TRANSFER_STATUS_LABELS[trf.status] || trf.status;

        for (const item of items) {
          const prod = productMap.get(item.productId);
          const effectiveUnits = getEffectiveProductUnits(prod);
          const categoryName = prod ? categoryMap.get(prod.categoryId) || '—' : '—';
          const sentQty = roundQty(Number(item.sentQty || 0));
          const receivedQty = isReturn
            ? sentQty
            : trf.status === 'pending_receipt'
            ? 0
            : roundQty(Number(item.receivedQty ?? 0));
          const varianceQty = isReturn
            ? 0
            : trf.status === 'pending_receipt'
            ? 0
            : roundQty(Number(item.varianceQty ?? receivedQty - sentQty));
          const breakdownLabel = formatBreakdownText(item.sentBreakdown, effectiveUnits) || '—';

          detailRows.push([
            trf.transferNumber,
            movementLabel,
            trf.inventoryDate,
            item.productName || prod?.name || 'صنف غير معروف',
            categoryName,
            item.unit || prod?.unit || 'وحدة',
            sentQty,
            breakdownLabel,
            isReturn ? '—' : trf.status === 'pending_receipt' ? 'بانتظار الاستلام' : receivedQty,
            isReturn ? 0 : trf.status === 'pending_receipt' ? '—' : varianceQty,
            statusLabel,
            trf.createdByName || '—',
            trf.receivedByName || '—',
            trf.factoryNote || item.note || '—',
          ]);

          const cur = summaryMap.get(item.productId) || {
            productId: item.productId,
            name: item.productName || prod?.name || 'صنف غير معروف',
            categoryName,
            unit: item.unit || prod?.unit || 'وحدة',
            sentQty: 0,
            sentBreakdown: {},
            receivedQty: 0,
            varianceQty: 0,
            returnedQty: 0,
          };

          if (isReturn) {
            cur.returnedQty = roundQty(cur.returnedQty + sentQty);
          } else {
            cur.sentQty = roundQty(cur.sentQty + sentQty);
            cur.receivedQty = roundQty(cur.receivedQty + receivedQty);
            cur.varianceQty = roundQty(cur.varianceQty + varianceQty);
            if (item.sentBreakdown) {
              for (const [uName, uVal] of Object.entries(item.sentBreakdown)) {
                if (typeof uVal === 'number' && uVal > 0) {
                  cur.sentBreakdown[uName] = roundQty((cur.sentBreakdown[uName] || 0) + uVal);
                }
              }
            }
          }
          summaryMap.set(item.productId, cur);
        }
      }

      const summaryRowsList = Array.from(summaryMap.values()).sort((a, b) =>
        a.name.localeCompare(b.name, 'ar')
      );

      let totalSentAll = 0;
      let totalReceivedAll = 0;
      let totalVarianceAll = 0;
      let totalReturnedAll = 0;
      let totalNetAll = 0;

      const summaryTableRows: Array<Array<string | number>> = summaryRowsList.map((row) => {
        const prod = productMap.get(row.productId);
        const effectiveUnits = getEffectiveProductUnits(prod);
        const netExported = Math.max(0, roundQty(row.sentQty - row.returnedQty));
        totalSentAll = roundQty(totalSentAll + row.sentQty);
        totalReceivedAll = roundQty(totalReceivedAll + row.receivedQty);
        totalVarianceAll = roundQty(totalVarianceAll + row.varianceQty);
        totalReturnedAll = roundQty(totalReturnedAll + row.returnedQty);
        totalNetAll = roundQty(totalNetAll + netExported);

        return [
          row.name,
          row.categoryName,
          row.unit,
          row.sentQty,
          formatBreakdownText(row.sentBreakdown, effectiveUnits) || '—',
          row.receivedQty,
          row.varianceQty,
          row.returnedQty,
          netExported,
        ];
      });

      summaryTableRows.push([
        'الإجمالي الكلي',
        '',
        '',
        totalSentAll,
        '',
        totalReceivedAll,
        totalVarianceAll,
        totalReturnedAll,
        totalNetAll,
      ]);

      const dateLabel = currentSession?.inventoryDate || 'اليوم';
      const wb = XLSX.utils.book_new();

      const summarySheetData = [
        ['شركة مطاعم المذاق اليمني — تقرير المعمل لما تم تصديره للإنتاج'],
        [
          `تاريخ الجرد: ${dateLabel}`,
          `عدد إشعارات التوريد: ${dispatchTransfers.length}`,
          `عدد إشعارات المرتجع: ${returnTransfers.length}`,
        ],
        [],
        [
          'الصنف',
          'المجموعة',
          'الوحدة',
          'إجمالي المرسل للإنتاج',
          'تفصيل وحدات المرسل',
          'المستلم بالإنتاج',
          'فرق التسليم',
          'المرتجع للمعمل',
          'صافي المرحّل للإنتاج',
        ],
        ...summaryTableRows,
      ];
      const wsSummary = XLSX.utils.aoa_to_sheet(summarySheetData);
      wsSummary['!views'] = [{ rightToLeft: true }];
      wsSummary['!cols'] = [
        { wch: 24 },
        { wch: 16 },
        { wch: 12 },
        { wch: 18 },
        { wch: 24 },
        { wch: 16 },
        { wch: 14 },
        { wch: 16 },
        { wch: 18 },
      ];
      XLSX.utils.book_append_sheet(wb, wsSummary, 'ملخص المرسل للإنتاج');

      const detailSheetData = [
        ['شركة مطاعم المذاق اليمني — تفاصيل إشعارات توريد المعمل للإنتاج'],
        [`تاريخ الجرد: ${dateLabel}`],
        [],
        [
          'رقم الإشعار',
          'نوع الحركة',
          'التاريخ',
          'الصنف',
          'المجموعة',
          'الوحدة',
          'الكمية المرسلة',
          'تفصيل الوحدات',
          'الكمية المستلمة',
          'الفرق',
          'الحالة',
          'المرسل',
          'المستلم',
          'ملاحظة',
        ],
        ...detailRows,
      ];
      const wsDetails = XLSX.utils.aoa_to_sheet(detailSheetData);
      wsDetails['!views'] = [{ rightToLeft: true }];
      wsDetails['!cols'] = [
        { wch: 18 },
        { wch: 16 },
        { wch: 13 },
        { wch: 22 },
        { wch: 15 },
        { wch: 11 },
        { wch: 14 },
        { wch: 22 },
        { wch: 16 },
        { wch: 12 },
        { wch: 16 },
        { wch: 18 },
        { wch: 18 },
        { wch: 26 },
      ];
      XLSX.utils.book_append_sheet(wb, wsDetails, 'تفاصيل الإشعارات');

      XLSX.writeFile(wb, `تقرير_توريدات_المعمل_للإنتاج_${dateLabel}.xlsx`);
      setFeedback({
        type: 'success',
        text: 'تم تصدير تقرير المعمل (ما تم تصديره للإنتاج) إلى ملف إكسل بنجاح.',
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: formatActionError(err, 'تعذر تصدير تقرير المعمل إلى إكسل.'),
      });
    } finally {
      setExportingExcel(false);
    }
  };

  const totalDispatchUnits = roundQty(
    Object.values(transferQtyMap).reduce((sum, v) => sum + (Number(v) > 0 ? Number(v) : 0), 0)
  );
  const totalReturnUnits = roundQty(
    Object.values(returnQtyMap).reduce((sum, v) => sum + (Number(v) > 0 ? Number(v) : 0), 0)
  );

  return (
    <div className="space-y-6">
      {/* Header summary */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white border border-zinc-200 rounded-2xl p-5">
        <div>
          <h2 className="text-xl font-bold text-zinc-900 font-display">مساحة عمل المعمل</h2>
          <p className="mt-1 text-sm text-zinc-500">
            تجهيز الكميات اليومية · إنشاء توريدات إلى الإنتاج · اقتراح الأصناف الجديدة للاعتماد
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {report && (
            <StatusBadge
              label={`حالة التقرير: ${REPORT_STATUS_LABELS[report.status]}`}
              tone={report.status === 'draft' ? 'warning' : 'success'}
              icon={report.status === 'draft' ? 'clock' : 'check'}
            />
          )}
          {isAdmin && (
            <button
              type="button"
              onClick={() => setTransferModalOpen(true)}
              className="min-h-[38px] inline-flex items-center gap-1.5 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs font-bold text-zinc-700 hover:border-[#D91B23] hover:text-[#D91B23] cursor-pointer whitespace-nowrap"
              title="نقل بيانات المعمل والتوريدات (حتى بعد الترحيل) إلى تاريخ آخر — للإدارة فقط"
            >
              <ArrowLeftRight className="h-3.5 w-3.5" />
              <span>نقل لتاريخ آخر</span>
            </button>
          )}
          {transfers.length > 0 && (
            <button
              type="button"
              disabled={exportingExcel}
              onClick={() => void handleExportFactoryTransfersExcel()}
              className="min-h-[42px] inline-flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs font-bold text-emerald-900 hover:bg-emerald-100 transition-colors cursor-pointer disabled:opacity-50"
            >
              <FileSpreadsheet className="h-4 w-4 text-emerald-700" />
              <span>{exportingExcel ? 'جاري التصدير...' : 'تصدير إكسل (المرسل للإنتاج)'}</span>
            </button>
          )}
          {!isDeptQtyReadOnly && (
            <button
              type="button"
              onClick={() => setNewProdModal(true)}
              className="min-h-[42px] inline-flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-2 text-xs font-semibold text-zinc-800 hover:bg-zinc-50 cursor-pointer"
            >
              <PackagePlus className="h-4 w-4 text-[#D91B23]" />
              <span>طلب صنف جديد</span>
            </button>
          )}
        </div>
      </div>

      {isDeptQtyReadOnly && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-semibold text-amber-900">
          وضع الاطلاع فقط — صلاحيات إضافة أو تعديل الكميات في المعمل مقتصرة على موظفي المعمل ومخفية عن المدير التنفيذي ومدير الفرع.
        </div>
      )}

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

      {/* Segmented Navigation */}
      <div className="flex flex-wrap items-center gap-1 p-1 bg-zinc-100 rounded-xl w-fit border border-zinc-200">
        <button
          type="button"
          onClick={() => setActiveSubTab('dispatch')}
          className={`min-h-[40px] px-4 py-2 text-xs font-semibold rounded-lg transition-colors cursor-pointer whitespace-nowrap ${
            activeSubTab === 'dispatch'
              ? 'bg-white text-zinc-900 shadow-sm'
              : 'text-zinc-600 hover:text-zinc-900'
          }`}
        >
          التوريدات إلى الإنتاج ({dispatchTransfers.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveSubTab('returns')}
          className={`min-h-[40px] px-4 py-2 text-xs font-semibold rounded-lg transition-colors cursor-pointer whitespace-nowrap ${
            activeSubTab === 'returns'
              ? 'bg-white text-zinc-900 shadow-sm'
              : 'text-zinc-600 hover:text-zinc-900'
          }`}
        >
          المرتجعات من الإنتاج ({returnTransfers.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveSubTab('prepared')}
          className={`min-h-[40px] px-4 py-2 text-xs font-semibold rounded-lg transition-colors cursor-pointer whitespace-nowrap ${
            activeSubTab === 'prepared'
              ? 'bg-white text-zinc-900 shadow-sm'
              : 'text-zinc-600 hover:text-zinc-900'
          }`}
        >
          تقرير الكميات المجهزة ({enteredPreparedCount})
        </button>
        <button
          type="button"
          onClick={() => setActiveSubTab('proposals')}
          className={`min-h-[40px] px-4 py-2 text-xs font-semibold rounded-lg transition-colors cursor-pointer whitespace-nowrap ${
            activeSubTab === 'proposals'
              ? 'bg-white text-zinc-900 shadow-sm'
              : 'text-zinc-600 hover:text-zinc-900'
          }`}
        >
          الأصناف المقترحة ({proposedProducts.length})
        </button>
      </div>

      {/* Filters */}
      {activeSubTab !== 'proposals' && (
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="h-4 w-4 text-zinc-400 absolute right-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="ابحث عن صنف بالاسم..."
              className="w-full min-h-[44px] rounded-xl border border-zinc-200 bg-white pr-10 pl-4 text-sm text-zinc-900 focus:outline-none focus:border-[#D91B23]"
            />
          </div>
          <select
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            className="min-h-[44px] rounded-xl border border-zinc-200 bg-white px-4 text-sm text-zinc-800 focus:outline-none focus:border-[#D91B23]"
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
      )}

      {/* TAB 1: Factory Dispatch Transfers */}
      {activeSubTab === 'dispatch' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-7 bg-white border border-zinc-200 rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-zinc-100 flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-zinc-900 font-display">
                  {isDeptQtyReadOnly ? 'قائمة أصناف المعمل المعتمدة (اطلاع فقط)' : 'إنشاء توريد جديد إلى الإنتاج'}
                </h3>
                <p className="text-xs text-zinc-500">
                  {isDeptQtyReadOnly
                    ? 'استعراض أصناف المعمل ووحداتها؛ التوريدات تُنشأ من حساب موظف المعمل فقط'
                    : 'حدد الكمية المرسلة لكل صنف ليصل إشعار الاستلام لقسم الإنتاج فوراً'}
                </p>
              </div>
              {!isDeptQtyReadOnly && (
                <span className="text-xs font-semibold text-zinc-700 tabular-nums">
                  الإجمالي: {totalDispatchUnits} وحدة
                </span>
              )}
            </div>

            <div className="overflow-x-auto max-h-[460px] overflow-y-auto">
              <table className="w-full text-right">
                <thead className="bg-zinc-50 border-b border-zinc-200 text-xs text-zinc-500 sticky top-0 z-10">
                  <tr>
                    <th className="px-5 py-3 font-semibold">الصنف</th>
                    <th className="px-4 py-3 font-semibold">المجموعة</th>
                    <th className="px-4 py-3 font-semibold">الوحدة</th>
                    {!isDeptQtyReadOnly && (
                      <th className="px-4 py-3 font-semibold text-center">الكمية المرسلة</th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 text-sm">
                  {filteredProducts.map((prod) => {
                    const effectiveUnits = getEffectiveProductUnits(prod);
                    const totalStr = transferQtyMap[prod.id] || '';
                    const counts =
                      transferCountsMap[prod.id] ??
                      (totalStr !== ''
                        ? decomposeTotalToUnitCounts(Number(totalStr), effectiveUnits)
                        : {});
                    return (
                    <tr key={prod.id} className="hover:bg-zinc-50/70">
                      <td className="px-5 py-3 font-semibold text-zinc-900">{prod.name}</td>
                      <td className="px-4 py-3 text-zinc-600">
                        {categoryMap.get(prod.categoryId) || '—'}
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-xs font-semibold text-zinc-800">{prod.unit}</div>
                        {effectiveUnits.length > 1 && (
                          <div className="text-[11px] text-zinc-500">
                            {formatUnitsSummary(effectiveUnits)}
                          </div>
                        )}
                      </td>
                      {!isDeptQtyReadOnly && (
                        <td className="px-4 py-3">
                          <MultiUnitQtyInput
                            product={prod}
                            counts={counts}
                            totalValue={totalStr}
                            disabled={isSessionClosed}
                            onChange={(nextCounts, nextTotalStr) => {
                              setTransferCountsMap((prev) => ({ ...prev, [prod.id]: nextCounts }));
                              setTransferQtyMap((prev) => ({ ...prev, [prod.id]: nextTotalStr }));
                            }}
                          />
                        </td>
                      )}
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {!isDeptQtyReadOnly && (
              <div className="p-5 border-t border-zinc-100 bg-zinc-50/50 space-y-3">
                <input
                  type="text"
                  value={transferNote}
                  onChange={(e) => setTransferNote(e.target.value)}
                  disabled={isSessionClosed}
                  placeholder="ملاحظة التوريد (اختياري)..."
                  className="w-full min-h-[42px] rounded-xl border border-zinc-200 bg-white px-4 text-sm focus:outline-none focus:border-[#D91B23]"
                />
                <button
                  type="button"
                  disabled={isSessionClosed || totalDispatchUnits <= 0 || busy}
                  onClick={() => setConfirmTransferOpen(true)}
                  className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl bg-[#D91B23] px-5 py-2.5 text-sm font-bold text-white hover:bg-[#B9141B] transition-colors cursor-pointer disabled:opacity-50"
                >
                  <Truck className="h-4 w-4" />
                  <span>إرسال التوريد إلى قسم الإنتاج</span>
                </button>
              </div>
            )}
          </div>

          {/* Transfer Status History */}
          <div className="lg:col-span-5 bg-white border border-zinc-200 rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-zinc-100">
              <h3 className="text-base font-bold text-zinc-900 font-display">
                سجل توريدات اليوم وحالات الاستلام
              </h3>
            </div>
            {dispatchTransfers.length === 0 ? (
              <div className="p-8 text-center text-sm text-zinc-500">
                لم يتم إرسال توريدات في تاريخ الجرد المحدد بعد.
              </div>
            ) : (
              <div className="divide-y divide-zinc-100">
                {dispatchTransfers.map((trf) => (
                  <div key={trf.id} className="p-4 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs font-bold text-zinc-900">
                        {trf.transferNumber}
                      </span>
                      <StatusBadge
                        label={TRANSFER_STATUS_LABELS[trf.status]}
                        tone={
                          trf.status === 'pending_receipt'
                            ? 'warning'
                            : trf.status === 'received'
                            ? 'success'
                            : 'danger'
                        }
                        icon={
                          trf.status === 'pending_receipt'
                            ? 'clock'
                            : trf.status === 'received'
                            ? 'check'
                            : 'alert'
                        }
                      />
                    </div>
                    <div className="flex items-center justify-between text-xs text-zinc-600 tabular-nums">
                      <span>المرسل: {trf.totalSentQty}</span>
                      <span>
                        المستلم: {trf.status === 'pending_receipt' ? '—' : trf.totalReceivedQty}
                      </span>
                      <span>
                        فرق التسليم:{' '}
                        {trf.status === 'pending_receipt' ? '—' : trf.totalVarianceQty}
                      </span>
                    </div>
                    <div className="text-[11px] text-zinc-400">
                      وقت الإرسال: {formatTimestampAden(trf.createdAt)}
                      {trf.receivedByName ? ` · المستلم: ${trf.receivedByName}` : ''}
                    </div>
                    {trf.factoryNote && (
                      <div className="text-xs text-zinc-600">{trf.factoryNote}</div>
                    )}
                    {!isDeptQtyReadOnly && !isSessionClosed && trf.status === 'pending_receipt' && (
                      <div className="pt-2 border-t border-zinc-100 flex items-center justify-end gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void openEditTransferModal(trf)}
                          className="min-h-[34px] inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-1 text-xs font-semibold text-zinc-800 hover:bg-zinc-100 cursor-pointer disabled:opacity-50"
                        >
                          <Edit3 className="h-3.5 w-3.5" />
                          <span>تعديل</span>
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setDeletingTransfer(trf)}
                          className="min-h-[34px] inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-1 text-xs font-semibold text-red-700 hover:bg-red-100 cursor-pointer disabled:opacity-50"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          <span>حذف</span>
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 1B: Returns from Production to Factory */}
      {activeSubTab === 'returns' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-7 bg-white border border-zinc-200 rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-zinc-100 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-base font-bold text-zinc-900 font-display">
                  {isDeptQtyReadOnly
                    ? 'مرتجعات الإنتاج إلى المعمل (اطلاع فقط)'
                    : 'الكميات المرتجعة من الإنتاج إلى المعمل'}
                </h3>
                <p className="text-xs text-zinc-500">
                  أدخل الكميات المرتجعة ليتم سحبها وإنقاصها تلقائياً من الكمية المرحلة في نفس اليوم والتقارير
                </p>
              </div>
              {!isDeptQtyReadOnly && (
                <span className="text-xs font-semibold text-zinc-700 tabular-nums shrink-0">
                  إجمالي المرتجع: {totalReturnUnits} وحدة
                </span>
              )}
            </div>

            {dispatchTransfers.length === 0 ? (
              <div className="p-8 text-center text-sm text-zinc-500">
                لا توجد كميات مرحلة من المعمل إلى الإنتاج لهذا اليوم بعد؛ أرسل توريداً أولاً لتتمكن
                من سحب كميات مرتجعة.
              </div>
            ) : (
              <>
                <div className="overflow-x-auto max-h-[460px] overflow-y-auto">
                  <table className="w-full text-right">
                    <thead className="bg-zinc-50 border-b border-zinc-200 text-xs text-zinc-500 sticky top-0 z-10">
                      <tr>
                        <th className="px-5 py-3 font-semibold">الصنف</th>
                        <th className="px-4 py-3 font-semibold">المرحّل المتاح اليوم</th>
                        <th className="px-4 py-3 font-semibold">الوحدة</th>
                        {!isDeptQtyReadOnly && (
                          <th className="px-4 py-3 font-semibold text-center">الكمية المرتجعة</th>
                        )}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-100 text-sm">
                      {filteredProducts.map((prod) => {
                        const effectiveUnits = getEffectiveProductUnits(prod);
                        const sentToday = todayMovement.sent[prod.id] || 0;
                        const returnedToday = todayMovement.returned[prod.id] || 0;
                        const netAvailable = todayMovement.net[prod.id] || 0;
                        const totalStr = returnQtyMap[prod.id] || '';
                        const counts =
                          returnCountsMap[prod.id] ??
                          (totalStr !== ''
                            ? decomposeTotalToUnitCounts(Number(totalStr), effectiveUnits)
                            : {});
                        const exceeds = Number(totalStr || 0) > netAvailable + 0.0001;

                        return (
                          <tr
                            key={prod.id}
                            className={
                              sentToday === 0 ? 'opacity-60 hover:bg-zinc-50/50' : 'hover:bg-zinc-50/70'
                            }
                          >
                            <td className="px-5 py-3">
                              <div className="font-semibold text-zinc-900">{prod.name}</div>
                              <div className="text-[11px] text-zinc-500">
                                {categoryMap.get(prod.categoryId) || '—'}
                              </div>
                            </td>
                            <td className="px-4 py-3 tabular-nums">
                              <div className="font-bold text-zinc-900">{netAvailable}</div>
                              {sentToday > 0 && (
                                <div className="text-[11px] text-zinc-500">
                                  مرسل {sentToday}
                                  {returnedToday > 0 ? ` · مرتجع ${returnedToday}` : ''}
                                </div>
                              )}
                            </td>
                            <td className="px-4 py-3">
                              <div className="text-xs font-semibold text-zinc-800">{prod.unit}</div>
                              {effectiveUnits.length > 1 && (
                                <div className="text-[11px] text-zinc-500">
                                  {formatUnitsSummary(effectiveUnits)}
                                </div>
                              )}
                            </td>
                            {!isDeptQtyReadOnly && (
                              <td className="px-4 py-3">
                                <MultiUnitQtyInput
                                  product={prod}
                                  counts={counts}
                                  totalValue={totalStr}
                                  disabled={isSessionClosed || netAvailable <= 0}
                                  onChange={(nextCounts, nextTotalStr) => {
                                    setReturnCountsMap((prev) => ({
                                      ...prev,
                                      [prod.id]: nextCounts,
                                    }));
                                    setReturnQtyMap((prev) => ({
                                      ...prev,
                                      [prod.id]: nextTotalStr,
                                    }));
                                  }}
                                />
                                {exceeds && (
                                  <div className="mt-1 text-[11px] font-semibold text-red-600 text-center">
                                    يتجاوز المتاح ({netAvailable})
                                  </div>
                                )}
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {!isDeptQtyReadOnly && (
                  <div className="p-5 border-t border-zinc-100 bg-zinc-50/50 space-y-3">
                    <input
                      type="text"
                      value={returnNote}
                      onChange={(e) => setReturnNote(e.target.value)}
                      disabled={isSessionClosed}
                      placeholder="سبب أو ملاحظة المرتجع (اختياري)..."
                      className="w-full min-h-[42px] rounded-xl border border-zinc-200 bg-white px-4 text-sm focus:outline-none focus:border-[#D91B23]"
                    />
                    <button
                      type="button"
                      disabled={isSessionClosed || totalReturnUnits <= 0 || busy}
                      onClick={() => setConfirmReturnOpen(true)}
                      className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl bg-[#D91B23] px-5 py-2.5 text-sm font-bold text-white hover:bg-[#B9141B] transition-colors cursor-pointer disabled:opacity-50"
                    >
                      <RotateCcw className="h-4 w-4" />
                      <span>سحب المرتجع وإنقاصه من كميات اليوم</span>
                    </button>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Return History */}
          <div className="lg:col-span-5 bg-white border border-zinc-200 rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-zinc-100">
              <h3 className="text-base font-bold text-zinc-900 font-display">
                سجل مرتجعات اليوم المسحوبة
              </h3>
            </div>
            {returnTransfers.length === 0 ? (
              <div className="p-8 text-center text-sm text-zinc-500">
                لم يتم تسجيل أي مرتجعات من الإنتاج إلى المعمل اليوم.
              </div>
            ) : (
              <div className="divide-y divide-zinc-100">
                {returnTransfers.map((trf) => (
                  <div key={trf.id} className="p-4 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs font-bold text-zinc-900">
                        {trf.transferNumber}
                      </span>
                      <StatusBadge
                        label={TRANSFER_STATUS_LABELS[trf.status]}
                        tone="warning"
                        icon="check"
                      />
                    </div>
                    <div className="flex items-center justify-between text-xs text-zinc-700 tabular-nums">
                      <span>الكمية المرتجعة المسحوبة: <strong>{trf.totalSentQty}</strong></span>
                      <span className="text-emerald-700 font-semibold">تم الخصم من اليوم</span>
                    </div>
                    {trf.factoryNote && (
                      <div className="text-xs text-zinc-600">{trf.factoryNote}</div>
                    )}
                    <div className="text-[11px] text-zinc-400">
                      وقت السحب: {formatTimestampAden(trf.createdAt)} · بواسطة: {trf.createdByName}
                    </div>
                    {!isDeptQtyReadOnly && !isSessionClosed && (
                      <div className="pt-2 border-t border-zinc-100 flex items-center justify-end">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setDeletingTransfer(trf)}
                          className="min-h-[34px] inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-1 text-xs font-semibold text-red-700 hover:bg-red-100 cursor-pointer disabled:opacity-50"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          <span>حذف المرتجع</span>
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: Prepared Quantities Report */}
      {activeSubTab === 'prepared' && (
        <div className="bg-white border border-zinc-200 rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-100 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-bold text-zinc-900 font-display">
                تقرير الكميات المجهزة بالمعمل
              </h3>
              <p className="text-xs text-zinc-500">
                اترك الحقل فارغاً للأصناف التي لم تجهز اليوم، أو أدخل 0 إذا كانت الكمية صفراً فعلياً
              </p>
            </div>
            {!isDeptQtyReadOnly && !isSessionClosed && (
              <div className="flex flex-wrap items-center gap-2">
                {transfers.length > 0 && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleFillPreparedFromTransfers()}
                    className="min-h-[42px] inline-flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2 text-xs font-semibold text-amber-900 hover:bg-amber-100 cursor-pointer"
                  >
                    <CopyCheck className="h-4 w-4" />
                    <span>تعبئة من التوريدات المرسلة</span>
                  </button>
                )}
                {!isSubmitted ? (
                  <>
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
                      disabled={busy || enteredPreparedCount === 0}
                      onClick={() => setConfirmSubmitOpen(true)}
                      className="min-h-[42px] inline-flex items-center gap-2 rounded-xl bg-[#D91B23] px-4 py-2 text-xs font-bold text-white hover:bg-[#B9141B] cursor-pointer disabled:opacity-50"
                    >
                      <Send className="h-4 w-4" />
                      <span>ترحيل تقرير المعمل</span>
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    disabled={busy || enteredPreparedCount === 0}
                    onClick={() => void handleSubmitReport()}
                    className="min-h-[42px] inline-flex items-center gap-2 rounded-xl bg-[#D91B23] px-4 py-2 text-xs font-bold text-white hover:bg-[#B9141B] cursor-pointer disabled:opacity-50"
                  >
                    <Save className="h-4 w-4" />
                    <span>{busy ? 'جاري التحديث...' : 'حفظ وتحديث التقرير المرحّل'}</span>
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-right">
              <thead className="bg-zinc-50 border-b border-zinc-200 text-xs text-zinc-500">
                <tr>
                  <th className="px-5 py-3 font-semibold">الصنف</th>
                  <th className="px-4 py-3 font-semibold">المجموعة</th>
                  <th className="px-4 py-3 font-semibold">الوحدة</th>
                  <th className="px-4 py-3 font-semibold">الكمية المجهزة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 text-sm">
                {filteredProducts.map((prod) => {
                  const effectiveUnits = getEffectiveProductUnits(prod);
                  const totalStr = preparedMap[prod.id] ?? '';
                  const counts =
                    preparedCountsMap[prod.id] ??
                    (totalStr !== ''
                      ? decomposeTotalToUnitCounts(Number(totalStr), effectiveUnits)
                      : {});
                  return (
                  <tr key={prod.id} className="hover:bg-zinc-50/70">
                    <td className="px-5 py-3 font-semibold text-zinc-900">{prod.name}</td>
                    <td className="px-4 py-3 text-zinc-600">
                      {categoryMap.get(prod.categoryId) || '—'}
                    </td>
                    <td className="px-4 py-3 text-zinc-600">
                      <div className="font-medium text-zinc-800">{prod.unit}</div>
                      {effectiveUnits.length > 1 && (
                        <div className="text-[11px] text-zinc-500">
                          {formatUnitsSummary(effectiveUnits)}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <MultiUnitQtyInput
                        product={prod}
                        counts={counts}
                        totalValue={totalStr}
                        readOnly={isDeptQtyReadOnly}
                        disabled={isSessionClosed}
                        placeholder="لم يُدخل"
                        onChange={(nextCounts, nextTotalStr) => {
                          setPreparedCountsMap((prev) => ({ ...prev, [prod.id]: nextCounts }));
                          setPreparedMap((prev) => ({ ...prev, [prod.id]: nextTotalStr }));
                        }}
                      />
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 3: Proposed Products */}
      {activeSubTab === 'proposals' && (
        <div className="bg-white border border-zinc-200 rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-100 flex items-center justify-between">
            <h3 className="text-base font-bold text-zinc-900 font-display">
              طلبات اعتماد الأصناف المرسلة من المعمل
            </h3>
            {!isDeptQtyReadOnly && (
              <button
                type="button"
                onClick={() => setNewProdModal(true)}
                className="min-h-[38px] inline-flex items-center gap-1.5 rounded-xl bg-[#18181B] px-3.5 py-1.5 text-xs font-semibold text-white cursor-pointer"
              >
                <Plus className="h-4 w-4" />
                <span>صنف جديد</span>
              </button>
            )}
          </div>
          {proposedProducts.length === 0 ? (
            <div className="p-8 text-center text-sm text-zinc-500">
              لم تقم باقتراح أي أصناف جديدة بعد.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-right">
                <thead className="bg-zinc-50 border-b border-zinc-200 text-xs text-zinc-500">
                  <tr>
                    <th className="px-5 py-3 font-semibold">الصنف</th>
                    <th className="px-4 py-3 font-semibold">المجموعة</th>
                    <th className="px-4 py-3 font-semibold">الوحدة</th>
                    <th className="px-4 py-3 font-semibold">الحالة</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 text-sm">
                  {proposedProducts.map((p) => (
                    <tr key={p.id} className="hover:bg-zinc-50/70">
                      <td className="px-5 py-3">
                        <div className="font-bold text-zinc-900">{p.name}</div>
                        {p.rejectionReason && (
                          <div className="text-xs text-red-600 mt-0.5">
                            سبب الرفض: {p.rejectionReason}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-zinc-600">
                        {categoryMap.get(p.categoryId) || '—'}
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1 text-xs font-semibold text-zinc-700">
                          {p.unit}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge
                          label={PRODUCT_APPROVAL_LABELS[p.approvalStatus]}
                          tone={
                            p.approvalStatus === 'approved'
                              ? 'success'
                              : p.approvalStatus === 'rejected'
                              ? 'danger'
                              : 'warning'
                          }
                          icon={
                            p.approvalStatus === 'approved'
                              ? 'check'
                              : p.approvalStatus === 'rejected'
                              ? 'error'
                              : 'clock'
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Modals */}
      <ConfirmDialog
        open={confirmTransferOpen}
        title="تأكيد إرسال التوريد إلى الإنتاج"
        description={`سيتم إرسال توريد بإجمالي ${totalDispatchUnits} وحدة إلى قسم الإنتاج لتاريخ ${currentSession?.inventoryDate || ''}.`}
        confirmLabel="إرسال التوريد"
        busy={busy}
        onConfirm={() => void handleCreateTransfer()}
        onCancel={() => setConfirmTransferOpen(false)}
      />

      <ConfirmDialog
        open={confirmReturnOpen}
        title="تأكيد سحب الكمية المرتجعة من الإنتاج"
        description={`سيتم تسجيل مرتجع بإجمالي ${totalReturnUnits} وحدة من الإنتاج إلى المعمل وإنقاصه تلقائياً من الكميات المرحلة ليوم ${currentSession?.inventoryDate || ''} في التقارير.`}
        confirmLabel="سحب المرتجع واعتماد الخصم"
        variant="danger"
        busy={busy}
        onConfirm={() => void handleCreateReturn()}
        onCancel={() => setConfirmReturnOpen(false)}
      />

      <ConfirmDialog
        open={confirmSubmitOpen}
        title="تأكيد ترحيل تقرير المعمل"
        description="سيتم ترحيل تقرير الكميات المجهزة بالمعمل واعتماده في حسابات اليوم، ويمكن للمعمل تعديله وتحديثه مباشرة في أي وقت قبل إغلاق اليوم."
        confirmLabel="ترحيل التقرير"
        busy={busy}
        onConfirm={() => void handleSubmitReport()}
        onCancel={() => setConfirmSubmitOpen(false)}
      />

      <ConfirmDialog
        open={Boolean(deletingTransfer)}
        title={
          deletingTransfer?.transferType === 'return' || deletingTransfer?.status === 'returned'
            ? 'تأكيد حذف إشعار المرتجع'
            : 'تأكيد حذف إشعار التوريد'
        }
        description={
          deletingTransfer
            ? deletingTransfer.transferType === 'return' || deletingTransfer.status === 'returned'
              ? `سيتم حذف إشعار المرتجع (${deletingTransfer.transferNumber}) وإرجاع كميته (${deletingTransfer.totalSentQty}) إلى صافي الكمية المرحلة لليوم.`
              : `سيتم حذف إشعار التوريد (${deletingTransfer.transferNumber}) بإجمالي ${deletingTransfer.totalSentQty} وحدة نهائياً قبل استلامه.`
            : ''
        }
        confirmLabel="حذف الإشعار"
        variant="danger"
        busy={busy}
        onConfirm={() => void handleConfirmDeleteTransfer()}
        onCancel={() => setDeletingTransfer(null)}
      />

      {newProdModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <form
            onSubmit={handleProposeProduct}
            className="w-full max-w-md rounded-2xl bg-white border border-zinc-200 p-6 space-y-4"
          >
            <h3 className="text-lg font-bold text-zinc-900 font-display">
              اقتراح صنف جديد للاعتماد
            </h3>
            <p className="text-xs text-zinc-500">
              يمر الصنف بالاعتماد الفني من الإنتاج ثم الاعتماد الإداري من الإدارة العليا قبل تفعيله.
            </p>
            <div>
              <label className="block text-xs font-semibold text-zinc-700 mb-1">اسم الصنف</label>
              <input
                type="text"
                required
                value={newProdName}
                onChange={(e) => setNewProdName(e.target.value)}
                placeholder="مثال: برمة لحم بالخضار"
                className="w-full min-h-[42px] rounded-xl border border-zinc-200 px-3 text-sm focus:outline-none focus:border-[#D91B23]"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-zinc-700 mb-1">المجموعة</label>
                <select
                  value={newProdCat || categories[0]?.id || ''}
                  onChange={(e) => setNewProdCat(e.target.value)}
                  className="w-full min-h-[42px] rounded-xl border border-zinc-200 px-3 text-sm"
                >
                  {categories
                    .filter((c) => c.isActive)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-700 mb-1">وحدة القياس</label>
                <input
                  type="text"
                  required
                  value={newProdUnit}
                  onChange={(e) => setNewProdUnit(e.target.value)}
                  placeholder="نفر / حبة / صحن"
                  className="w-full min-h-[42px] rounded-xl border border-zinc-200 px-3 text-sm"
                />
              </div>
            </div>
            <label className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-700 cursor-pointer">
              <input
                type="checkbox"
                checked={newProdEnableParts}
                onChange={(e) => setNewProdEnableParts(e.target.checked)}
                className="h-4 w-4 rounded border-zinc-300 text-[#D91B23]"
              />
              <span>إضافة وحدات فرعية (نص وربع) لهذا الصنف</span>
            </label>
            <div>
              <label className="block text-xs font-semibold text-zinc-700 mb-1">ملاحظة للإنتاج</label>
              <input
                type="text"
                value={newProdReason}
                onChange={(e) => setNewProdReason(e.target.value)}
                placeholder="وصف مختصر للصنف الجديد"
                className="w-full min-h-[42px] rounded-xl border border-zinc-200 px-3 text-sm"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setNewProdModal(false)}
                className="min-h-[40px] px-4 rounded-xl border border-zinc-200 text-xs font-semibold text-zinc-700 cursor-pointer"
              >
                إلغاء
              </button>
              <button
                type="submit"
                disabled={busy}
                className="min-h-[40px] px-5 rounded-xl bg-[#D91B23] text-xs font-bold text-white cursor-pointer"
              >
                {busy ? 'جاري الإرسال...' : 'إرسال للاعتماد الفني'}
              </button>
            </div>
          </form>
        </div>
      )}

      {editingTransfer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-2xl rounded-2xl bg-white border border-zinc-200 overflow-hidden flex flex-col max-h-[90vh]">
            <div className="px-5 py-4 border-b border-zinc-100 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-base font-bold text-zinc-900 font-display">
                  تعديل إشعار التوريد — <span className="font-mono">{editingTransfer.transferNumber}</span>
                </h3>
                <p className="text-xs text-zinc-500">
                  عدّل الكميات أو الملاحظة قبل تأكيد الاستلام من قسم الإنتاج
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditingTransfer(null)}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg border border-zinc-200 text-zinc-500 hover:bg-zinc-50 cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {editTransferLoading ? (
              <div className="p-8 text-center text-sm text-zinc-500">
                جاري تحميل تفاصيل الإشعار...
              </div>
            ) : (
              <>
                <div className="overflow-y-auto flex-1">
                  <table className="w-full text-right">
                    <thead className="bg-zinc-50 border-b border-zinc-200 text-xs text-zinc-500 sticky top-0 z-10">
                      <tr>
                        <th className="px-5 py-3 font-semibold">الصنف</th>
                        <th className="px-4 py-3 font-semibold">الوحدة</th>
                        <th className="px-4 py-3 font-semibold text-center">الكمية المرسلة</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-100 text-sm">
                      {approvedProducts.map((prod) => {
                        const effectiveUnits = getEffectiveProductUnits(prod);
                        const totalStr = editTransferQtyMap[prod.id] || '';
                        const counts =
                          editTransferCountsMap[prod.id] ??
                          (totalStr !== ''
                            ? decomposeTotalToUnitCounts(Number(totalStr), effectiveUnits)
                            : {});
                        return (
                          <tr key={prod.id} className="hover:bg-zinc-50/70">
                            <td className="px-5 py-3">
                              <div className="font-semibold text-zinc-900">{prod.name}</div>
                              <div className="text-[11px] text-zinc-500">
                                {categoryMap.get(prod.categoryId) || '—'}
                              </div>
                            </td>
                            <td className="px-4 py-3 text-xs font-semibold text-zinc-700">
                              {prod.unit}
                            </td>
                            <td className="px-4 py-3">
                              <MultiUnitQtyInput
                                product={prod}
                                counts={counts}
                                totalValue={totalStr}
                                disabled={busy}
                                onChange={(nextCounts, nextTotalStr) => {
                                  setEditTransferCountsMap((prev) => ({
                                    ...prev,
                                    [prod.id]: nextCounts,
                                  }));
                                  setEditTransferQtyMap((prev) => ({
                                    ...prev,
                                    [prod.id]: nextTotalStr,
                                  }));
                                }}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="p-5 border-t border-zinc-100 bg-zinc-50/60 space-y-3">
                  <input
                    type="text"
                    value={editTransferNote}
                    onChange={(e) => setEditTransferNote(e.target.value)}
                    placeholder="ملاحظة التوريد (اختياري)..."
                    className="w-full min-h-[42px] rounded-xl border border-zinc-200 bg-white px-4 text-sm focus:outline-none focus:border-[#D91B23]"
                  />
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-zinc-600 tabular-nums">
                      الإجمالي الجديد:{' '}
                      {roundQty(
                        Object.values(editTransferQtyMap).reduce(
                          (sum, v) => sum + (Number(v) > 0 ? Number(v) : 0),
                          0
                        )
                      )}{' '}
                      وحدة
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setEditingTransfer(null)}
                        className="min-h-[40px] px-4 rounded-xl border border-zinc-200 bg-white text-xs font-semibold text-zinc-700 cursor-pointer"
                      >
                        إلغاء
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleSaveEditTransfer()}
                        className="min-h-[40px] px-5 rounded-xl bg-[#D91B23] text-xs font-bold text-white hover:bg-[#B9141B] cursor-pointer disabled:opacity-50"
                      >
                        {busy ? 'جاري الحفظ...' : 'حفظ تعديلات التوريد'}
                      </button>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      <ReportDateTransferModal
        open={transferModalOpen}
        initialDepartment="factory"
        initialFromDate={inventoryDate}
        initialToDate={getPreviousAdenDate(inventoryDate)}
        onClose={() => setTransferModalOpen(false)}
        onSuccess={(msg) => setFeedback({ type: 'success', text: msg })}
      />
    </div>
  );
};
