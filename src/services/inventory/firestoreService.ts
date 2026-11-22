import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  DEFAULT_BRANCH_ID,
  getDepartmentForRole,
  getDefaultPermissionsForRole,
} from '../../constants/departments';
import type {
  ApprovalRequest,
  Category,
  DailySession,
  DepartmentReport,
  DepartmentReportItem,
  FactoryTransfer,
  FactoryTransferItem,
  OperationalDepartmentId,
  PermissionKey,
  Product,
  ProductResult,
  ProductionEntry,
  UserAccount,
  UserInvite,
  UserRole,
} from '../../types/inventory';
import { getPreviousAdenDate, makeSessionId } from '../../utils/dateAden';
import { OperationType, db, handleFirestoreError } from '../firebase/config';
import { calculateProductInventory, roundQty, safeNum, sanitizeId } from './calculator';

function makeUniqueId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return sanitizeId(`${prefix}_${Date.now()}_${rand}`);
}

export function formatActionError(err: unknown, fallback = 'تعذر تنفيذ العملية.'): string {
  if (!(err instanceof Error)) return fallback;
  const raw = err.message || '';
  let detail = raw;
  try {
    const parsed = JSON.parse(raw) as { error?: string };
    if (parsed && typeof parsed.error === 'string') {
      detail = parsed.error;
    }
  } catch {
    // Plain Error message, use directly
  }

  const lower = detail.toLowerCase();
  if (lower.includes('missing or insufficient permissions') || lower.includes('permission-denied')) {
    return 'لا تملك الصلاحية الكافية لتنفيذ هذه العملية. تأكد من تفعيل حسابك وصلاحياتك الإدارية.';
  }
  if (lower.includes('client is offline') || lower.includes('unavailable')) {
    return 'تعذر الاتصال بقاعدة البيانات، يرجى التحقق من اتصال الإنترنت والمحاولة مجدداً.';
  }
  if (lower.includes('not-found')) {
    return 'السجل المطلوب غير موجود أو تم تعديله مسبقاً.';
  }
  if (lower.includes('already-exists')) {
    return 'هذا السجل موجود مسبقاً.';
  }
  return detail || fallback;
}

export async function appendAuditLog(params: {
  actor: UserAccount;
  action: string;
  targetCollection: string;
  targetId: string;
  sessionId?: string;
  inventoryDate?: string;
  branchId?: string;
  department?: string;
  oldValueSummary?: string;
  newValueSummary?: string;
  reason?: string;
}): Promise<void> {
  const logId = makeUniqueId('log');
  try {
    const payload: Record<string, unknown> = {
      actorUid: params.actor.uid,
      actorName: params.actor.fullName.slice(0, 120),
      actorRole: params.actor.role,
      action: params.action.slice(0, 80),
      targetCollection: params.targetCollection.slice(0, 64),
      targetId: params.targetId.slice(0, 128),
      createdAt: serverTimestamp(),
    };
    if (params.sessionId) payload.sessionId = params.sessionId.slice(0, 128);
    if (params.inventoryDate) payload.inventoryDate = params.inventoryDate.slice(0, 10);
    if (params.branchId) payload.branchId = params.branchId.slice(0, 64);
    if (params.department) payload.department = params.department.slice(0, 32);
    if (params.oldValueSummary) payload.oldValueSummary = params.oldValueSummary.slice(0, 400);
    if (params.newValueSummary) payload.newValueSummary = params.newValueSummary.slice(0, 400);
    if (params.reason) payload.reason = params.reason.slice(0, 400);

    await setDoc(doc(db, 'auditLogs', logId), payload);
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `auditLogs/${logId}`);
  }
}

// ==========================================
// USERS & INVITES (RBAC)
// ==========================================

