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
  BOOTSTRAP_ADMIN_EMAIL,
  DEFAULT_BRANCH_ID,
  DEPARTMENT_LABELS,
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
  ProductUnitOption,
  ProductionEntry,
  ReportQtyFieldKey,
  UnitBreakdown,
  UserAccount,
  UserInvite,
  UserRole,
} from '../../types/inventory';
import { getPreviousAdenDate, makeSessionId, shiftIsoDate } from '../../utils/dateAden';
import {
  hashPassword,
  normalizePhoneForPassword,
  verifyPassword,
} from '../../utils/passwordCrypto';
import {
  buildNormalizedProductUnits,
  decomposeTotalToUnitCounts,
  formatBreakdownText,
  formatUnitsSummary,
  getEffectiveProductUnits,
  sanitizeUnitBreakdown,
} from '../../utils/productUnits';
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
    phoneNumber: string;
    role: Exclude<UserRole, 'pending'>;
    status: 'active' | 'suspended';
    permissions?: PermissionKey[];
  }
): Promise<void> {
  const normalizedEmail = input.email.trim().toLowerCase();
  const cleanEmployeeNumber = input.employeeNumber.trim().slice(0, 40);
  const cleanUsername = input.username.trim().slice(0, 80);
  const cleanFullName = input.fullName.trim().slice(0, 120);
  const cleanPhone = input.phoneNumber.trim().slice(0, 40);
  const cleanPhonePass = normalizePhoneForPassword(cleanPhone);

  if (!normalizedEmail || !cleanEmployeeNumber || !cleanUsername || !cleanFullName || !cleanPhone) {
    throw new Error('يرجى إدخال جميع البيانات الأساسية للموظف بما فيها رقم الهاتف.');
  }
  if (cleanPhonePass.length < 4) {
    throw new Error('رقم الهاتف يجب أن لا يقل عن 4 أرقام لأنه يُستخدم ككلمة مرور مبدئية.');
  }

  const inviteId = makeUniqueId('inv');
  const department = getDepartmentForRole(input.role);
  const permissions = input.permissions?.length
    ? input.permissions
    : getDefaultPermissionsForRole(input.role);

  const { salt, hash } = await hashPassword(cleanPhonePass);

  try {
    await setDoc(doc(db, 'userInvites', inviteId), {
      email: normalizedEmail,
      employeeNumber: cleanEmployeeNumber,
      username: cleanUsername,
      fullName: cleanFullName,
      phoneNumber: cleanPhone,
      passwordSalt: salt,
      passwordHash: hash,
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
      newValueSummary: `${cleanFullName} (${normalizedEmail}) - ${input.role}`,
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
    phoneNumber?: string;
    resetPasswordToPhone?: boolean;
    role: UserRole;
    status: 'active' | 'suspended';
    permissions: PermissionKey[];
  }
): Promise<void> {
  const department =
    updates.role === 'pending' ? targetUser.department : getDepartmentForRole(updates.role);
  const cleanEmployeeNumber = (updates.employeeNumber || '').trim().slice(0, 40);
  const cleanUsername = (updates.username || '').trim().slice(0, 80);
  const cleanFullName = (updates.fullName || '').trim().slice(0, 120);
  const cleanPhone = (updates.phoneNumber ?? targetUser.phoneNumber ?? '').trim().slice(0, 40);
  const cleanPhonePass = normalizePhoneForPassword(cleanPhone);

  if (updates.status === 'active') {
    if (!cleanEmployeeNumber || !cleanUsername || !cleanFullName || !cleanPhone) {
      throw new Error(
        'يجب إدخال جميع البيانات الأساسية للموظف (الرقم الوظيفي، الاسم الكامل، اسم المستخدم، ورقم الهاتف) قبل التفعيل.'
      );
    }
    if (cleanPhonePass.length < 4) {
      throw new Error('رقم الهاتف يجب أن لا يقل عن 4 أرقام لأنه يُستخدم ككلمة مرور مبدئية.');
    }
  }

  const finalEmpNo =
    cleanEmployeeNumber || (targetUser.employeeNumber || 'EMP-100').trim().slice(0, 40);
  const finalUsername =
    cleanUsername || (targetUser.username || targetUser.email.split('@')[0] || 'user').trim().slice(0, 80);
  const finalFullName =
    finalUsername && !cleanFullName
      ? (targetUser.fullName || finalUsername).trim().slice(0, 120)
      : cleanFullName || (targetUser.fullName || 'موظف').trim().slice(0, 120);

  const batch = writeBatch(db);
  const userRef = doc(db, 'users', targetUser.uid);

  const userPayload: Record<string, unknown> = {
    employeeNumber: finalEmpNo,
    username: finalUsername,
    fullName: finalFullName,
    department,
    role: updates.role,
    status: updates.status,
    permissions: updates.permissions,
    updatedAt: serverTimestamp(),
  };

  if (cleanPhone) {
    userPayload.phoneNumber = cleanPhone;
  }

  const shouldSetInitialPassword =
    cleanPhonePass.length >= 4 &&
    (updates.resetPasswordToPhone || !targetUser.passwordHash || !targetUser.passwordSalt);

  if (shouldSetInitialPassword) {
    const { salt, hash } = await hashPassword(cleanPhonePass);
    userPayload.passwordSalt = salt;
    userPayload.passwordHash = hash;
  }

  batch.update(userRef, userPayload);

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
      newValueSummary: `${finalFullName} (${finalEmpNo}) - ${updates.role} (${updates.status})`,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `users/${targetUser.uid}`);
  }
}

