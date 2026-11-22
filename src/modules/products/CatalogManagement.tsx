import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Edit3, FolderPlus, PackagePlus, XCircle } from 'lucide-react';
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

  const [catName, setCatName] = useState('');
  const [catOrder, setCatOrder] = useState('1');
  const [editingCat, setEditingCat] = useState<Category | null>(null);

  const [prodName, setProdName] = useState('');
  const [prodCatId, setProdCatId] = useState('');
  const [prodUnit, setProdUnit] = useState('نفر');
  const [prodDepts, setProdDepts] = useState<OperationalDepartmentId[]>([
    'factory',
    'production',
    'sales',
    'waste',
  ]);
  const [editingProd, setEditingProd] = useState<Product | null>(null);

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

  const handleSaveProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!account) return;
    if (!prodName.trim()) {
      setFeedback({ type: 'error', text: 'يرجى إدخال اسم الصنف.' });
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      const targetCat = prodCatId || categories[0]?.id;
      if (!targetCat) throw new Error('أضف مجموعة أصناف أولاً.');
      if (prodDepts.length === 0) throw new Error('اختر إدارة واحدة على الأقل.');

      if (editingProd) {
        await updateProductByAdmin(account, editingProd, {
          name: prodName,
          categoryId: targetCat,
          unit: prodUnit,
          isActive: editingProd.isActive,
          allowedDepartments: prodDepts,
        });
        setEditingProd(null);
        setFeedback({ type: 'success', text: 'تم تحديث بيانات الصنف بنجاح.' });
      } else {
        await createProductByAdmin(account, {
          name: prodName,
          categoryId: targetCat,
          unit: prodUnit,
          allowedDepartments: prodDepts,
        });
        setFeedback({ type: 'success', text: 'تم إنشاء الصنف واعتماده مباشرة.' });
      }
      setProdName('');
    } catch (err) {
      setFeedback({ type: 'error', text: formatActionError(err, 'تعذر حفظ الصنف.') });
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
        unit: prod.unit,
        isActive: !prod.isActive,
        allowedDepartments: prod.allowedDepartments,
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
                      }}
                      className="text-xs text-zinc-600 hover:text-zinc-900 cursor-pointer"
                    >
                      تعديل
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleToggleCategory(cat)}
                      className={`text-xs font-semibold cursor-pointer ${
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
            onSubmit={handleSaveProduct}
            className="bg-white border border-zinc-200 rounded-2xl p-5 space-y-4"
          >
            <div className="flex items-center gap-2">
              <PackagePlus className="h-5 w-5 text-[#D91B23]" />
              <h3 className="text-base font-bold text-zinc-900 font-display">
                {editingProd ? `تعديل الصنف: ${editingProd.name}` : 'إضافة صنف جديد معتمد'}
              </h3>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <input
                type="text"
                required
                value={prodName}
                onChange={(e) => setProdName(e.target.value)}
                placeholder="اسم الصنف"
                className="min-h-[42px] rounded-xl border border-zinc-200 px-3 text-sm"
              />
              <select
                value={prodCatId || categories[0]?.id || ''}
                onChange={(e) => setProdCatId(e.target.value)}
                className="min-h-[42px] rounded-xl border border-zinc-200 px-3 text-sm"
              >
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <input
                type="text"
                required
                value={prodUnit}
                onChange={(e) => setProdUnit(e.target.value)}
                placeholder="وحدة القياس"
                className="min-h-[42px] rounded-xl border border-zinc-200 px-3 text-sm"
              />
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

            <div className="flex justify-end gap-2">
              {editingProd && (
                <button
                  type="button"
                  onClick={() => {
                    setEditingProd(null);
                    setProdName('');
                  }}
                  className="min-h-[42px] px-4 rounded-xl border border-zinc-200 text-xs font-semibold cursor-pointer"
                >
                  إلغاء التعديل
                </button>
              )}
              <button
                type="submit"
                disabled={busy}
                className="min-h-[42px] px-5 rounded-xl bg-[#D91B23] text-xs font-bold text-white cursor-pointer"
              >
                {editingProd ? 'حفظ تعديلات الصنف' : 'إضافة واعتماد الصنف'}
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
                            onClick={() => {
                              setEditingProd(prod);
                              setProdName(prod.name);
                              setProdCatId(prod.categoryId);
                              setProdUnit(prod.unit);
                              setProdDepts(prod.allowedDepartments);
                            }}
                            className="inline-flex items-center gap-1 text-zinc-700 hover:text-zinc-900 font-semibold cursor-pointer"
                          >
                            <Edit3 className="h-3.5 w-3.5" />
                            <span>تعديل</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleToggleProduct(prod)}
                            className={`font-semibold cursor-pointer ${
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
    </div>
  );
};
