import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Edit3, FolderPlus, PackagePlus, X, XCircle } from 'lucide-react';
import {
  DEPARTMENT_LABELS,
  OPERATIONAL_DEPARTMENTS,
  PRODUCT_APPROVAL_LABELS,
} from '../../constants/departments';
import { useFirebase } from '../../app/providers/FirebaseProvider';
import {
  adminReviewProduct,
  createCategory,
  createProductByAdmin,
  formatActionError,
  updateCategory,
  updateProductByAdmin,
} from '../../services/inventory/firestoreService';
import type { Category, OperationalDepartmentId, Product } from '../../types/inventory';
import { StatusBadge } from '../../components/common/StatusBadge';

export const CatalogManagement: React.FC = () => {
  const { account, categories, products } = useFirebase();

  const catInputRef = useRef<HTMLInputElement>(null);
  const editProdInputRef = useRef<HTMLInputElement>(null);

  const [catName, setCatName] = useState('');
  const [catOrder, setCatOrder] = useState('1');
  const [editingCat, setEditingCat] = useState<Category | null>(null);

  // Add new product form state
  const [prodName, setProdName] = useState('');
  const [prodCatId, setProdCatId] = useState('');
  const [prodUnit, setProdUnit] = useState('نفر');
  const [prodDepts, setProdDepts] = useState<OperationalDepartmentId[]>([
    'factory',
    'production',
    'sales',
    'waste',
  ]);

  // Edit product modal state
  const [editingProd, setEditingProd] = useState<Product | null>(null);
  const [editProdName, setEditProdName] = useState('');
  const [editProdCatId, setEditProdCatId] = useState('');
  const [editProdUnit, setEditProdUnit] = useState('');
  const [editProdIsActive, setEditProdIsActive] = useState(true);
  const [editProdDepts, setEditProdDepts] = useState<OperationalDepartmentId[]>([]);
  const [editModalError, setEditModalError] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const nextCategoryOrder = useMemo(() => {
    if (categories.length === 0) return 1;
    const maxOrder = categories.reduce(
      (max, c) => (Number.isFinite(c.sortOrder) && c.sortOrder > max ? c.sortOrder : max),
      0
    );
    return Math.max(categories.length + 1, maxOrder + 1);
  }, [categories]);

  useEffect(() => {
    if (!editingCat) {
      setCatOrder(String(nextCategoryOrder));
    }
  }, [nextCategoryOrder, editingCat]);

  useEffect(() => {
    if (editingProd) {
      setTimeout(() => {
        editProdInputRef.current?.focus();
        editProdInputRef.current?.select();
      }, 20);
    }
  }, [editingProd?.id]);

  const categoryMap = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories]);
  const productCountByCategory = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of products) {
      counts.set(p.categoryId, (counts.get(p.categoryId) || 0) + 1);
    }
    return counts;
  }, [products]);

  const pendingAdminProducts = useMemo(
    () => products.filter((p) => p.approvalStatus === 'pending_admin'),
    [products]
  );

  const toggleDept = (dept: OperationalDepartmentId) => {
    setProdDepts((prev) =>
      prev.includes(dept) ? prev.filter((d) => d !== dept) : [...prev, dept]
    );
  };

  const toggleEditDept = (dept: OperationalDepartmentId) => {
    setEditProdDepts((prev) =>
      prev.includes(dept) ? prev.filter((d) => d !== dept) : [...prev, dept]
    );
  };

  const openEditProductModal = (prod: Product) => {
    setEditingProd(prod);
    setEditProdName(prod.name);
    setEditProdCatId(prod.categoryId || categories[0]?.id || '');
    setEditProdUnit(prod.unit || 'نفر');
    setEditProdIsActive(prod.isActive);
    setEditProdDepts(
      prod.allowedDepartments && prod.allowedDepartments.length > 0
        ? [...prod.allowedDepartments]
        : ['factory', 'production', 'sales', 'waste']
    );
    setEditModalError(null);
  };

  const handleSaveCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!account) return;
    const trimmed = catName.trim();
    if (!trimmed) {
      setFeedback({ type: 'error', text: 'يرجى إدخال اسم المجموعة أولاً.' });
      return;
    }

    const normalized = trimmed.toLowerCase();
    const duplicate = categories.find(
      (c) => c.name.trim().toLowerCase() === normalized && c.id !== editingCat?.id
    );
    if (duplicate) {
      setFeedback({ type: 'error', text: `المجموعة "${trimmed}" مسجلة بالفعل.` });
      return;
    }

    const parsedOrder = Number(catOrder);
    const resolvedOrder =
      catOrder.trim() !== '' && Number.isFinite(parsedOrder) && parsedOrder >= 0
        ? Math.min(999999, Math.floor(parsedOrder))
        : editingCat
        ? editingCat.sortOrder
        : nextCategoryOrder;

    setBusy(true);
    setFeedback(null);
    try {
      if (editingCat) {
        await updateCategory(account, editingCat, {
          name: trimmed,
          sortOrder: resolvedOrder,
          isActive: editingCat.isActive,
        });
        setEditingCat(null);
        setFeedback({ type: 'success', text: `تم تحديث بيانات المجموعة "${trimmed}" بنجاح.` });
      } else {
        await createCategory(account, trimmed, resolvedOrder);
        setFeedback({ type: 'success', text: `تمت إضافة المجموعة "${trimmed}" بنجاح.` });
      }
      setCatName('');
    } catch (err) {
      setFeedback({ type: 'error', text: formatActionError(err, 'تعذر حفظ المجموعة.') });
    } finally {
      setBusy(false);
    }
  };

  const handleToggleCategory = async (cat: Category) => {
    if (!account) return;
    setBusy(true);
    setFeedback(null);
    try {
      await updateCategory(account, cat, {
        name: cat.name,
        sortOrder: cat.sortOrder,
        isActive: !cat.isActive,
      });
      setFeedback({
        type: 'success',
        text: !cat.isActive
          ? `تم تفعيل المجموعة "${cat.name}".`
          : `تم إيقاف المجموعة "${cat.name}".`,
      });
    } catch (err) {
      setFeedback({ type: 'error', text: formatActionError(err, 'تعذر تغيير حالة المجموعة.') });
    } finally {
      setBusy(false);
    }
  };

  const handleCreateProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!account) return;
    const trimmedName = prodName.trim();
    const trimmedUnit = prodUnit.trim();
    if (!trimmedName) {
      setFeedback({ type: 'error', text: 'يرجى إدخال اسم الصنف.' });
      return;
    }
    if (!trimmedUnit) {
      setFeedback({ type: 'error', text: 'يرجى إدخال وحدة القياس.' });
      return;
    }

    const duplicate = products.find(
      (p) => p.name.trim().toLowerCase() === trimmedName.toLowerCase()
    );
    if (duplicate) {
      setFeedback({ type: 'error', text: `الصنف "${trimmedName}" مسجل بالفعل.` });
      return;
    }

    setBusy(true);
    setFeedback(null);
    try {
      const targetCat = prodCatId || categories[0]?.id;
      if (!targetCat) throw new Error('أضف مجموعة أصناف أولاً.');
      if (prodDepts.length === 0) throw new Error('اختر إدارة واحدة على الأقل.');

      await createProductByAdmin(account, {
        name: trimmedName,
        categoryId: targetCat,
        unit: trimmedUnit,
        allowedDepartments: prodDepts,
      });
      setFeedback({ type: 'success', text: `تم إنشاء الصنف "${trimmedName}" واعتماده مباشرة.` });
      setProdName('');
    } catch (err) {
      setFeedback({ type: 'error', text: formatActionError(err, 'تعذر حفظ الصنف.') });
    } finally {
      setBusy(false);
    }
  };

  const handleSaveEditedProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!account || !editingProd) return;

    const trimmedName = editProdName.trim();
    const trimmedUnit = editProdUnit.trim();
    const targetCat = editProdCatId || categories[0]?.id || editingProd.categoryId;

    if (!trimmedName) {
      setEditModalError('يرجى إدخال اسم الصنف.');
      return;
    }
    if (!trimmedUnit) {
      setEditModalError('يرجى إدخال وحدة القياس.');
      return;
    }
    if (!targetCat) {
      setEditModalError('يرجى اختيار المجموعة.');
      return;
    }
    if (editProdDepts.length === 0) {
      setEditModalError('اختر إدارة واحدة على الأقل.');
      return;
    }

    const duplicate = products.find(
      (p) =>
        p.id !== editingProd.id && p.name.trim().toLowerCase() === trimmedName.toLowerCase()
    );
    if (duplicate) {
      setEditModalError(`يوجد صنف آخر بنفس الاسم "${trimmedName}".`);
      return;
    }

    setBusy(true);
    setEditModalError(null);
    setFeedback(null);
    try {
      await updateProductByAdmin(account, editingProd, {
        name: trimmedName,
        categoryId: targetCat,
        unit: trimmedUnit,
        isActive: editProdIsActive,
        allowedDepartments: editProdDepts,
      });
      setEditingProd(null);
      setFeedback({ type: 'success', text: `تم تحديث الصنف "${trimmedName}" بنجاح.` });
    } catch (err) {
      setEditModalError(formatActionError(err, 'تعذر تحديث بيانات الصنف.'));
    } finally {
      setBusy(false);
    }
  };

  const handleToggleProduct = async (prod: Product) => {
    if (!account) return;
    setBusy(true);
    setFeedback(null);
    try {
      await updateProductByAdmin(account, prod, {
        name: prod.name,
        categoryId: prod.categoryId,
        unit: prod.unit || 'نفر',
        isActive: !prod.isActive,
        allowedDepartments:
          prod.allowedDepartments && prod.allowedDepartments.length > 0
            ? prod.allowedDepartments
            : ['factory', 'production', 'sales', 'waste'],
      });
      setFeedback({
        type: 'success',
        text: !prod.isActive ? `تم تفعيل الصنف "${prod.name}".` : `تم إيقاف الصنف "${prod.name}".`,
      });
    } catch (err) {
      setFeedback({ type: 'error', text: formatActionError(err, 'تعذر تحديث حالة الصنف.') });
    } finally {
      setBusy(false);
    }
  };

  const handleAdminReview = async (prod: Product, decision: 'approve' | 'reject') => {
    if (!account) return;
    setBusy(true);
    setFeedback(null);
    try {
      await adminReviewProduct(
        account,
        prod,
        decision,
        decision === 'approve' ? 'اعتماد إداري نهائي وتفعيل في الإدارات' : 'مرفوض إدارياً'
      );
      setFeedback({
        type: 'success',
        text:
          decision === 'approve'
            ? `تم اعتماد الصنف "${prod.name}" وتفعيله.`
            : `تم رفض الصنف "${prod.name}".`,
      });
    } catch (err) {
      setFeedback({ type: 'error', text: formatActionError(err, 'تعذر تنفيذ قرار الاعتماد.') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-white border border-zinc-200 rounded-2xl p-5">
        <h2 className="text-xl font-bold text-zinc-900 font-display">
          إدارة الأصناف والمجموعات والاعتمادات
        </h2>
        <p className="mt-1 text-sm text-zinc-500">
          إضافة وتعديل وإيقاف المجموعات والأصناف الجاهزة للبيع دون حذف سجلاتها التاريخية
        </p>
      </div>

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

      {/* Pending Administrative Approval Queue */}
      {pendingAdminProducts.length > 0 && (
        <div className="bg-white border border-amber-200 rounded-2xl overflow-hidden">
          <div className="px-5 py-4 bg-amber-50/50 border-b border-amber-200">
            <h3 className="text-base font-bold text-amber-900 font-display">
              أصناف بانتظار الاعتماد الإداري ({pendingAdminProducts.length})
            </h3>
          </div>
          <div className="divide-y divide-zinc-100">
            {pendingAdminProducts.map((prod) => (
              <div
                key={prod.id}
                className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
              >
                <div>
                  <div className="text-sm font-bold text-zinc-900">{prod.name}</div>
                  <div className="text-xs text-zinc-500">
                    {categoryMap.get(prod.categoryId) || '—'} · {prod.unit} · أنشأه:{' '}
                    {prod.createdByName} · الاعتماد الفني: {prod.technicalApprovedByName || '—'}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleAdminReview(prod, 'approve')}
                    className="min-h-[40px] inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-bold text-white cursor-pointer"
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    <span>اعتماد وتفعيل</span>
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleAdminReview(prod, 'reject')}
                    className="min-h-[40px] inline-flex items-center gap-1.5 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-xs font-bold text-red-700 cursor-pointer"
                  >
                    <XCircle className="h-4 w-4" />
                    <span>رفض</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Categories & Products Forms */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Categories */}
        <div className="lg:col-span-4 bg-white border border-zinc-200 rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <FolderPlus className="h-5 w-5 text-[#D91B23]" />
              <h3 className="text-base font-bold text-zinc-900 font-display">
                {editingCat ? `تعديل مجموعة: ${editingCat.name}` : 'مجموعات الأصناف'}
              </h3>
            </div>
            <span className="text-xs font-semibold text-zinc-400 tabular-nums">
              ({categories.length})
            </span>
          </div>

          <form onSubmit={handleSaveCategory} className="space-y-3" noValidate>
            <div>
              <label className="block text-xs font-semibold text-zinc-700 mb-1">
                اسم المجموعة
              </label>
              <input
                ref={catInputRef}
                type="text"
                value={catName}
                onChange={(e) => setCatName(e.target.value)}
                placeholder="مثال: المشويات"
                className="w-full min-h-[42px] rounded-xl border border-zinc-200 px-3 text-sm"
              />
            </div>

            <div className="flex items-end gap-2">
              <div className="w-24">
                <label className="block text-xs font-semibold text-zinc-700 mb-1">الترتيب</label>
                <input
                  type="number"
                  min="0"
                  max="999999"
                  value={catOrder}
                  onChange={(e) => setCatOrder(e.target.value)}
                  placeholder="الترتيب"
                  className="w-full min-h-[42px] rounded-xl border border-zinc-200 px-3 text-sm tabular-nums"
                />
              </div>
              <button
                type="submit"
                disabled={busy}
                className="flex-1 min-h-[42px] rounded-xl bg-[#18181B] hover:bg-zinc-800 text-xs font-bold text-white cursor-pointer disabled:opacity-50"
              >
                {busy ? 'جاري الحفظ...' : editingCat ? 'حفظ التعديل' : 'إضافة مجموعة'}
              </button>
              {editingCat && (
                <button
                  type="button"
                  onClick={() => {
                    setEditingCat(null);
                    setCatName('');
                    setCatOrder(String(nextCategoryOrder));
                  }}
                  className="min-h-[42px] px-3 rounded-xl border border-zinc-200 text-xs font-semibold cursor-pointer"
                >
                  إلغاء
                </button>
              )}
            </div>
          </form>

          <div className="divide-y divide-zinc-100 border-t border-zinc-100 pt-2">
            {categories.length === 0 ? (
              <div className="py-4 text-center text-xs text-zinc-400">
                لا توجد مجموعات مسجلة حالياً. أضف مجموعة جديدة من النموذج أعلاه.
              </div>
            ) : (
              categories.map((cat) => (
                <div key={cat.id} className="py-2.5 flex items-center justify-between gap-2 text-sm">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-zinc-400 tabular-nums">
                        #{cat.sortOrder}
                      </span>
                      <span className="font-semibold text-zinc-900 truncate">{cat.name}</span>
                    </div>
                    <div className="text-[11px] text-zinc-400">
                      {cat.isActive ? 'نشطة' : 'موقوفة'} ·{' '}
                      <span className="tabular-nums">
                        {productCountByCategory.get(cat.id) || 0} صنف
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setEditingCat(cat);
                        setCatName(cat.name);
                        setCatOrder(String(cat.sortOrder));
                        setTimeout(() => {
                          catInputRef.current?.focus();
                          catInputRef.current?.select();
                        }, 10);
                      }}
                      className="text-xs text-zinc-600 hover:text-zinc-900 font-semibold cursor-pointer disabled:opacity-50"
                    >
                      تعديل
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleToggleCategory(cat)}
                      className={`text-xs font-semibold cursor-pointer disabled:opacity-50 ${
                        cat.isActive ? 'text-red-600' : 'text-emerald-600'
                      }`}
                    >
                      {cat.isActive ? 'إيقاف' : 'تفعيل'}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Products */}
        <div className="lg:col-span-8 space-y-6">
          <form
            onSubmit={handleCreateProduct}
            noValidate
            className="bg-white border border-zinc-200 rounded-2xl p-5 space-y-4"
          >
            <div className="flex items-center gap-2">
              <PackagePlus className="h-5 w-5 text-[#D91B23]" />
              <h3 className="text-base font-bold text-zinc-900 font-display">
                إضافة صنف جديد معتمد
              </h3>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-semibold text-zinc-700 mb-1">اسم الصنف</label>
                <input
                  type="text"
                  value={prodName}
                  onChange={(e) => setProdName(e.target.value)}
                  placeholder="مثال: مندي لحم"
                  className="w-full min-h-[42px] rounded-xl border border-zinc-200 px-3 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-700 mb-1">المجموعة</label>
                <select
                  value={prodCatId || categories[0]?.id || ''}
                  onChange={(e) => setProdCatId(e.target.value)}
                  className="w-full min-h-[42px] rounded-xl border border-zinc-200 px-3 text-sm bg-white"
                >
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-700 mb-1">
                  وحدة القياس
                </label>
                <input
                  type="text"
                  value={prodUnit}
                  onChange={(e) => setProdUnit(e.target.value)}
                  placeholder="مثال: نفر / حبة"
                  className="w-full min-h-[42px] rounded-xl border border-zinc-200 px-3 text-sm"
                />
              </div>
            </div>

            <div>
              <div className="text-xs font-semibold text-zinc-700 mb-2">
                الإدارات المصرح لها بالتعامل مع الصنف:
              </div>
              <div className="flex flex-wrap gap-2">
                {OPERATIONAL_DEPARTMENTS.map((dept) => {
                  const selected = prodDepts.includes(dept);
                  return (
                    <button
                      key={dept}
                      type="button"
                      onClick={() => toggleDept(dept)}
                      className={`min-h-[36px] px-3 rounded-lg text-xs font-semibold border cursor-pointer ${
                        selected
                          ? 'bg-[#D91B23] text-white border-[#D91B23]'
                          : 'bg-white text-zinc-700 border-zinc-200'
                      }`}
                    >
                      {DEPARTMENT_LABELS[dept]}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={busy}
                className="min-h-[42px] px-5 rounded-xl bg-[#D91B23] hover:bg-[#B9141B] text-xs font-bold text-white cursor-pointer disabled:opacity-50"
              >
                {busy ? 'جاري الحفظ...' : 'إضافة واعتماد الصنف'}
              </button>
            </div>
          </form>

          {/* Products Table */}
          <div className="bg-white border border-zinc-200 rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-zinc-100">
              <h3 className="text-base font-bold text-zinc-900 font-display">
                دليل الأصناف ({products.length})
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-right text-sm">
                <thead className="bg-zinc-50 border-b border-zinc-200 text-xs text-zinc-500">
                  <tr>
                    <th className="px-4 py-3 font-semibold">الصنف</th>
                    <th className="px-3 py-3 font-semibold">المجموعة</th>
                    <th className="px-3 py-3 font-semibold">الوحدة</th>
                    <th className="px-3 py-3 font-semibold">حالة الاعتماد</th>
                    <th className="px-3 py-3 font-semibold">التحكم</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {products.map((prod) => (
                    <tr key={prod.id} className="hover:bg-zinc-50/70">
                      <td className="px-4 py-3">
                        <div className="font-semibold text-zinc-900">{prod.name}</div>
                        <div className="text-[11px] text-zinc-400">
                          {prod.allowedDepartments.map((d) => DEPARTMENT_LABELS[d]).join(' · ')}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-zinc-600">
                        {categoryMap.get(prod.categoryId) || '—'}
                      </td>
                      <td className="px-3 py-3 text-zinc-600">{prod.unit}</td>
                      <td className="px-3 py-3">
                        <StatusBadge
                          label={PRODUCT_APPROVAL_LABELS[prod.approvalStatus]}
                          tone={
                            prod.approvalStatus === 'approved'
                              ? 'success'
                              : prod.approvalStatus === 'rejected' || !prod.isActive
                              ? 'danger'
                              : 'warning'
                          }
                        />
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-3 text-xs">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => openEditProductModal(prod)}
                            className="inline-flex items-center gap-1 text-zinc-700 hover:text-zinc-900 font-semibold cursor-pointer disabled:opacity-50"
                          >
                            <Edit3 className="h-3.5 w-3.5" />
                            <span>تعديل</span>
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleToggleProduct(prod)}
                            className={`font-semibold cursor-pointer disabled:opacity-50 ${
                              prod.isActive ? 'text-red-600' : 'text-emerald-600'
                            }`}
                          >
                            {prod.isActive ? 'إيقاف' : 'تفعيل'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {/* Edit Product Modal */}
      {editingProd && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[1px] p-4"
          onClick={() => {
            if (!busy) setEditingProd(null);
          }}
        >
          <div
            className="w-full max-w-lg rounded-2xl bg-white border border-zinc-200 shadow-xl p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Edit3 className="h-5 w-5 text-[#D91B23]" />
                <h3 className="text-base font-bold text-zinc-900 font-display">
                  تعديل الصنف
                </h3>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => setEditingProd(null)}
                aria-label="إغلاق"
                className="h-8 w-8 rounded-lg inline-flex items-center justify-center text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {editModalError && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-medium text-red-700">
                {editModalError}
              </div>
            )}

            <form onSubmit={handleSaveEditedProduct} noValidate className="space-y-4">
              <div>
                <label
                  htmlFor="edit-product-name"
                  className="block text-xs font-semibold text-zinc-700 mb-1"
                >
                  اسم الصنف
                </label>
                <input
                  id="edit-product-name"
                  ref={editProdInputRef}
                  type="text"
                  value={editProdName}
                  onChange={(e) => setEditProdName(e.target.value)}
                  placeholder="أدخل اسم الصنف"
                  className="w-full min-h-[44px] rounded-xl border border-zinc-300 bg-white px-3.5 text-sm font-semibold text-zinc-900 focus:outline-none focus:ring-2 focus:ring-[#D91B23]/20 focus:border-[#D91B23]"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="edit-product-category"
                    className="block text-xs font-semibold text-zinc-700 mb-1"
                  >
                    المجموعة
                  </label>
                  <select
                    id="edit-product-category"
                    value={editProdCatId}
                    onChange={(e) => setEditProdCatId(e.target.value)}
                    className="w-full min-h-[42px] rounded-xl border border-zinc-300 bg-white px-3 text-sm"
                  >
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="edit-product-unit"
                    className="block text-xs font-semibold text-zinc-700 mb-1"
                  >
                    وحدة القياس
                  </label>
                  <input
                    id="edit-product-unit"
                    type="text"
                    value={editProdUnit}
                    onChange={(e) => setEditProdUnit(e.target.value)}
                    placeholder="نفر / حبة / صحن"
                    className="w-full min-h-[42px] rounded-xl border border-zinc-300 bg-white px-3 text-sm"
                  />
                </div>
              </div>

              <div>
                <div className="text-xs font-semibold text-zinc-700 mb-2">
                  الإدارات المصرح لها بالتعامل مع الصنف:
                </div>
                <div className="flex flex-wrap gap-2">
                  {OPERATIONAL_DEPARTMENTS.map((dept) => {
                    const selected = editProdDepts.includes(dept);
                    return (
                      <button
                        key={dept}
                        type="button"
                        onClick={() => toggleEditDept(dept)}
                        className={`min-h-[36px] px-3 rounded-lg text-xs font-semibold border cursor-pointer ${
                          selected
                            ? 'bg-[#D91B23] text-white border-[#D91B23]'
                            : 'bg-white text-zinc-700 border-zinc-200'
                        }`}
                      >
                        {DEPARTMENT_LABELS[dept]}
                      </button>
                    );
                  })}
                </div>
              </div>

              <label className="flex items-center gap-2.5 rounded-xl border border-zinc-200 bg-zinc-50 px-3.5 py-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={editProdIsActive}
                  onChange={(e) => setEditProdIsActive(e.target.checked)}
                  className="h-4 w-4 rounded border-zinc-300 text-[#D91B23] focus:ring-[#D91B23]"
                />
                <span className="text-xs font-semibold text-zinc-800">
                  الصنف نشط ومعتمد للاستخدام
                </span>
              </label>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setEditingProd(null)}
                  className="min-h-[42px] px-4 rounded-xl border border-zinc-200 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="min-h-[42px] px-5 rounded-xl bg-[#D91B23] hover:bg-[#B9141B] text-xs font-bold text-white cursor-pointer disabled:opacity-50"
                >
                  {busy ? 'جاري الحفظ...' : 'حفظ التعديلات'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