export async function changeOwnPassword(
  actor: UserAccount,
  currentPassword: string,
  newPassword: string
): Promise<void> {
  const trimmedNew = newPassword.trim();
  const trimmedCurrent = currentPassword.trim();

  if (trimmedNew.length < 4 || trimmedNew.length > 64) {
    throw new Error('يجب أن تتكون كلمة المرور الجديدة من 4 إلى 64 خانة.');
  }

  if (actor.passwordHash && actor.passwordSalt) {
    let valid = await verifyPassword(trimmedCurrent, actor.passwordSalt, actor.passwordHash);
    if (!valid) {
      const normalizedCurrent = normalizePhoneForPassword(currentPassword);
      if (normalizedCurrent && normalizedCurrent !== trimmedCurrent) {
        valid = await verifyPassword(normalizedCurrent, actor.passwordSalt, actor.passwordHash);
      }
    }
    if (!valid) {
      throw new Error('كلمة المرور الحالية غير صحيحة.');
    }
  } else if (actor.phoneNumber) {
    const expectedPhone = normalizePhoneForPassword(actor.phoneNumber);
    const entered = normalizePhoneForPassword(currentPassword);
    if (entered !== expectedPhone) {
      throw new Error('كلمة المرور الحالية غير صحيحة.');
    }
  }

  const { salt, hash } = await hashPassword(trimmedNew);

  try {
    await updateDoc(doc(db, 'users', actor.uid), {
      passwordSalt: salt,
      passwordHash: hash,
      passwordUpdatedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    await appendAuditLog({
      actor,
      action: 'تغيير_كلمة_المرور',
      targetCollection: 'users',
      targetId: actor.uid,
      department: actor.department,
      newValueSummary: 'تم تحديث كلمة المرور بنجاح من قبل صاحب الحساب',
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `users/${actor.uid}`);
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
    units?: ProductUnitOption[];
    allowedDepartments: OperationalDepartmentId[];
    reason?: string;
  }
): Promise<void> {
  const productId = makeUniqueId('prod');
  const approvalId = makeUniqueId('app');
  const batch = writeBatch(db);
  const cleanUnit = input.unit.trim().slice(0, 40) || 'وحدة';
  const normalizedUnits = buildNormalizedProductUnits(cleanUnit, input.units);

  batch.set(doc(db, 'products', productId), {
    name: input.name.trim().slice(0, 140),
    categoryId: input.categoryId,
    unit: cleanUnit,
    units: normalizedUnits,
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
      newValueSummary: `${input.name} (${formatUnitsSummary(normalizedUnits)})`,
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
    units?: ProductUnitOption[];
    allowedDepartments: OperationalDepartmentId[];
  }
): Promise<void> {
  const productId = makeUniqueId('prod');
  const cleanUnit = input.unit.trim().slice(0, 40) || 'وحدة';
  const normalizedUnits = buildNormalizedProductUnits(cleanUnit, input.units);
  try {
    await setDoc(doc(db, 'products', productId), {
      name: input.name.trim().slice(0, 140),
      categoryId: input.categoryId,
      unit: cleanUnit,
      units: normalizedUnits,
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
      newValueSummary: `${input.name} (${formatUnitsSummary(normalizedUnits)})`,
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
    units?: ProductUnitOption[];
    isActive: boolean;
    allowedDepartments: OperationalDepartmentId[];
  }
): Promise<void> {
  const cleanName = updates.name.trim().slice(0, 140);
  const cleanUnit = updates.unit.trim().slice(0, 40);
  if (!cleanName) {
    throw new Error('يرجى إدخال اسم الصنف.');
  }
  if (!cleanUnit) {
    throw new Error('يرجى إدخال وحدة القياس.');
  }
  if (!updates.categoryId) {
    throw new Error('يرجى اختيار المجموعة.');
  }
  if (!updates.allowedDepartments || updates.allowedDepartments.length === 0) {
    throw new Error('اختر إدارة واحدة على الأقل.');
  }

  const normalizedUnits = buildNormalizedProductUnits(
    cleanUnit,
    updates.units ?? product.units
  );

  try {
    await updateDoc(doc(db, 'products', product.id), {
      name: cleanName,
      categoryId: updates.categoryId,
      unit: cleanUnit,
      units: normalizedUnits,
      isActive: updates.isActive,
      approvalStatus: updates.isActive ? 'approved' : 'inactive',
      allowedDepartments: updates.allowedDepartments,
      updatedAt: serverTimestamp(),
    });

    // Best-effort sync of non-finalized daily result rows when name, unit, or category changed
    if (
      cleanName !== product.name ||
      cleanUnit !== product.unit ||
      updates.categoryId !== product.categoryId
    ) {
      try {
        let nextCategoryName: string | undefined;
        if (updates.categoryId !== product.categoryId) {
          const catSnap = await getDoc(doc(db, 'categories', updates.categoryId));
          if (catSnap.exists()) {
            nextCategoryName = String(catSnap.data()?.name || '').slice(0, 100);
          }
        }
        const resultsSnap = await getDocs(
          query(collection(db, 'productResults'), where('productId', '==', product.id))
        );
        const openDocs = resultsSnap.docs.filter((d) => d.data()?.isFinalized === false);
        if (openDocs.length > 0) {
          const syncBatch = writeBatch(db);
          for (const resDoc of openDocs) {
            const patch: Record<string, unknown> = {
              productName: cleanName,
              unit: cleanUnit,
              categoryId: updates.categoryId,
              computedBy: actor.uid,
              updatedAt: serverTimestamp(),
            };
            if (nextCategoryName) {
              patch.categoryName = nextCategoryName;
            }
            syncBatch.update(resDoc.ref, patch);
          }
          await syncBatch.commit();
        }
      } catch (syncErr) {
        console.warn('Product results name sync skipped:', syncErr);
      }
    }

    await appendAuditLog({
      actor,
      action: 'تعديل_بيانات_صنف',
      targetCollection: 'products',
      targetId: product.id,
      oldValueSummary: `${product.name} · ${product.unit} · ${product.isActive ? 'نشط' : 'موقوف'}`,
      newValueSummary: `${cleanName} · ${formatUnitsSummary(normalizedUnits)} · ${updates.isActive ? 'نشط' : 'موقوف'}`,
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
    unitBreakdowns?: Partial<Record<ReportQtyFieldKey, UnitBreakdown>> | null;
    note?: string;
  }>
): Promise<void> {
  const canEditSubmittedFactory =
    report.department === 'factory' && report.status === 'submitted';
  if (report.status !== 'draft' && !canEditSubmittedFactory) {
    throw new Error('لا يمكن تعديل تقرير تم ترحيله بالفعل. يمكنك تقديم طلب تصحيح إداري.');
  }

  try {
    const existingSnap = await getDocs(
      query(
        collection(db, 'departmentReports', report.id, 'items'),
        where('department', '==', report.department)
      )
    );
    const existingCreatedAtMap = new Map<string, unknown>();
    existingSnap.forEach((d) => {
      existingCreatedAtMap.set(d.id, d.data().createdAt);
    });

    const batch = writeBatch(db);
    let enteredCount = 0;
    const actorName = (actor.fullName || actor.username || 'موظف').trim().slice(0, 120);

    for (const item of items) {
      const hasAnyValue =
        (item.preparedQty !== undefined && item.preparedQty !== null) ||
        (item.independentProductionQty !== undefined && item.independentProductionQty !== null) ||
        (item.salesQty !== undefined && item.salesQty !== null) ||
        (item.damagedQty !== undefined && item.damagedQty !== null) ||
        (item.validRemainingQty !== undefined && item.validRemainingQty !== null) ||
        (item.invalidRemainingQty !== undefined && item.invalidRemainingQty !== null);

      if (hasAnyValue) enteredCount++;

      const alreadyExists = existingCreatedAtMap.has(item.productId);
      if (!hasAnyValue && !alreadyExists) {
        continue;
      }

      const cleanBreakdowns: Partial<Record<ReportQtyFieldKey, UnitBreakdown>> = {};
      if (item.unitBreakdowns && typeof item.unitBreakdowns === 'object') {
        const keys: ReportQtyFieldKey[] = [
          'preparedQty',
          'independentProductionQty',
          'salesQty',
          'damagedQty',
          'validRemainingQty',
          'invalidRemainingQty',
        ];
        for (const k of keys) {
          const cleaned = sanitizeUnitBreakdown(item.unitBreakdowns[k]);
          if (cleaned) {
            cleanBreakdowns[k] = cleaned;
          }
        }
      }

      const itemRef = doc(db, 'departmentReports', report.id, 'items', item.productId);
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
        unitBreakdowns: Object.keys(cleanBreakdowns).length > 0 ? cleanBreakdowns : null,
        note: (item.note || '').slice(0, 300),
        updatedBy: actor.uid,
        updatedByName: actorName,
        updatedAt: serverTimestamp(),
      };

      const existingCreatedAt = existingCreatedAtMap.get(item.productId);
      payload.createdAt = existingCreatedAt || serverTimestamp();

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
  const isFactoryReupdate = report.department === 'factory' && report.status === 'submitted';
  if (report.status !== 'draft' && !isFactoryReupdate) {
    throw new Error('تم ترحيل هذا التقرير مسبقاً.');
  }
  if (enteredCount <= 0) {
    throw new Error('لا يمكن ترحيل تقرير فارغ. يرجى إدخال صنف واحد على الأقل (حتى لو بقيمة 0).');
  }

  const actorName = (actor.fullName || actor.username || 'موظف').trim().slice(0, 120);

  try {
    await updateDoc(doc(db, 'departmentReports', report.id), {
      status: 'submitted',
      itemCount: enteredCount,
      submittedBy: actor.uid,
      submittedByName: actorName,
      ...(isFactoryReupdate
        ? { lastCorrectionReason: 'تحديث مباشر من المعمل قبل إغلاق اليوم' }
        : {}),
      updatedAt: serverTimestamp(),
    });

    await appendAuditLog({
      actor,
      action: isFactoryReupdate ? 'تحديث_تقرير_المعمل_المفتوح' : 'ترحيل_تقرير_إدارة',
      targetCollection: 'departmentReports',
      targetId: report.id,
      sessionId: report.sessionId,
      inventoryDate: report.inventoryDate,
      branchId: report.branchId,
      department: report.department,
      newValueSummary: `${isFactoryReupdate ? 'تحديث' : 'ترحيل'} تقرير ${report.department} (${enteredCount} صنف)`,
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
  items: Array<{ product: Product; sentQty: number; sentBreakdown?: UnitBreakdown; note?: string }>,
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
  const actorName = (actor.fullName || actor.username || 'موظف المعمل').trim().slice(0, 120);
  batch.set(doc(db, 'factoryTransfers', transferId), {
    sessionId: session.id,
    branchId: session.branchId,
    inventoryDate: session.inventoryDate,
    transferNumber,
    transferType: 'dispatch',
    status: 'pending_receipt',
    totalSentQty,
    totalReceivedQty: 0,
    totalVarianceQty: 0,
    factoryNote: factoryNote.trim().slice(0, 400),
    createdBy: actor.uid,
    createdByName: actorName,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  for (const item of validItems) {
    const cleanSentBreakdown = sanitizeUnitBreakdown(item.sentBreakdown);
    batch.set(doc(db, 'factoryTransfers', transferId, 'items', item.product.id), {
      transferId,
      sessionId: session.id,
      productId: item.product.id,
      productName: item.product.name.slice(0, 140),
      unit: item.product.unit.slice(0, 40),
      sentQty: safeNum(item.sentQty),
      sentBreakdown: cleanSentBreakdown ?? null,
      receivedQty: null,
      receivedBreakdown: null,
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

export async function updateFactoryTransfer(
  actor: UserAccount,
  transfer: FactoryTransfer,
  items: Array<{ product: Product; sentQty: number; sentBreakdown?: UnitBreakdown; note?: string }>,
  factoryNote: string
): Promise<void> {
  if (transfer.status !== 'pending_receipt' && transfer.status !== 'returned') {
    throw new Error('لا يمكن تعديل توريد تم تأكيد استلامه بالفعل من قسم الإنتاج.');
  }
  for (const i of items) {
    if (Number.isNaN(i.sentQty) || i.sentQty < 0) {
      throw new Error(`الكمية للصنف "${i.product.name}" غير صالحة.`);
    }
  }
  const validItems = items.filter((i) => i.sentQty > 0);
  if (validItems.length === 0) {
    throw new Error('لا يمكن حفظ إشعار فارغ. أدخل كمية أكبر من صفر أو احذف الإشعار.');
  }

  const isReturn = transfer.status === 'returned' || transfer.transferType === 'return';
  const totalSentQty = roundQty(validItems.reduce((acc, i) => acc + safeNum(i.sentQty), 0));
  const existingItemsSnap = await getDocs(
    collection(db, 'factoryTransfers', transfer.id, 'items')
  );
  const existingCreatedAt = new Map<string, unknown>();
  existingItemsSnap.forEach((d) => {
    existingCreatedAt.set(d.id, d.data().createdAt);
  });

  const keepIds = new Set(validItems.map((i) => i.product.id));
  const batch = writeBatch(db);

  existingItemsSnap.forEach((d) => {
    if (!keepIds.has(d.id)) {
      batch.delete(d.ref);
    }
  });

  for (const item of validItems) {
    const cleanBreakdown = sanitizeUnitBreakdown(item.sentBreakdown);
    const cleanQty = safeNum(item.sentQty);
    const itemRef = doc(db, 'factoryTransfers', transfer.id, 'items', item.product.id);
    const prevCreated = existingCreatedAt.get(item.product.id);
    batch.set(itemRef, {
      transferId: transfer.id,
      sessionId: transfer.sessionId,
      productId: item.product.id,
      productName: item.product.name.slice(0, 140),
      unit: item.product.unit.slice(0, 40),
      sentQty: cleanQty,
      sentBreakdown: cleanBreakdown ?? null,
      receivedQty: isReturn ? cleanQty : null,
      receivedBreakdown: isReturn ? (cleanBreakdown ?? null) : null,
      varianceQty: isReturn ? 0 : null,
      note: (item.note || '').slice(0, 300),
      createdAt: prevCreated || serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  batch.update(doc(db, 'factoryTransfers', transfer.id), {
    totalSentQty,
    ...(isReturn ? { totalReceivedQty: totalSentQty } : {}),
    factoryNote: factoryNote.trim().slice(0, 400),
    updatedAt: serverTimestamp(),
  });

  try {
    await batch.commit();
    await appendAuditLog({
      actor,
      action: isReturn ? 'تعديل_مرتجع_معمل' : 'تعديل_توريد_معمل',
      targetCollection: 'factoryTransfers',
      targetId: transfer.id,
      sessionId: transfer.sessionId,
      inventoryDate: transfer.inventoryDate,
      branchId: transfer.branchId,
      department: 'factory',
      oldValueSummary: `${transfer.transferNumber}: ${transfer.totalSentQty} وحدة`,
      newValueSummary: `${transfer.transferNumber}: ${totalSentQty} وحدة`,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `factoryTransfers/${transfer.id}`);
  }
}

export async function deleteFactoryTransfer(
  actor: UserAccount,
  transfer: FactoryTransfer,
  products?: Product[],
  categories?: Category[]
): Promise<void> {
  if (transfer.status !== 'pending_receipt' && transfer.status !== 'returned') {
    throw new Error('لا يمكن حذف توريد تم تأكيد استلامه بالفعل من قسم الإنتاج.');
  }

  const isReturn = transfer.status === 'returned' || transfer.transferType === 'return';
  const itemsSnap = await getDocs(collection(db, 'factoryTransfers', transfer.id, 'items'));
  const batch = writeBatch(db);
  itemsSnap.forEach((d) => batch.delete(d.ref));
  batch.delete(doc(db, 'factoryTransfers', transfer.id));

  try {
    await batch.commit();
    await appendAuditLog({
      actor,
      action: isReturn ? 'حذف_مرتجع_معمل' : 'حذف_توريد_معمل',
      targetCollection: 'factoryTransfers',
      targetId: transfer.id,
      sessionId: transfer.sessionId,
      inventoryDate: transfer.inventoryDate,
      branchId: transfer.branchId,
      department: 'factory',
      oldValueSummary: `${transfer.transferNumber}: ${transfer.totalSentQty} وحدة`,
    });

    const isActorAdmin =
      actor.role === 'ceo' ||
      actor.role === 'branch_manager' ||
      actor.email.toLowerCase() === BOOTSTRAP_ADMIN_EMAIL;
    if (isActorAdmin && products && categories && products.length > 0 && categories.length > 0) {
      const sessSnap = await getDoc(doc(db, 'dailySessions', transfer.sessionId));
      if (sessSnap.exists()) {
        await recalculateSessionResults(
          actor,
          { id: sessSnap.id, ...(sessSnap.data() as Omit<DailySession, 'id'>) },
          products,
          categories
        );
      }
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `factoryTransfers/${transfer.id}`);
  }
}

export async function createFactoryReturn(
  actor: UserAccount,
  session: DailySession,
  items: Array<{ product: Product; returnedQty: number; returnedBreakdown?: UnitBreakdown; note?: string }>,
  returnNote: string,
  products?: Product[],
  categories?: Category[]
): Promise<void> {
  for (const i of items) {
    if (Number.isNaN(i.returnedQty) || i.returnedQty < 0) {
      throw new Error(`الكمية المرتجعة للصنف "${i.product.name}" غير صالحة.`);
    }
  }
  const validItems = items.filter((i) => i.returnedQty > 0);
  if (validItems.length === 0) {
    throw new Error('لا يمكن تسجيل مرتجع فارغ. أدخل كمية أكبر من صفر لصنف واحد على الأقل.');
  }

  // Verify against same-day transferred quantities so returns never exceed what was transferred today
  const existingTransfersSnap = await getDocs(
    query(collection(db, 'factoryTransfers'), where('sessionId', '==', session.id))
  );
  const grossSentMap = new Map<string, number>();
  const alreadyReturnedMap = new Map<string, number>();

  for (const trfDoc of existingTransfersSnap.docs) {
    const trf = trfDoc.data() as FactoryTransfer;
    const trfItemsSnap = await getDocs(collection(db, 'factoryTransfers', trfDoc.id, 'items'));
    trfItemsSnap.forEach((d) => {
      const it = d.data() as FactoryTransferItem;
      if (trf.transferType === 'return' || trf.status === 'returned') {
        alreadyReturnedMap.set(
          it.productId,
          roundQty((alreadyReturnedMap.get(it.productId) || 0) + safeNum(it.sentQty))
        );
      } else {
        grossSentMap.set(
          it.productId,
          roundQty((grossSentMap.get(it.productId) || 0) + safeNum(it.sentQty))
        );
      }
    });
  }

  for (const item of validItems) {
    const dispatched = grossSentMap.get(item.product.id) || 0;
    const prevReturned = alreadyReturnedMap.get(item.product.id) || 0;
    const availableToReturn = Math.max(0, roundQty(dispatched - prevReturned));
    if (item.returnedQty > availableToReturn + 0.0001) {
      throw new Error(
        `الكمية المرتجعة للصنف "${item.product.name}" (${item.returnedQty}) تتجاوز الكمية المرحلة المتاحة اليوم (${availableToReturn}).`
      );
    }
  }

  const transferId = makeUniqueId('ret');
  const transferNumber = `RET-${session.inventoryDate.replace(/-/g, '')}-${String(Date.now()).slice(-4)}`;
  const totalReturnedQty = roundQty(validItems.reduce((acc, i) => acc + safeNum(i.returnedQty), 0));
  const actorName = (actor.fullName || actor.username || 'موظف المعمل').trim().slice(0, 120);

  const batch = writeBatch(db);
  batch.set(doc(db, 'factoryTransfers', transferId), {
    sessionId: session.id,
    branchId: session.branchId,
    inventoryDate: session.inventoryDate,
    transferNumber,
    transferType: 'return',
    status: 'returned',
    totalSentQty: totalReturnedQty,
    totalReceivedQty: totalReturnedQty,
    totalVarianceQty: 0,
    factoryNote: returnNote.trim().slice(0, 400),
    productionNote: 'مرتجع مسحوب تلقائياً من كميات اليوم إلى المعمل',
    createdBy: actor.uid,
    createdByName: actorName,
    receivedBy: actor.uid,
    receivedByName: actorName,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  for (const item of validItems) {
    const cleanBreakdown = sanitizeUnitBreakdown(item.returnedBreakdown);
    const cleanQty = safeNum(item.returnedQty);
    batch.set(doc(db, 'factoryTransfers', transferId, 'items', item.product.id), {
      transferId,
      sessionId: session.id,
      productId: item.product.id,
      productName: item.product.name.slice(0, 140),
      unit: item.product.unit.slice(0, 40),
      sentQty: cleanQty,
      receivedQty: cleanQty,
      varianceQty: 0,
      sentBreakdown: cleanBreakdown ?? null,
      receivedBreakdown: cleanBreakdown ?? null,
      note: (item.note || returnNote || 'مرتجع من الإنتاج إلى المعمل').slice(0, 300),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  // Also deduct returned quantities from Factory's prepared report items if editable by this actor
  const factoryReportId = sanitizeId(`${session.id}_factory`);
  const isActorAdmin =
    actor.role === 'ceo' ||
    actor.role === 'branch_manager' ||
    actor.email.toLowerCase() === BOOTSTRAP_ADMIN_EMAIL;

  try {
    const repSnap = await getDoc(doc(db, 'departmentReports', factoryReportId));
    if (repSnap.exists()) {
      const repData = repSnap.data() as DepartmentReport;
      const canEditReportItems =
        (repData.status === 'draft' && (actor.department === 'factory' || isActorAdmin)) ||
        (repData.status !== 'draft' && isActorAdmin);

      if (canEditReportItems) {
        const repItemsSnap = await getDocs(
          collection(db, 'departmentReports', factoryReportId, 'items')
        );
        const repItemByProductId = new Map<string, DepartmentReportItem>();
        repItemsSnap.forEach((d) => {
          repItemByProductId.set(d.id, d.data() as DepartmentReportItem);
        });

        for (const item of validItems) {
          const existingItem = repItemByProductId.get(item.product.id);
          if (
            existingItem &&
            existingItem.preparedQty !== null &&
            existingItem.preparedQty !== undefined
          ) {
            const nextPrepared = Math.max(
              0,
              roundQty(safeNum(existingItem.preparedQty) - safeNum(item.returnedQty))
            );
            const effUnits = getEffectiveProductUnits(item.product);
            const nextCounts = decomposeTotalToUnitCounts(nextPrepared, effUnits);
            const nextBreakdown: UnitBreakdown = {};
            for (const u of effUnits) {
              const cnt = Number(nextCounts[u.name] || 0);
              if (cnt > 0) nextBreakdown[u.name] = roundQty(cnt);
            }
            const nextUnitBreakdowns = {
              ...(existingItem.unitBreakdowns || {}),
              ...(Object.keys(nextBreakdown).length > 0 ? { preparedQty: nextBreakdown } : {}),
            };
            if (Object.keys(nextBreakdown).length === 0) {
              delete nextUnitBreakdowns.preparedQty;
            }

            batch.update(doc(db, 'departmentReports', factoryReportId, 'items', item.product.id), {
              preparedQty: nextPrepared,
              unitBreakdowns:
                Object.keys(nextUnitBreakdowns).length > 0 ? nextUnitBreakdowns : null,
              updatedBy: actor.uid,
              updatedByName: actorName,
              updatedAt: serverTimestamp(),
            });
          }
        }
      }
    }
  } catch (repErr) {
    console.warn('Skipped prepared report sync during return:', repErr);
  }

  try {
    await batch.commit();
    await appendAuditLog({
      actor,
      action: 'سحب_مرتجع_من_الإنتاج_للمعمل',
      targetCollection: 'factoryTransfers',
      targetId: transferId,
      sessionId: session.id,
      inventoryDate: session.inventoryDate,
      branchId: session.branchId,
      department: 'factory',
      newValueSummary: `مرتجع ${transferNumber} بإجمالي ${totalReturnedQty} وحدة (${validItems
        .map((i) => `${i.product.name}: ${i.returnedQty}`)
        .join('، ')})`,
      reason: returnNote,
    });

    if (isActorAdmin && products && categories && products.length > 0 && categories.length > 0) {
      await recalculateSessionResults(actor, session, products, categories);
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `factoryTransfers/${transferId}`);
  }
}

export async function confirmTransferReceipt(
  actor: UserAccount,
  transfer: FactoryTransfer,
  receivedItems: Array<{
    item: FactoryTransferItem;
    receivedQty: number;
    receivedBreakdown?: UnitBreakdown;
    note?: string;
  }>,
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
    const cleanRecBreakdown = sanitizeUnitBreakdown(row.receivedBreakdown);

    batch.update(doc(db, 'factoryTransfers', transfer.id, 'items', row.item.productId), {
      receivedQty: rec,
      receivedBreakdown: cleanRecBreakdown ?? null,
      varianceQty: variance,
      note: (row.note || row.item.note || '').slice(0, 300),
      updatedAt: serverTimestamp(),
    });
  }

  const newStatus = hasDiscrepancy ? 'discrepancy_logged' : 'received';
  const actorName = (actor.fullName || actor.username || 'موظف الإنتاج').trim().slice(0, 120);

  batch.update(doc(db, 'factoryTransfers', transfer.id), {
    status: newStatus,
    totalReceivedQty: roundQty(totalReceivedQty),
    totalVarianceQty: roundQty(totalVarianceQty),
    productionNote: productionNote.trim().slice(0, 400),
    receivedBy: actor.uid,
    receivedByName: actorName,
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
  note: string,
  unitBreakdown?: UnitBreakdown
): Promise<void> {
  if (qty <= 0) {
    throw new Error('يجب أن تكون كمية الإنتاج المستقل أكبر من صفر.');
  }
  const entryId = makeUniqueId('ind');
  const actorName = (actor.fullName || actor.username || 'موظف الإنتاج').trim().slice(0, 120);
  const cleanBreakdown = sanitizeUnitBreakdown(unitBreakdown);
  const breakdownText = cleanBreakdown ? formatBreakdownText(cleanBreakdown, product.units) : '';
  try {
    await setDoc(doc(db, 'productionEntries', entryId), {
      sessionId: session.id,
      branchId: session.branchId,
      inventoryDate: session.inventoryDate,
      productId: product.id,
      qty: safeNum(qty),
      unitBreakdown: cleanBreakdown ?? null,
      note: note.trim().slice(0, 300),
      createdBy: actor.uid,
      createdByName: actorName,
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
      newValueSummary: breakdownText
        ? `${product.name}: ${safeNum(qty)} ${product.unit} (${breakdownText})`
        : `${product.name}: ${safeNum(qty)} ${product.unit}`,
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

    // 1. Opening balance: finalized from previous CLOSED session's validRemainingQty,
    // or live-previewed from previous unclosed session's waste report / productResults for pre-close matching.
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

      const isActorAdmin =
        actor.role === 'ceo' ||
        actor.role === 'branch_manager' ||
        actor.email.toLowerCase() === BOOTSTRAP_ADMIN_EMAIL;
      if (isActorAdmin && !session.openingBalanceApproved && session.status !== 'closed') {
        await updateDoc(doc(db, 'dailySessions', session.id), {
          openingBalanceApproved: true,
          updatedAt: serverTimestamp(),
        });
      }
    } else {
      try {
        const prevResultsSnap = await getDocs(
          query(collection(db, 'productResults'), where('sessionId', '==', prevSessionId))
        );
        prevResultsSnap.forEach((d) => {
          const data = d.data() as ProductResult;
          openingMap.set(data.productId, safeNum(data.validRemainingQty));
        });

        const prevWasteItemsSnap = await getDocs(
          collection(db, 'departmentReports', sanitizeId(`${prevSessionId}_waste`), 'items')
        );
        prevWasteItemsSnap.forEach((d) => {
          const item = d.data() as DepartmentReportItem;
          if (item.validRemainingQty !== null && item.validRemainingQty !== undefined) {
            openingMap.set(item.productId, safeNum(item.validRemainingQty));
          }
        });
      } catch {
        // Ignore if actor cannot read previous unclosed waste items
      }
    }

    // 2. Factory transfers & same-day returns for this session
    const factorySentMap = new Map<string, number>();
    const factoryReceivedMap = new Map<string, number>();
    const factoryReturnedMap = new Map<string, number>();

    const transfersSnap = await getDocs(
      query(collection(db, 'factoryTransfers'), where('sessionId', '==', session.id))
    );
    for (const trfDoc of transfersSnap.docs) {
      const trf = trfDoc.data() as FactoryTransfer;
      const itemsSnap = await getDocs(collection(db, 'factoryTransfers', trfDoc.id, 'items'));
      const isReturn = trf.transferType === 'return' || trf.status === 'returned';
      itemsSnap.forEach((itemDoc) => {
        const item = itemDoc.data() as FactoryTransferItem;
        if (isReturn) {
          factoryReturnedMap.set(
            item.productId,
            roundQty((factoryReturnedMap.get(item.productId) || 0) + safeNum(item.sentQty))
          );
          return;
        }
        factorySentMap.set(
          item.productId,
          roundQty((factorySentMap.get(item.productId) || 0) + safeNum(item.sentQty))
        );
        if (trf.status !== 'pending_receipt' && item.receivedQty !== null && item.receivedQty !== undefined) {
          factoryReceivedMap.set(
            item.productId,
            roundQty((factoryReceivedMap.get(item.productId) || 0) + safeNum(item.receivedQty))
          );
        }
      });
    }

    // 3. Independent production entries (used while production report is still draft)
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
    const submittedProdMap = new Map<string, number>();
    let hasSubmittedProdReport = false;

    const reportsSnap = await getDocs(
      query(collection(db, 'departmentReports'), where('sessionId', '==', session.id))
    );
    for (const repDoc of reportsSnap.docs) {
      const rep = repDoc.data() as DepartmentReport;
      if (rep.status === 'draft') continue;
      const itemsSnap = await getDocs(collection(db, 'departmentReports', repDoc.id, 'items'));
      if (rep.department === 'production') {
        hasSubmittedProdReport = true;
      }
      itemsSnap.forEach((itemDoc) => {
        const item = itemDoc.data() as DepartmentReportItem;
        if (rep.department === 'production' && item.independentProductionQty !== null && item.independentProductionQty !== undefined) {
          submittedProdMap.set(item.productId, safeNum(item.independentProductionQty));
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

    if (hasSubmittedProdReport) {
      indProdMap.clear();
      submittedProdMap.forEach((val, key) => {
        indProdMap.set(key, val);
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
        factoryReturnedQty: factoryReturnedMap.get(prod.id) || 0,
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
    batch.update(d.ref, { isFinalized: true, computedBy: actor.uid, updatedAt: serverTimestamp() });
  });

  // If the next day's session already exists, mark its opening balance as approved so it receives carried-over validRemainingQty
  const nextDate = shiftIsoDate(session.inventoryDate, 1);
  const nextSessionId = makeSessionId(session.branchId, nextDate);
  const nextSessionRef = doc(db, 'dailySessions', nextSessionId);
  const nextSessionSnap = await getDoc(nextSessionRef);
  if (nextSessionSnap.exists()) {
    batch.update(nextSessionRef, {
      openingBalanceApproved: true,
      updatedAt: serverTimestamp(),
    });
  }

  try {
    await batch.commit();

    if (nextSessionSnap.exists()) {
      const nextSessionData = {
        id: nextSessionSnap.id,
        ...(nextSessionSnap.data() as Omit<DailySession, 'id'>),
        openingBalanceApproved: true,
      };
      if (nextSessionData.status !== 'closed') {
        await recalculateSessionResults(actor, nextSessionData, products, categories);
      }
    }

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
      newValueSummary: 'تم إغلاق اليوم واعتماد نقل المتبقي الصالح فقط لليوم التالي',
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
    batch.update(d.ref, { isFinalized: false, computedBy: actor.uid, updatedAt: serverTimestamp() });
  });

  const nextDate = shiftIsoDate(session.inventoryDate, 1);
  const nextSessionId = makeSessionId(session.branchId, nextDate);
  const nextSessionRef = doc(db, 'dailySessions', nextSessionId);
  const nextSessionSnap = await getDoc(nextSessionRef);
  if (nextSessionSnap.exists()) {
    batch.update(nextSessionRef, {
      openingBalanceApproved: false,
      updatedAt: serverTimestamp(),
    });
  }

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

export async function transferDepartmentReportBetweenDates(
  actor: UserAccount,
  branchId: string,
  department: OperationalDepartmentId,
  sourceDate: string,
  targetDate: string,
  reason: string,
  products: Product[],
  categories: Category[],
  options?: { includeFactoryTransfers?: boolean }
): Promise<{ movedItemsCount: number; movedTransfersCount: number }> {
  const isActorAdmin =
    actor.role === 'ceo' ||
    actor.role === 'branch_manager' ||
    actor.email.toLowerCase() === BOOTSTRAP_ADMIN_EMAIL;
  if (!isActorAdmin) {
    throw new Error('عملية نقل التقارير بين التواريخ مقصورة على الإدارة العليا فقط.');
  }
  if (!sourceDate || !targetDate) {
    throw new Error('يرجى تحديد تاريخ المصدر وتاريخ الوجهة.');
  }
  if (sourceDate === targetDate) {
    throw new Error('يجب أن يكون تاريخ الوجهة مختلفاً عن تاريخ المصدر.');
  }

  const includeFactoryTransfers = options?.includeFactoryTransfers !== false;
  const reasonClean = (reason.trim() || 'نقل إداري لتصحيح تاريخ إدخال التقرير').slice(0, 500);

  try {
    let sourceSession = await ensureDailySession(actor, branchId, sourceDate);
    let targetSession = await ensureDailySession(actor, branchId, targetDate);

    const sourceReportId = sanitizeId(`${sourceSession.id}_${department}`);
    const targetReportId = sanitizeId(`${targetSession.id}_${department}`);
    const sourceReportRef = doc(db, 'departmentReports', sourceReportId);
    const targetReportRef = doc(db, 'departmentReports', targetReportId);

    const sourceReportSnap = await getDoc(sourceReportRef);
    const sourceItemsSnap = await getDocs(
      collection(db, 'departmentReports', sourceReportId, 'items')
    );
    const sourceProdEntriesSnap =
      department === 'production'
        ? await getDocs(
            query(collection(db, 'productionEntries'), where('sessionId', '==', sourceSession.id))
          )
        : null;
    const sourceTransfersSnap =
      department === 'factory' && includeFactoryTransfers
        ? await getDocs(
            query(collection(db, 'factoryTransfers'), where('sessionId', '==', sourceSession.id))
          )
        : null;

    const hasReportItems = sourceItemsSnap.size > 0;
    const hasProdEntries = !!sourceProdEntriesSnap && sourceProdEntriesSnap.size > 0;
    const hasFactoryTransfers = !!sourceTransfersSnap && sourceTransfersSnap.size > 0;

    if (!hasReportItems && !hasProdEntries && !hasFactoryTransfers) {
      throw new Error(
        `لا توجد بيانات مدخلة أو مرحلة في قسم ${DEPARTMENT_LABELS[department]} بتاريخ ${sourceDate} لنقلها.`
      );
    }

    const sourceReportData: Partial<Omit<DepartmentReport, 'id'>> = sourceReportSnap.exists()
      ? (sourceReportSnap.data() as Omit<DepartmentReport, 'id'>)
      : { status: 'submitted', itemCount: 0 };

    // Reopen closed sessions cleanly if either side was closed
    if (sourceSession.status === 'closed') {
      const srcReportsSnap = await getDocs(
        query(collection(db, 'departmentReports'), where('sessionId', '==', sourceSession.id))
      );
      const srcReps = srcReportsSnap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<DepartmentReport, 'id'>),
      }));
      await reopenDailySession(
        actor,
        sourceSession,
        srcReps,
        `إعادة فتح تلقائية لنقل تقرير ${DEPARTMENT_LABELS[department]} إلى ${targetDate}: ${reasonClean}`
      );
      sourceSession = { ...sourceSession, status: 'reopened' };
    }

    if (targetSession.status === 'closed') {
      const tgtReportsSnap = await getDocs(
        query(collection(db, 'departmentReports'), where('sessionId', '==', targetSession.id))
      );
      const tgtReps = tgtReportsSnap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<DepartmentReport, 'id'>),
      }));
      await reopenDailySession(
        actor,
        targetSession,
        tgtReps,
        `إعادة فتح تلقائية لاستقبال تقرير ${DEPARTMENT_LABELS[department]} المنقول من ${sourceDate}: ${reasonClean}`
      );
      targetSession = { ...targetSession, status: 'reopened' };
    }

    // Ensure both report documents exist before batching item transfers and status updates
    if (!sourceReportSnap.exists()) {
      await setDoc(sourceReportRef, {
        sessionId: sourceSession.id,
        branchId: sourceSession.branchId,
        inventoryDate: sourceDate,
        department,
        status: 'draft',
        itemCount: 0,
        createdBy: actor.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    const existingTargetReportSnap = await getDoc(targetReportRef);
    if (!existingTargetReportSnap.exists()) {
      await setDoc(targetReportRef, {
        sessionId: targetSession.id,
        branchId: targetSession.branchId,
        inventoryDate: targetDate,
        department,
        status: 'draft',
        itemCount: 0,
        createdBy: actor.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    const existingTargetItemsSnap = await getDocs(
      collection(db, 'departmentReports', targetReportId, 'items')
    );
    const existingTargetCreatedAt = new Map<string, unknown>();
    existingTargetItemsSnap.forEach((d) => {
      existingTargetCreatedAt.set(d.id, d.data().createdAt);
    });

    const sourceProductIds = new Set<string>();
    sourceItemsSnap.forEach((d) => {
      const it = d.data() as DepartmentReportItem;
      sourceProductIds.add(it.productId || d.id);
    });

    const actorName = (actor.fullName || actor.username || 'الإدارة').trim().slice(0, 120);
    // Promote moved draft reports with items to 'submitted' so target day's inventory recalculates immediately
    const movedStatus: DepartmentReport['status'] =
      sourceReportData.status === 'closed' || sourceReportData.status === 'draft' || !sourceReportData.status
        ? 'submitted'
        : sourceReportData.status;

    const writeOps: Array<(b: ReturnType<typeof writeBatch>) => void> = [];

    // Delete only target items not present in source when replacing report items
    if (hasReportItems) {
      existingTargetItemsSnap.forEach((d) => {
        if (!sourceProductIds.has(d.id)) {
          writeOps.push((b) => b.delete(d.ref));
        }
      });
    }

    // Move items from source -> target preserving existing target createdAt on overwrite
    let movedItemsCount = 0;
    let nonEmptyItemsCount = 0;
    sourceItemsSnap.forEach((d) => {
      const item = d.data() as DepartmentReportItem;
      const pid = item.productId || d.id;
      const destRef = doc(db, 'departmentReports', targetReportId, 'items', pid);
      const prevTargetCreatedAt = existingTargetCreatedAt.get(pid);

      const hasQty =
        (item.preparedQty !== undefined && item.preparedQty !== null) ||
        (item.independentProductionQty !== undefined && item.independentProductionQty !== null) ||
        (item.salesQty !== undefined && item.salesQty !== null) ||
        (item.damagedQty !== undefined && item.damagedQty !== null) ||
        (item.validRemainingQty !== undefined && item.validRemainingQty !== null) ||
        (item.invalidRemainingQty !== undefined && item.invalidRemainingQty !== null);
      if (hasQty) nonEmptyItemsCount += 1;

      const cleanBreakdowns: Partial<Record<ReportQtyFieldKey, UnitBreakdown>> = {};
      if (item.unitBreakdowns && typeof item.unitBreakdowns === 'object') {
        const keys: ReportQtyFieldKey[] = [
          'preparedQty',
          'independentProductionQty',
          'salesQty',
          'damagedQty',
          'validRemainingQty',
          'invalidRemainingQty',
        ];
        for (const k of keys) {
          const cleaned = sanitizeUnitBreakdown(item.unitBreakdowns[k]);
          if (cleaned) {
            cleanBreakdowns[k] = cleaned;
          }
        }
      }

      const nextPayload: Record<string, unknown> = {
        reportId: targetReportId,
        sessionId: targetSession.id,
        branchId: targetSession.branchId,
        inventoryDate: targetDate,
        department,
        productId: pid,
        categoryId:
          item.categoryId || products.find((p) => p.id === pid)?.categoryId || 'general',
        preparedQty: item.preparedQty ?? null,
        independentProductionQty: item.independentProductionQty ?? null,
        salesQty: item.salesQty ?? null,
        damagedQty: item.damagedQty ?? null,
        validRemainingQty: item.validRemainingQty ?? null,
        invalidRemainingQty: item.invalidRemainingQty ?? null,
        unitBreakdowns: Object.keys(cleanBreakdowns).length > 0 ? cleanBreakdowns : null,
        note: typeof item.note === 'string' ? item.note.slice(0, 300) : '',
        updatedBy: actor.uid,
        updatedByName: actorName,
        createdAt: prevTargetCreatedAt || serverTimestamp(),
        updatedAt: serverTimestamp(),
      };

      writeOps.push((b) => b.set(destRef, nextPayload));
      writeOps.push((b) => b.delete(d.ref));
      movedItemsCount += 1;
    });

    // If production, move independent productionEntries as well
    let movedEntriesCount = 0;
    if (department === 'production' && sourceProdEntriesSnap && sourceProdEntriesSnap.size > 0) {
      const existingTargetProdSnap = await getDocs(
        query(collection(db, 'productionEntries'), where('sessionId', '==', targetSession.id))
      );
      existingTargetProdSnap.forEach((d) => {
        writeOps.push((b) => b.delete(d.ref));
      });

      sourceProdEntriesSnap.forEach((d) => {
        const entry = d.data() as ProductionEntry;
        const newEntryRef = doc(collection(db, 'productionEntries'), makeUniqueId('ind'));
        const cleanBreakdown = sanitizeUnitBreakdown(entry.unitBreakdown);
        writeOps.push((b) =>
          b.set(newEntryRef, {
            sessionId: targetSession.id,
            branchId: targetSession.branchId,
            inventoryDate: targetDate,
            productId: entry.productId,
            qty: safeNum(entry.qty),
            unitBreakdown: cleanBreakdown ?? null,
            note: (typeof entry.note === 'string' && entry.note.trim()
              ? entry.note
              : `منقول من ${sourceDate}`
            ).slice(0, 300),
            createdBy: actor.uid,
            createdByName: actorName,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );
        writeOps.push((b) => b.delete(d.ref));
        movedEntriesCount += 1;
      });
    }

    // If factory and includeFactoryTransfers, reassign factoryTransfers and their items to targetSession
    let movedTransfersCount = 0;
    if (department === 'factory' && sourceTransfersSnap && sourceTransfersSnap.size > 0) {
      for (const trfDoc of sourceTransfersSnap.docs) {
        const trfData = trfDoc.data() as Omit<FactoryTransfer, 'id'>;
        const trfItemsSnap = await getDocs(collection(db, 'factoryTransfers', trfDoc.id, 'items'));
        const prevNote = typeof trfData.factoryNote === 'string' ? trfData.factoryNote.trim() : '';
        const transferTag = `منقول من ${sourceDate}`;
        const nextNote = (prevNote ? `${prevNote} · ${transferTag}` : transferTag).slice(0, 400);

        writeOps.push((b) =>
          b.update(trfDoc.ref, {
            sessionId: targetSession.id,
            inventoryDate: targetDate,
            factoryNote: nextNote,
            updatedAt: serverTimestamp(),
          })
        );
        trfItemsSnap.forEach((itemDoc) => {
          writeOps.push((b) =>
            b.update(itemDoc.ref, {
              sessionId: targetSession.id,
              updatedAt: serverTimestamp(),
            })
          );
        });
        movedTransfersCount += 1;
      }
    }

    const totalMoved = Math.max(nonEmptyItemsCount, movedItemsCount, movedEntriesCount);

    // Update target & source report headers when report items or production entries were moved
    if (hasReportItems || hasProdEntries) {
      writeOps.push((b) =>
        b.update(targetReportRef, {
          status: movedStatus,
          itemCount: nonEmptyItemsCount > 0 ? nonEmptyItemsCount : totalMoved,
          submittedBy:
            typeof sourceReportData.submittedBy === 'string' && sourceReportData.submittedBy
              ? sourceReportData.submittedBy.slice(0, 128)
              : actor.uid,
          submittedByName:
            typeof sourceReportData.submittedByName === 'string' && sourceReportData.submittedByName
              ? sourceReportData.submittedByName.slice(0, 120)
              : actorName,
          approvedBy: actor.uid,
          approvedByName: actorName,
          lastCorrectionReason: `منقول من ${sourceDate}: ${reasonClean}`.slice(0, 500),
          updatedAt: serverTimestamp(),
        })
      );

      writeOps.push((b) =>
        b.update(sourceReportRef, {
          status: 'draft',
          itemCount: 0,
          submittedBy: null,
          submittedByName: null,
          approvedBy: actor.uid,
          approvedByName: actorName,
          lastCorrectionReason: `تم نقل البيانات إلى ${targetDate}: ${reasonClean}`.slice(0, 500),
          updatedAt: serverTimestamp(),
        })
      );
    }

    // Commit writes safely in chunks under Firestore's 500-operation limit
    const CHUNK_SIZE = 400;
    for (let i = 0; i < writeOps.length; i += CHUNK_SIZE) {
      const chunkBatch = writeBatch(db);
      const slice = writeOps.slice(i, i + CHUNK_SIZE);
      slice.forEach((applyOp) => applyOp(chunkBatch));
      await chunkBatch.commit();
    }

    // Recalculate in chronological order (earlier date first, then later date, plus day after later date if open)
    const freshSourceSnap = await getDoc(doc(db, 'dailySessions', sourceSession.id));
    const freshTargetSnap = await getDoc(doc(db, 'dailySessions', targetSession.id));
    const freshSource = freshSourceSnap.exists()
      ? ({ id: freshSourceSnap.id, ...(freshSourceSnap.data() as Omit<DailySession, 'id'>) })
      : sourceSession;
    const freshTarget = freshTargetSnap.exists()
      ? ({ id: freshTargetSnap.id, ...(freshTargetSnap.data() as Omit<DailySession, 'id'>) })
      : targetSession;

    if (products.length > 0 && categories.length > 0) {
      const ordered =
        freshTarget.inventoryDate <= freshSource.inventoryDate
          ? [freshTarget, freshSource]
          : [freshSource, freshTarget];
      for (const sess of ordered) {
        await recalculateSessionResults(actor, sess, products, categories);
      }

      const dayAfterLaterDate = shiftIsoDate(ordered[1].inventoryDate, 1);
      const dayAfterSnap = await getDoc(
        doc(db, 'dailySessions', makeSessionId(branchId, dayAfterLaterDate))
      );
      if (dayAfterSnap.exists() && dayAfterSnap.data()?.status !== 'closed') {
        await recalculateSessionResults(
          actor,
          { id: dayAfterSnap.id, ...(dayAfterSnap.data() as Omit<DailySession, 'id'>) },
          products,
          categories
        );
      }
    }

    const summarySuffix =
      movedTransfersCount > 0 ? ` + ${movedTransfersCount} إشعار توريد/مرتجع` : '';
    await appendAuditLog({
      actor,
      action: 'نقل_تقرير_قسم_بين_تاريخين',
      targetCollection: 'departmentReports',
      targetId: targetReportId,
      sessionId: targetSession.id,
      inventoryDate: targetDate,
      branchId,
      department,
      oldValueSummary: `${DEPARTMENT_LABELS[department]} (${sourceDate}): ${totalMoved} صنف${summarySuffix}`,
      newValueSummary: `${DEPARTMENT_LABELS[department]} (${targetDate}): ${totalMoved} صنف${summarySuffix}`,
      reason: reasonClean,
    });

    return { movedItemsCount: totalMoved, movedTransfersCount };
  } catch (error) {
    if (error instanceof Error && !error.message.includes('Firestore')) {
      throw error;
    }
    handleFirestoreError(error, OperationType.WRITE, 'departmentReports');
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

export async function requestTransferReceiptCorrection(
  actor: UserAccount,
  transfer: FactoryTransfer,
  product: Pick<Product, 'id' | 'name' | 'unit'>,
  oldValue: number | null,
  newValue: number,
  reason: string
): Promise<void> {
  if (!reason.trim()) {
    throw new Error('يجب كتابة سبب التعديل المطلوب.');
  }
  const approvalId = makeUniqueId('corr');
  const reasonSummary = `توريد ${transfer.transferNumber} — ${product.name}: ${reason.trim()}`;
  try {
    await setDoc(doc(db, 'approvals', approvalId), {
      type: 'report_correction',
      sessionId: transfer.sessionId,
      inventoryDate: transfer.inventoryDate,
      targetCollection: 'factoryTransfers',
      targetId: transfer.id,
      productId: product.id,
      department: 'production',
      status: 'pending',
      reason: reasonSummary.slice(0, 500),
      fieldKey: 'receivedQty',
      oldValue: oldValue ?? 0,
      newValue: safeNum(newValue),
      requestedBy: actor.uid,
      requestedByName: actor.fullName,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    await appendAuditLog({
      actor,
      action: 'طلب_تصحيح_استلام_توريد',
      targetCollection: 'approvals',
      targetId: approvalId,
      sessionId: transfer.sessionId,
      inventoryDate: transfer.inventoryDate,
      department: 'production',
      oldValueSummary: `${transfer.transferNumber} · ${product.name}: ${oldValue ?? 0}`,
      newValueSummary: `${transfer.transferNumber} · ${product.name}: ${safeNum(newValue)}`,
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

    if (
      decision === 'approve' &&
      approval.targetCollection === 'factoryTransfers' &&
      approval.productId &&
      approval.fieldKey === 'receivedQty'
    ) {
      const trfRef = doc(db, 'factoryTransfers', approval.targetId);
      const trfSnap = await getDoc(trfRef);
      if (!trfSnap.exists()) {
        throw new Error('تعذر العثور على إشعار التوريد المرتبط بطلب التصحيح.');
      }
      const trfItemsSnap = await getDocs(
        collection(db, 'factoryTransfers', approval.targetId, 'items')
      );
      const targetItemDoc = trfItemsSnap.docs.find((d) => d.id === approval.productId);
      if (!targetItemDoc) {
        throw new Error('تعذر العثور على الصنف داخل إشعار التوريد.');
      }

      const newReceived = safeNum(approval.newValue ?? 0);
      const prod = products.find((p) => p.id === approval.productId);
      const effUnits = getEffectiveProductUnits(prod);
      const nextCounts = decomposeTotalToUnitCounts(newReceived, effUnits);
      const nextBreakdown: UnitBreakdown = {};
      for (const u of effUnits) {
        const c = Number(nextCounts[u.name] || 0);
        if (c > 0) nextBreakdown[u.name] = roundQty(c);
      }
      const cleanBreakdown = sanitizeUnitBreakdown(nextBreakdown);

      let totalReceivedQty = 0;
      let totalVarianceQty = 0;
      let hasDiscrepancy = false;

      trfItemsSnap.forEach((d) => {
        const it = d.data() as FactoryTransferItem;
        const sent = safeNum(it.sentQty);
        const rec = d.id === approval.productId ? newReceived : safeNum(it.receivedQty ?? 0);
        const variance = roundQty(sent - rec);
        if (variance !== 0) hasDiscrepancy = true;
        totalReceivedQty = roundQty(totalReceivedQty + rec);
        totalVarianceQty = roundQty(totalVarianceQty + variance);

        if (d.id === approval.productId) {
          batch.update(d.ref, {
            receivedQty: rec,
            receivedBreakdown: cleanBreakdown ?? null,
            varianceQty: variance,
            note: `تصحيح معتمد: ${approval.reason}`.slice(0, 300),
            updatedAt: serverTimestamp(),
          });
        }
      });

      batch.update(trfRef, {
        status: hasDiscrepancy ? 'discrepancy_logged' : 'received',
        totalReceivedQty,
        totalVarianceQty,
        productionNote: `تصحيح استلام معتمد: ${approval.reason}`.slice(0, 400),
        updatedAt: serverTimestamp(),
      });
    } else if (decision === 'approve' && approval.productId && approval.fieldKey) {
      const itemRef = doc(db, 'departmentReports', approval.targetId, 'items', approval.productId);
      const itemSnap = await getDoc(itemRef);
      const prod = products.find((p) => p.id === approval.productId);
      const newQty = safeNum(approval.newValue ?? 0);
      const effUnits = getEffectiveProductUnits(prod);
      const nextCounts = decomposeTotalToUnitCounts(newQty, effUnits);
      const nextFieldBreakdown: UnitBreakdown = {};
      for (const u of effUnits) {
        const c = Number(nextCounts[u.name] || 0);
        if (c > 0) nextFieldBreakdown[u.name] = roundQty(c);
      }
      const cleanFieldBreakdown = sanitizeUnitBreakdown(nextFieldBreakdown);
      const fieldKey = approval.fieldKey as ReportQtyFieldKey;

      if (itemSnap.exists()) {
        const existingData = itemSnap.data() as DepartmentReportItem;
        const nextUnitBreakdowns: Partial<Record<ReportQtyFieldKey, UnitBreakdown>> = {
          ...(existingData.unitBreakdowns || {}),
        };
        if (cleanFieldBreakdown) {
          nextUnitBreakdowns[fieldKey] = cleanFieldBreakdown;
        } else {
          delete nextUnitBreakdowns[fieldKey];
        }
        batch.update(itemRef, {
          [approval.fieldKey]: newQty,
          unitBreakdowns:
            Object.keys(nextUnitBreakdowns).length > 0 ? nextUnitBreakdowns : null,
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
          [approval.fieldKey]: newQty,
          unitBreakdowns: cleanFieldBreakdown ? { [fieldKey]: cleanFieldBreakdown } : null,
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