export async function createUserInvite(
  actor: UserAccount,
  input: {
    email: string;
    employeeNumber: string;
    username: string;
    fullName: string;
    role: Exclude<UserRole, 'pending'>;
    status: 'active' | 'suspended';
    permissions?: PermissionKey[];
  }
): Promise<void> {
  const normalizedEmail = input.email.trim().toLowerCase();
  const inviteId = makeUniqueId('inv');
  const department = getDepartmentForRole(input.role);
  const permissions = input.permissions?.length
    ? input.permissions
    : getDefaultPermissionsForRole(input.role);

  try {
    await setDoc(doc(db, 'userInvites', inviteId), {
      email: normalizedEmail,
      employeeNumber: input.employeeNumber.trim().slice(0, 40),
      username: input.username.trim().slice(0, 80),
      fullName: input.fullName.trim().slice(0, 120),
      department,
      role: input.role,
      branchId: DEFAULT_BRANCH_ID,
      status: input.status,
      permissions,
      claimed: false,
      createdBy: actor.uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    await appendAuditLog({
      actor,
      action: 'إنشاء_حساب_موظف_مدعو',
      targetCollection: 'userInvites',
      targetId: inviteId,
      department: 'management',
      newValueSummary: `${input.fullName} (${normalizedEmail}) - ${input.role}`,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `userInvites/${inviteId}`);
  }
}

export async function updateUserAccountByAdmin(
  actor: UserAccount,
  targetUser: UserAccount,
  updates: {
    employeeNumber: string;
    username: string;
    fullName: string;
    role: UserRole;
    status: 'active' | 'suspended';
    permissions: PermissionKey[];
  }
): Promise<void> {
  const department =
    updates.role === 'pending' ? targetUser.department : getDepartmentForRole(updates.role);
  const cleanEmailFallback = (targetUser.email || 'user').split('@')[0] || 'user';
  const cleanEmployeeNumber = (updates.employeeNumber || targetUser.employeeNumber || 'EMP-100')
    .trim()
    .slice(0, 40);
  const cleanUsername = (updates.username || targetUser.username || cleanEmailFallback)
    .trim()
    .slice(0, 80);
  const cleanFullName = (updates.fullName || targetUser.fullName || cleanEmailFallback)
    .trim()
    .slice(0, 120);

  const batch = writeBatch(db);
  const userRef = doc(db, 'users', targetUser.uid);

  batch.update(userRef, {
    employeeNumber: cleanEmployeeNumber,
    username: cleanUsername,
    fullName: cleanFullName,
    department,
    role: updates.role,
    status: updates.status,
    permissions: updates.permissions,
    updatedAt: serverTimestamp(),
  });

  const adminRef = doc(db, 'admins', targetUser.uid);
  const isManagerRole = updates.role === 'ceo' || updates.role === 'branch_manager';

  try {
    const adminSnap = await getDoc(adminRef);
    if (isManagerRole && updates.status === 'active') {
      if (!adminSnap.exists()) {
        batch.set(adminRef, {
          uid: targetUser.uid,
          role: updates.role,
          email: targetUser.email,
          createdAt: serverTimestamp(),
        });
      } else {
        batch.update(adminRef, { role: updates.role });
      }
    } else if (adminSnap.exists() && targetUser.uid !== actor.uid) {
      batch.delete(adminRef);
    }

    await batch.commit();

    const wasPending = targetUser.status === 'pending_activation' || targetUser.role === 'pending';
    const actionLabel = wasPending
      ? updates.status === 'active'
        ? 'قبول_وتفعيل_طلب_موظف'
        : 'رفض_طلب_انضمام_موظف'
      : 'تحديث_حساب_وصلاحيات_موظف';

    await appendAuditLog({
      actor,
      action: actionLabel,
      targetCollection: 'users',
      targetId: targetUser.uid,
      department: 'management',
      oldValueSummary: `${targetUser.role} (${targetUser.status})`,
      newValueSummary: `${cleanFullName} - ${updates.role} (${updates.status})`,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `users/${targetUser.uid}`);
  }
}

export async function deleteUserInvite(actor: UserAccount, invite: UserInvite): Promise<void> {
  try {
    await deleteDoc(doc(db, 'userInvites', invite.id));
    await appendAuditLog({
      actor,
      action: 'حذف_دعوة_موظف',
      targetCollection: 'userInvites',
      targetId: invite.id,
      oldValueSummary: invite.email,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `userInvites/${invite.id}`);
  }
}

// ==========================================
// CATEGORIES & PRODUCTS + 3-STAGE APPROVAL
// ==========================================

export async function createCategory(
  actor: UserAccount,
  name: string,
  sortOrder: number
): Promise<void> {
  const cleanName = name.trim().slice(0, 100);
  if (!cleanName) {
    throw new Error('يرجى إدخال اسم المجموعة.');
  }
  const cleanOrder = Math.min(1000000, Math.max(0, Math.floor(safeNum(sortOrder))));
  const categoryId = makeUniqueId('cat');
  try {
    await setDoc(doc(db, 'categories', categoryId), {
      name: cleanName,
      sortOrder: cleanOrder,
      isActive: true,
      createdBy: actor.uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    await appendAuditLog({
      actor,
      action: 'إضافة_مجموعة_أصناف',
      targetCollection: 'categories',
      targetId: categoryId,
      department: 'management',
      newValueSummary: cleanName,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `categories/${categoryId}`);
  }
}

export async function updateCategory(
  actor: UserAccount,
  category: Category,
  updates: { name: string; sortOrder: number; isActive: boolean }
): Promise<void> {
  const cleanName = updates.name.trim().slice(0, 100);
  if (!cleanName) {
    throw new Error('يرجى إدخال اسم المجموعة.');
  }
  const cleanOrder = Math.min(1000000, Math.max(0, Math.floor(safeNum(updates.sortOrder))));
  try {
    await updateDoc(doc(db, 'categories', category.id), {
      name: cleanName,
      sortOrder: cleanOrder,
      isActive: updates.isActive,
      updatedAt: serverTimestamp(),
    });
    await appendAuditLog({
      actor,
      action: 'تعديل_مجموعة_أصناف',
      targetCollection: 'categories',
      targetId: category.id,
      department: 'management',
      oldValueSummary: `${category.name} (${category.isActive ? 'نشطة' : 'موقوفة'})`,
      newValueSummary: `${cleanName} (${updates.isActive ? 'نشطة' : 'موقوفة'})`,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `categories/${category.id}`);
  }
}

export async function proposeProductByFactory(
  actor: UserAccount,
  input: {
    name: string;
    categoryId: string;
    unit: string;
    allowedDepartments: OperationalDepartmentId[];
    reason?: string;
  }
): Promise<void> {
  const productId = makeUniqueId('prod');
  const approvalId = makeUniqueId('app');
  const batch = writeBatch(db);

  batch.set(doc(db, 'products', productId), {
    name: input.name.trim().slice(0, 140),
    categoryId: input.categoryId,
    unit: input.unit.trim().slice(0, 40),
    isActive: false,
    approvalStatus: 'pending_technical',
    allowedDepartments: input.allowedDepartments.length
      ? input.allowedDepartments
      : ['factory', 'production', 'sales', 'waste'],
    createdBy: actor.uid,
    createdByName: actor.fullName,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  batch.set(doc(db, 'approvals', approvalId), {
    type: 'product_technical',
    targetCollection: 'products',
    targetId: productId,
    productId,
    department: 'factory',
    status: 'pending',
    reason: (input.reason || `طلب اعتماد صنف جديد: ${input.name}`).slice(0, 500),
    requestedBy: actor.uid,
    requestedByName: actor.fullName,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  try {
    await batch.commit();
    await appendAuditLog({
      actor,
      action: 'اقتراح_صنف_جديد_من_المعمل',
      targetCollection: 'products',
      targetId: productId,
      department: actor.department,
      newValueSummary: `${input.name} (${input.unit})`,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `products/${productId}`);
  }
}

export async function createProductByAdmin(
  actor: UserAccount,
  input: {
    name: string;
    categoryId: string;
    unit: string;
    allowedDepartments: OperationalDepartmentId[];
  }
): Promise<void> {
  const productId = makeUniqueId('prod');
  try {
    await setDoc(doc(db, 'products', productId), {
      name: input.name.trim().slice(0, 140),
      categoryId: input.categoryId,
      unit: input.unit.trim().slice(0, 40),
      isActive: true,
      approvalStatus: 'approved',
      allowedDepartments: input.allowedDepartments,
      createdBy: actor.uid,
      createdByName: actor.fullName,
      technicalApprovedBy: actor.uid,
      technicalApprovedByName: actor.fullName,
      adminApprovedBy: actor.uid,
      adminApprovedByName: actor.fullName,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    await appendAuditLog({
      actor,
      action: 'إنشاء_واعتماد_صنف_مباشر',
      targetCollection: 'products',
      targetId: productId,
      newValueSummary: `${input.name} (${input.unit})`,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `products/${productId}`);
  }
}

export async function updateProductByAdmin(
  actor: UserAccount,
  product: Product,
  updates: {
    name: string;
    categoryId: string;
    unit: string;
    isActive: boolean;
    allowedDepartments: OperationalDepartmentId[];
  }
): Promise<void> {
  try {
    await updateDoc(doc(db, 'products', product.id), {
      name: updates.name.trim().slice(0, 140),
      categoryId: updates.categoryId,
      unit: updates.unit.trim().slice(0, 40),
      isActive: updates.isActive,
      approvalStatus: updates.isActive ? 'approved' : 'inactive',
      allowedDepartments: updates.allowedDepartments,
      updatedAt: serverTimestamp(),
    });
    await appendAuditLog({
      actor,
      action: 'تعديل_بيانات_صنف',
      targetCollection: 'products',
      targetId: product.id,
      oldValueSummary: `${product.name} · ${product.unit} · ${product.isActive ? 'نشط' : 'موقوف'}`,
      newValueSummary: `${updates.name} · ${updates.unit} · ${updates.isActive ? 'نشط' : 'موقوف'}`,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `products/${product.id}`);
  }
}

export async function technicalReviewProduct(
  actor: UserAccount,
  product: Product,
  decision: 'approve' | 'reject',
  note: string,
  relatedApproval?: ApprovalRequest
): Promise<void> {
  const batch = writeBatch(db);
  const prodRef = doc(db, 'products', product.id);

  if (decision === 'approve') {
    batch.update(prodRef, {
      approvalStatus: 'pending_admin',
      technicalApprovedBy: actor.uid,
      technicalApprovedByName: actor.fullName,
      rejectionReason: '',
      updatedAt: serverTimestamp(),
    });
    if (relatedApproval) {
      batch.update(doc(db, 'approvals', relatedApproval.id), {
        status: 'approved',
        reviewedBy: actor.uid,
        reviewedByName: actor.fullName,
        reviewNote: (note || 'مطابق فنياً').slice(0, 500),
        updatedAt: serverTimestamp(),
      });
    }
    const adminApprovalId = makeUniqueId('app');
    batch.set(doc(db, 'approvals', adminApprovalId), {
      type: 'product_admin',
      targetCollection: 'products',
      targetId: product.id,
      productId: product.id,
      department: 'production',
      status: 'pending',
      reason: `تمت الموافقة الفنية على الصنف "${product.name}" وبانتظار الاعتماد الإداري.`,
      requestedBy: actor.uid,
      requestedByName: actor.fullName,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } else {
    batch.update(prodRef, {
      approvalStatus: 'rejected',
      technicalApprovedBy: actor.uid,
      technicalApprovedByName: actor.fullName,
      rejectionReason: (note || 'مرفوض فنياً').slice(0, 300),
      updatedAt: serverTimestamp(),
    });
    if (relatedApproval) {
      batch.update(doc(db, 'approvals', relatedApproval.id), {
        status: 'rejected',
        reviewedBy: actor.uid,
        reviewedByName: actor.fullName,
        reviewNote: (note || 'مرفوض فنياً').slice(0, 500),
        updatedAt: serverTimestamp(),
      });
    }
  }

  try {
    await batch.commit();
    await appendAuditLog({
      actor,
      action: decision === 'approve' ? 'اعتماد_فني_لصنف' : 'رفض_فني_لصنف',
      targetCollection: 'products',
      targetId: product.id,
      department: 'production',
      reason: note,
      newValueSummary: product.name,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `products/${product.id}`);
  }
}

export async function adminReviewProduct(
  actor: UserAccount,
  product: Product,
  decision: 'approve' | 'reject',
  note: string,
  relatedApproval?: ApprovalRequest
): Promise<void> {
  const batch = writeBatch(db);
  const prodRef = doc(db, 'products', product.id);

  if (decision === 'approve') {
    batch.update(prodRef, {
      approvalStatus: 'approved',
      isActive: true,
      adminApprovedBy: actor.uid,
      adminApprovedByName: actor.fullName,
      rejectionReason: '',
      updatedAt: serverTimestamp(),
    });
  } else {
    batch.update(prodRef, {
      approvalStatus: 'rejected',
      isActive: false,
      adminApprovedBy: actor.uid,
      adminApprovedByName: actor.fullName,
      rejectionReason: (note || 'مرفوض إدارياً').slice(0, 300),
      updatedAt: serverTimestamp(),
    });
  }

  if (relatedApproval) {
    batch.update(doc(db, 'approvals', relatedApproval.id), {
      status: decision === 'approve' ? 'approved' : 'rejected',
      reviewedBy: actor.uid,
      reviewedByName: actor.fullName,
      reviewNote: (note || (decision === 'approve' ? 'تم الاعتماد الإداري' : 'مرفوض')).slice(0, 500),
      updatedAt: serverTimestamp(),
    });
  }

  try {
    await batch.commit();
    await appendAuditLog({
      actor,
      action: decision === 'approve' ? 'اعتماد_إداري_لصنف' : 'رفض_إداري_لصنف',
      targetCollection: 'products',
      targetId: product.id,
      department: 'management',
      reason: note,
      newValueSummary: product.name,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `products/${product.id}`);
  }
}

// ==========================================
// DAILY SESSIONS & OPENING BALANCE CARRY-OVER
// ==========================================

export async function ensureDailySession(
  actor: UserAccount,
  branchId: string,
  inventoryDate: string
): Promise<DailySession> {
  const sessionId = makeSessionId(branchId, inventoryDate);
  const sessionRef = doc(db, 'dailySessions', sessionId);
  try {
    const snap = await getDoc(sessionRef);
    if (snap.exists()) {
      return { id: snap.id, ...(snap.data() as Omit<DailySession, 'id'>) };
    }

    const prevDate = getPreviousAdenDate(inventoryDate);
    const prevSessionId = makeSessionId(branchId, prevDate);
    let prevApproved = true;

    try {
      const prevSnap = await getDoc(doc(db, 'dailySessions', prevSessionId));
      if (prevSnap.exists()) {
        const prevStatus = prevSnap.data()?.status;
        prevApproved = prevStatus === 'closed';
      }
    } catch {
      prevApproved = true;
    }

    const payload = {
      branchId,
      inventoryDate,
      status: 'open' as const,
      previousSessionId: prevSessionId,
      openingBalanceApproved: prevApproved,
      createdBy: actor.uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    await setDoc(sessionRef, payload);

    await appendAuditLog({
      actor,
      action: 'إنشاء_جلسة_جرد_يومية',
      targetCollection: 'dailySessions',
      targetId: sessionId,
      sessionId,
      inventoryDate,
      branchId,
      newValueSummary: `فتح جلسة جرد بتاريخ ${inventoryDate}`,
    });

    const createdSnap = await getDoc(sessionRef);
    return { id: createdSnap.id, ...(createdSnap.data() as Omit<DailySession, 'id'>) };
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `dailySessions/${sessionId}`);
  }
}

// ==========================================
// DEPARTMENT REPORTS & LINE ITEMS
// ==========================================

export async function ensureDepartmentReport(
  actor: UserAccount,
  session: DailySession,
  department: OperationalDepartmentId
): Promise<DepartmentReport> {
  const reportId = sanitizeId(`${session.id}_${department}`);
  const reportRef = doc(db, 'departmentReports', reportId);

  try {
    const snap = await getDoc(reportRef);
    if (snap.exists()) {
      return { id: snap.id, ...(snap.data() as Omit<DepartmentReport, 'id'>) };
    }

    await setDoc(reportRef, {
      sessionId: session.id,
      branchId: session.branchId,
      inventoryDate: session.inventoryDate,
      department,
      status: 'draft',
      itemCount: 0,
      createdBy: actor.uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    const createdSnap = await getDoc(reportRef);
    return { id: createdSnap.id, ...(createdSnap.data() as Omit<DepartmentReport, 'id'>) };
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `departmentReports/${reportId}`);
  }
}

export async function saveDepartmentReportDraft(
  actor: UserAccount,
  report: DepartmentReport,
  items: Array<{
    productId: string;
    categoryId: string;
    preparedQty?: number | null;
    independentProductionQty?: number | null;
    salesQty?: number | null;
    damagedQty?: number | null;
    validRemainingQty?: number | null;
    invalidRemainingQty?: number | null;
    note?: string;
  }>
): Promise<void> {
  if (report.status !== 'draft') {
    throw new Error('لا يمكن تعديل تقرير تم ترحيله بالفعل. يمكنك تقديم طلب تصحيح إداري.');
  }

  try {
    const batch = writeBatch(db);
    let enteredCount = 0;

    for (const item of items) {
      const hasAnyValue =
        item.preparedQty !== undefined && item.preparedQty !== null ||
        item.independentProductionQty !== undefined && item.independentProductionQty !== null ||
        item.salesQty !== undefined && item.salesQty !== null ||
        item.damagedQty !== undefined && item.damagedQty !== null ||
        item.validRemainingQty !== undefined && item.validRemainingQty !== null ||
        item.invalidRemainingQty !== undefined && item.invalidRemainingQty !== null;

      if (hasAnyValue) enteredCount++;

      const itemRef = doc(db, 'departmentReports', report.id, 'items', item.productId);
      const existingSnap = await getDoc(itemRef);

      const payload: Record<string, unknown> = {
        reportId: report.id,
        sessionId: report.sessionId,
        branchId: report.branchId,
        inventoryDate: report.inventoryDate,
        department: report.department,
        productId: item.productId,
        categoryId: item.categoryId,
        preparedQty: item.preparedQty ?? null,
        independentProductionQty: item.independentProductionQty ?? null,
        salesQty: item.salesQty ?? null,
        damagedQty: item.damagedQty ?? null,
        validRemainingQty: item.validRemainingQty ?? null,
        invalidRemainingQty: item.invalidRemainingQty ?? null,
        note: (item.note || '').slice(0, 300),
        updatedBy: actor.uid,
        updatedByName: actor.fullName,
        updatedAt: serverTimestamp(),
      };

      if (existingSnap.exists()) {
        payload.createdAt = existingSnap.data().createdAt;
      } else {
        payload.createdAt = serverTimestamp();
      }

      batch.set(itemRef, payload);
    }

    batch.update(doc(db, 'departmentReports', report.id), {
      itemCount: enteredCount,
      updatedAt: serverTimestamp(),
    });

    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `departmentReports/${report.id}/items`);
  }
}

export async function submitDepartmentReport(
  actor: UserAccount,
  report: DepartmentReport,
  enteredCount: number
): Promise<void> {
  if (report.status !== 'draft') {
    throw new Error('تم ترحيل هذا التقرير مسبقاً.');
  }
  if (enteredCount <= 0) {
    throw new Error('لا يمكن ترحيل تقرير فارغ. يرجى إدخال صنف واحد على الأقل (حتى لو بقيمة 0).');
  }

  try {
    await updateDoc(doc(db, 'departmentReports', report.id), {
      status: 'submitted',
      itemCount: enteredCount,
      submittedBy: actor.uid,
      submittedByName: actor.fullName,
      updatedAt: serverTimestamp(),
    });

    await appendAuditLog({
      actor,
      action: 'ترحيل_تقرير_إدارة',
      targetCollection: 'departmentReports',
      targetId: report.id,
      sessionId: report.sessionId,
      inventoryDate: report.inventoryDate,
      branchId: report.branchId,
      department: report.department,
      newValueSummary: `ترحيل تقرير ${report.department} (${enteredCount} صنف)`,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `departmentReports/${report.id}`);
  }
}

// ==========================================
// FACTORY TRANSFERS & PRODUCTION RECEIPT
// ==========================================

export async function createFactoryTransfer(
  actor: UserAccount,
  session: DailySession,
  items: Array<{ product: Product; sentQty: number; note?: string }>,
  factoryNote: string
): Promise<void> {
  for (const i of items) {
    if (Number.isNaN(i.sentQty) || i.sentQty < 0) {
      throw new Error(`الكمية المرسلة للصنف "${i.product.name}" غير صالحة.`);
    }
  }
  const validItems = items.filter((i) => i.sentQty > 0);
  if (validItems.length === 0) {
    throw new Error('لا يمكن إنشاء توريد فارغ. أدخل كمية أكبر من صفر لصنف واحد على الأقل.');
  }

  const transferId = makeUniqueId('trf');
  const transferNumber = `TRF-${session.inventoryDate.replace(/-/g, '')}-${String(Date.now()).slice(-4)}`;
  const totalSentQty = roundQty(validItems.reduce((acc, i) => acc + safeNum(i.sentQty), 0));

  const batch = writeBatch(db);
  batch.set(doc(db, 'factoryTransfers', transferId), {
    sessionId: session.id,
    branchId: session.branchId,
    inventoryDate: session.inventoryDate,
    transferNumber,
    status: 'pending_receipt',
    totalSentQty,
    totalReceivedQty: 0,
    totalVarianceQty: 0,
    factoryNote: factoryNote.trim().slice(0, 400),
    createdBy: actor.uid,
    createdByName: actor.fullName,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  for (const item of validItems) {
    batch.set(doc(db, 'factoryTransfers', transferId, 'items', item.product.id), {
      transferId,
      sessionId: session.id,
      productId: item.product.id,
      productName: item.product.name.slice(0, 140),
      unit: item.product.unit.slice(0, 40),
      sentQty: safeNum(item.sentQty),
      receivedQty: null,
      varianceQty: null,
      note: (item.note || '').slice(0, 300),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  try {
    await batch.commit();
    await appendAuditLog({
      actor,
      action: 'إرسال_توريد_معمل',
      targetCollection: 'factoryTransfers',
      targetId: transferId,
      sessionId: session.id,
      inventoryDate: session.inventoryDate,
      branchId: session.branchId,
      department: 'factory',
      newValueSummary: `توريد ${transferNumber} بإجمالي ${totalSentQty} وحدة`,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `factoryTransfers/${transferId}`);
  }
}

export async function confirmTransferReceipt(
  actor: UserAccount,
  transfer: FactoryTransfer,
  receivedItems: Array<{ item: FactoryTransferItem; receivedQty: number; note?: string }>,
  productionNote: string
): Promise<void> {
  if (transfer.status !== 'pending_receipt') {
    throw new Error('تم تأكيد استلام هذا التوريد مسبقاً.');
  }

  let totalReceivedQty = 0;
  let totalVarianceQty = 0;
  let hasDiscrepancy = false;

  const batch = writeBatch(db);

  for (const row of receivedItems) {
    const rec = safeNum(row.receivedQty);
    const variance = roundQty(row.item.sentQty - rec);
    if (variance !== 0) hasDiscrepancy = true;
    totalReceivedQty += rec;
    totalVarianceQty += variance;

    batch.update(doc(db, 'factoryTransfers', transfer.id, 'items', row.item.productId), {
      receivedQty: rec,
      varianceQty: variance,
      note: (row.note || row.item.note || '').slice(0, 300),
      updatedAt: serverTimestamp(),
    });
  }

  const newStatus = hasDiscrepancy ? 'discrepancy_logged' : 'received';

  batch.update(doc(db, 'factoryTransfers', transfer.id), {
    status: newStatus,
    totalReceivedQty: roundQty(totalReceivedQty),
    totalVarianceQty: roundQty(totalVarianceQty),
    productionNote: productionNote.trim().slice(0, 400),
    receivedBy: actor.uid,
    receivedByName: actor.fullName,
    updatedAt: serverTimestamp(),
  });

  try {
    await batch.commit();
    await appendAuditLog({
      actor,
      action: hasDiscrepancy ? 'استلام_توريد_مع_فرق_تسليم' : 'استلام_توريد_مطابق',
      targetCollection: 'factoryTransfers',
      targetId: transfer.id,
      sessionId: transfer.sessionId,
      inventoryDate: transfer.inventoryDate,
      branchId: transfer.branchId,
      department: 'production',
      newValueSummary: `مرسل ${transfer.totalSentQty} · مستلم ${roundQty(totalReceivedQty)} · فرق ${roundQty(totalVarianceQty)}`,
      reason: productionNote,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `factoryTransfers/${transfer.id}`);
  }
}

export async function addIndependentProduction(
  actor: UserAccount,
  session: DailySession,
  product: Product,
  qty: number,
  note: string
): Promise<void> {
  if (qty <= 0) {
    throw new Error('يجب أن تكون كمية الإنتاج المستقل أكبر من صفر.');
  }
  const entryId = makeUniqueId('ind');
  try {
    await setDoc(doc(db, 'productionEntries', entryId), {
      sessionId: session.id,
      branchId: session.branchId,
      inventoryDate: session.inventoryDate,
      productId: product.id,
      qty: safeNum(qty),
      note: note.trim().slice(0, 300),
      createdBy: actor.uid,
      createdByName: actor.fullName,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    await appendAuditLog({
      actor,
      action: 'تسجيل_إنتاج_مستقل',
      targetCollection: 'productionEntries',
      targetId: entryId,
      sessionId: session.id,
      inventoryDate: session.inventoryDate,
      branchId: session.branchId,
      department: 'production',
      newValueSummary: `${product.name}: ${safeNum(qty)} ${product.unit}`,
      reason: note,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `productionEntries/${entryId}`);
  }
}

// ==========================================
// CENTRAL INVENTORY RECALCULATION & DAY CLOSE
// ==========================================

export async function recalculateSessionResults(
  actor: UserAccount,
  session: DailySession,
  products: Product[],
  categories: Category[]
): Promise<ProductResult[]> {
  try {
    const categoryMap = new Map(categories.map((c) => [c.id, c.name]));

    // 1. Opening balance: strictly from previous CLOSED session's validRemainingQty
    const openingMap = new Map<string, number>();
    const prevDate = getPreviousAdenDate(session.inventoryDate);
    const prevSessionId = makeSessionId(session.branchId, prevDate);
    const prevSessionSnap = await getDoc(doc(db, 'dailySessions', prevSessionId));

    if (prevSessionSnap.exists() && prevSessionSnap.data()?.status === 'closed') {
      const prevResultsSnap = await getDocs(
        query(collection(db, 'productResults'), where('sessionId', '==', prevSessionId))
      );
      prevResultsSnap.forEach((d) => {
        const data = d.data() as ProductResult;
        openingMap.set(data.productId, safeNum(data.validRemainingQty));
      });
    }

    // 2. Factory transfers for this session
    const factorySentMap = new Map<string, number>();
    const factoryReceivedMap = new Map<string, number>();

    const transfersSnap = await getDocs(
      query(collection(db, 'factoryTransfers'), where('sessionId', '==', session.id))
    );
    for (const trfDoc of transfersSnap.docs) {
      const trf = trfDoc.data() as FactoryTransfer;
      const itemsSnap = await getDocs(collection(db, 'factoryTransfers', trfDoc.id, 'items'));
      itemsSnap.forEach((itemDoc) => {
        const item = itemDoc.data() as FactoryTransferItem;
        factorySentMap.set(
          item.productId,
          (factorySentMap.get(item.productId) || 0) + safeNum(item.sentQty)
        );
        if (trf.status !== 'pending_receipt' && item.receivedQty !== null && item.receivedQty !== undefined) {
          factoryReceivedMap.set(
            item.productId,
            (factoryReceivedMap.get(item.productId) || 0) + safeNum(item.receivedQty)
          );
        }
      });
    }

    // 3. Independent production entries
    const indProdMap = new Map<string, number>();
    const prodEntriesSnap = await getDocs(
      query(collection(db, 'productionEntries'), where('sessionId', '==', session.id))
    );
    prodEntriesSnap.forEach((d) => {
      const entry = d.data() as ProductionEntry;
      indProdMap.set(entry.productId, (indProdMap.get(entry.productId) || 0) + safeNum(entry.qty));
    });

    // 4. Department reports (production report items, sales, waste)
    const salesMap = new Map<string, number>();
    const damagedMap = new Map<string, number>();
    const validRemMap = new Map<string, number>();
    const invalidRemMap = new Map<string, number>();

    const reportsSnap = await getDocs(
      query(collection(db, 'departmentReports'), where('sessionId', '==', session.id))
    );
    for (const repDoc of reportsSnap.docs) {
      const rep = repDoc.data() as DepartmentReport;
      if (rep.status === 'draft') continue;
      const itemsSnap = await getDocs(collection(db, 'departmentReports', repDoc.id, 'items'));
      itemsSnap.forEach((itemDoc) => {
        const item = itemDoc.data() as DepartmentReportItem;
        if (rep.department === 'production' && item.independentProductionQty) {
          indProdMap.set(
            item.productId,
            (indProdMap.get(item.productId) || 0) + safeNum(item.independentProductionQty)
          );
        }
        if (rep.department === 'sales') {
          salesMap.set(item.productId, safeNum(item.salesQty ?? 0));
        }
        if (rep.department === 'waste') {
          damagedMap.set(item.productId, safeNum(item.damagedQty ?? 0));
          validRemMap.set(item.productId, safeNum(item.validRemainingQty ?? 0));
          invalidRemMap.set(item.productId, safeNum(item.invalidRemainingQty ?? 0));
        }
      });
    }

    // 5. Compute and persist centralized ProductResults
    const activeProducts = products.filter(
      (p) => p.approvalStatus === 'approved' && (p.isActive || openingMap.has(p.id))
    );
    const batch = writeBatch(db);
    const results: ProductResult[] = [];

    for (const prod of activeProducts) {
      const calc = calculateProductInventory({
        openingBalance: openingMap.get(prod.id) || 0,
        factorySentQty: factorySentMap.get(prod.id) || 0,
        factoryReceivedQty: factoryReceivedMap.get(prod.id) || 0,
        independentProductionQty: indProdMap.get(prod.id) || 0,
        salesQty: salesMap.get(prod.id) || 0,
        damagedQty: damagedMap.get(prod.id) || 0,
        validRemainingQty: validRemMap.get(prod.id) || 0,
        invalidRemainingQty: invalidRemMap.get(prod.id) || 0,
      });

      const resultId = sanitizeId(`${session.id}_${prod.id}`);
      const resultRef = doc(db, 'productResults', resultId);
      const existingSnap = await getDoc(resultRef);

      const docData: Record<string, unknown> = {
        sessionId: session.id,
        branchId: session.branchId,
        inventoryDate: session.inventoryDate,
        productId: prod.id,
        productName: prod.name.slice(0, 140),
        categoryId: prod.categoryId,
        categoryName: (categoryMap.get(prod.categoryId) || 'عام').slice(0, 100),
        unit: prod.unit.slice(0, 40),
        ...calc,
        isFinalized: session.status === 'closed',
        computedBy: actor.uid,
        createdAt: existingSnap.exists() ? existingSnap.data().createdAt : serverTimestamp(),
        updatedAt: serverTimestamp(),
      };

      batch.set(resultRef, docData);
      results.push({
        id: resultId,
        ...(docData as Omit<ProductResult, 'id'>),
      });
    }

    await batch.commit();
    return results;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'productResults');
  }
}

export async function closeDailySession(
  actor: UserAccount,
  session: DailySession,
  reports: DepartmentReport[],
  products: Product[],
  categories: Category[],
  decisionNote: string
): Promise<void> {
  await recalculateSessionResults(actor, session, products, categories);

  const batch = writeBatch(db);
  batch.update(doc(db, 'dailySessions', session.id), {
    status: 'closed',
    closedBy: actor.uid,
    closedByName: actor.fullName,
    closingDecisionNote: (decisionNote || 'تمت المراجعة والاعتماد وإغلاق اليوم').slice(0, 500),
    updatedAt: serverTimestamp(),
  });

  for (const rep of reports) {
    batch.update(doc(db, 'departmentReports', rep.id), {
      status: 'closed',
      approvedBy: actor.uid,
      approvedByName: actor.fullName,
      updatedAt: serverTimestamp(),
    });
  }

  const resultsSnap = await getDocs(
    query(collection(db, 'productResults'), where('sessionId', '==', session.id))
  );
  resultsSnap.forEach((d) => {
    batch.update(d.ref, { isFinalized: true, updatedAt: serverTimestamp() });
  });

  try {
    await batch.commit();
    await appendAuditLog({
      actor,
      action: 'إغلاق_يوم_الجرد',
      targetCollection: 'dailySessions',
      targetId: session.id,
      sessionId: session.id,
      inventoryDate: session.inventoryDate,
      branchId: session.branchId,
      department: 'management',
      reason: decisionNote,
      newValueSummary: 'تم إغلاق اليوم واعتماد نقل المتبقي الصالح فقط',
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `dailySessions/${session.id}`);
  }
}

export async function reopenDailySession(
  actor: UserAccount,
  session: DailySession,
  reports: DepartmentReport[],
  reason: string
): Promise<void> {
  if (!reason.trim()) {
    throw new Error('يجب إدخال سبب واضح لإعادة فتح اليوم المغلق.');
  }

  const batch = writeBatch(db);
  batch.update(doc(db, 'dailySessions', session.id), {
    status: 'reopened',
    reopenedBy: actor.uid,
    reopenedByName: actor.fullName,
    reopenReason: reason.trim().slice(0, 500),
    updatedAt: serverTimestamp(),
  });

  for (const rep of reports) {
    if (rep.status === 'closed') {
      batch.update(doc(db, 'departmentReports', rep.id), {
        status: 'submitted',
        updatedAt: serverTimestamp(),
      });
    }
  }

  const resultsSnap = await getDocs(
    query(collection(db, 'productResults'), where('sessionId', '==', session.id))
  );
  resultsSnap.forEach((d) => {
    batch.update(d.ref, { isFinalized: false, updatedAt: serverTimestamp() });
  });

  try {
    await batch.commit();
    await appendAuditLog({
      actor,
      action: 'إعادة_فتح_يوم_مغلق',
      targetCollection: 'dailySessions',
      targetId: session.id,
      sessionId: session.id,
      inventoryDate: session.inventoryDate,
      branchId: session.branchId,
      department: 'management',
      reason: reason.trim(),
      newValueSummary: 'إعادة فتح اليوم للتصحيح الموثق',
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `dailySessions/${session.id}`);
  }
}

// ==========================================
// POST-SUBMISSION CORRECTIONS & APPROVALS
// ==========================================

export async function requestReportCorrection(
  actor: UserAccount,
  report: DepartmentReport,
  product: Product,
  fieldKey:
    | 'preparedQty'
    | 'independentProductionQty'
    | 'salesQty'
    | 'damagedQty'
    | 'validRemainingQty'
    | 'invalidRemainingQty',
  oldValue: number | null,
  newValue: number,
  reason: string
): Promise<void> {
  if (!reason.trim()) {
    throw new Error('يجب كتابة سبب التعديل المطلوب.');
  }
  const approvalId = makeUniqueId('corr');
  try {
    await setDoc(doc(db, 'approvals', approvalId), {
      type: 'report_correction',
      sessionId: report.sessionId,
      inventoryDate: report.inventoryDate,
      targetCollection: 'departmentReports',
      targetId: report.id,
      productId: product.id,
      department: report.department,
      status: 'pending',
      reason: `${product.name}: ${reason.trim()}`.slice(0, 500),
      fieldKey,
      oldValue: oldValue ?? 0,
      newValue: safeNum(newValue),
      requestedBy: actor.uid,
      requestedByName: actor.fullName,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    await appendAuditLog({
      actor,
      action: 'طلب_تصحيح_تقرير_مرحل',
      targetCollection: 'approvals',
      targetId: approvalId,
      sessionId: report.sessionId,
      inventoryDate: report.inventoryDate,
      department: report.department,
      oldValueSummary: `${product.name} (${fieldKey}): ${oldValue ?? 0}`,
      newValueSummary: `${product.name} (${fieldKey}): ${safeNum(newValue)}`,
      reason: reason.trim(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `approvals/${approvalId}`);
  }
}

export async function reviewReportCorrection(
  actor: UserAccount,
  approval: ApprovalRequest,
  decision: 'approve' | 'reject',
  reviewNote: string,
  products: Product[],
  categories: Category[]
): Promise<void> {
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, 'approvals', approval.id), {
      status: decision === 'approve' ? 'approved' : 'rejected',
      reviewedBy: actor.uid,
      reviewedByName: actor.fullName,
      reviewNote: (reviewNote || (decision === 'approve' ? 'معتمد إدارياً' : 'مرفوض')).slice(0, 500),
      updatedAt: serverTimestamp(),
    });

    if (decision === 'approve' && approval.productId && approval.fieldKey) {
      const itemRef = doc(db, 'departmentReports', approval.targetId, 'items', approval.productId);
      const itemSnap = await getDoc(itemRef);
      const prod = products.find((p) => p.id === approval.productId);
      if (itemSnap.exists()) {
        batch.update(itemRef, {
          [approval.fieldKey]: safeNum(approval.newValue ?? 0),
          updatedBy: actor.uid,
          updatedByName: actor.fullName,
          updatedAt: serverTimestamp(),
        });
      } else if (prod && approval.sessionId && approval.inventoryDate && approval.department) {
        batch.set(itemRef, {
          reportId: approval.targetId,
          sessionId: approval.sessionId,
          branchId: DEFAULT_BRANCH_ID,
          inventoryDate: approval.inventoryDate,
          department: approval.department,
          productId: prod.id,
          categoryId: prod.categoryId,
          [approval.fieldKey]: safeNum(approval.newValue ?? 0),
          note: `تصحيح معتمد: ${approval.reason}`.slice(0, 300),
          updatedBy: actor.uid,
          updatedByName: actor.fullName,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
      batch.update(doc(db, 'departmentReports', approval.targetId), {
        lastCorrectionReason: approval.reason.slice(0, 500),
        updatedAt: serverTimestamp(),
      });
    }

    await batch.commit();

    if (decision === 'approve' && approval.sessionId) {
      const sessionSnap = await getDoc(doc(db, 'dailySessions', approval.sessionId));
      if (sessionSnap.exists()) {
        await recalculateSessionResults(
          actor,
          { id: sessionSnap.id, ...(sessionSnap.data() as Omit<DailySession, 'id'>) },
          products,
          categories
        );
      }
    }

    await appendAuditLog({
      actor,
      action: decision === 'approve' ? 'اعتماد_تصحيح_مرحل' : 'رفض_تصحيح_مرحل',
      targetCollection: 'approvals',
      targetId: approval.id,
      sessionId: approval.sessionId,
      inventoryDate: approval.inventoryDate,
      department: approval.department,
      oldValueSummary: `${approval.fieldKey}: ${approval.oldValue ?? 0}`,
      newValueSummary: `${approval.fieldKey}: ${approval.newValue ?? 0}`,
      reason: reviewNote || approval.reason,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `approvals/${approval.id}`);
  }
}
