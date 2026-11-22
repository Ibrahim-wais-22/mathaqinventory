import React, { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Clock,
  Phone,
  RotateCcw,
  Shield,
  Trash2,
  UserCheck,
  UserPlus,
  XCircle,
} from 'lucide-react';
import { collection, onSnapshot } from 'firebase/firestore';
import {
  ACCOUNT_STATUS_LABELS,
  ALL_PERMISSIONS,
  BOOTSTRAP_ADMIN_EMAIL,
  DEPARTMENT_LABELS,
  DEPARTMENT_OPERATION_PERMISSIONS,
  PERMISSION_LABELS,
  ROLE_LABELS,
  getDefaultPermissionsForRole,
  getDepartmentForRole,
} from '../../constants/departments';
import { useFirebase } from '../../app/providers/FirebaseProvider';
import { OperationType, db, handleFirestoreError } from '../../services/firebase/config';
import {
  createUserInvite,
  deleteUserInvite,
  formatActionError,
  updateUserAccountByAdmin,
} from '../../services/inventory/firestoreService';
import type { PermissionKey, UserAccount, UserInvite, UserRole } from '../../types/inventory';
import { normalizePhoneForPassword } from '../../utils/passwordCrypto';
import { StatusBadge } from '../../components/common/StatusBadge';

const ASSIGNABLE_ROLES: Array<Exclude<UserRole, 'pending'>> = [
  'factory_staff',
  'production_staff',
  'sales_staff',
  'waste_staff',
  'branch_manager',
  'ceo',
];

interface PendingApprovalDraft {
  employeeNumber: string;
  fullName: string;
  username: string;
  phoneNumber: string;
  role: Exclude<UserRole, 'pending'>;
}

function computeNextEmpNumber(users: UserAccount[], invites: UserInvite[]): string {
  let maxNum = 100;
  const check = (empNo?: string) => {
    if (!empNo) return;
    const match = empNo.match(/^EMP-(\d+)$/i);
    if (match) {
      const n = Number(match[1]);
      if (Number.isFinite(n) && n > maxNum) maxNum = n;
    }
  };
  users.forEach((u) => check(u.employeeNumber));
  invites.forEach((i) => check(i.employeeNumber));
  return `EMP-${maxNum + 1}`;
}

export const UsersManagement: React.FC = () => {
  const { account } = useFirebase();

  const [users, setUsers] = useState<UserAccount[]>([]);
  const [invites, setInvites] = useState<UserInvite[]>([]);
  const [editingUser, setEditingUser] = useState<UserAccount | null>(null);
  const [resetPasswordToPhone, setResetPasswordToPhone] = useState(false);
  const [pendingDrafts, setPendingDrafts] = useState<Record<string, PendingApprovalDraft>>({});

  // Invite form
  const [email, setEmail] = useState('');
  const [empNo, setEmpNo] = useState('');
  const [username, setUsername] = useState('');
  const [fullName, setFullName] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [role, setRole] = useState<Exclude<UserRole, 'pending'>>('factory_staff');
  const [perms, setPerms] = useState<PermissionKey[]>(getDefaultPermissionsForRole('factory_staff'));

  const [busy, setBusy] = useState(false);
  const [busyUid, setBusyUid] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    const unsubUsers = onSnapshot(
      collection(db, 'users'),
      (snap) => {
        setUsers(snap.docs.map((d) => ({ ...(d.data() as UserAccount), uid: d.id })));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'users')
    );

    const unsubInvites = onSnapshot(
      collection(db, 'userInvites'),
      (snap) => {
        setInvites(
          snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<UserInvite, 'id'>) }))
        );
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'userInvites')
    );

    return () => {
      unsubUsers();
      unsubInvites();
    };
  }, []);

  const nextSuggestedEmpNo = useMemo(
    () => computeNextEmpNumber(users, invites),
    [users, invites]
  );

  const pendingUsers = useMemo(
    () => users.filter((u) => u.status === 'pending_activation' || u.role === 'pending'),
    [users]
  );

  const registeredUsers = useMemo(
    () => users.filter((u) => u.status !== 'pending_activation' && u.role !== 'pending'),
    [users]
  );

  const getPendingDraft = (u: UserAccount, idx: number): PendingApprovalDraft => {
    const existing = pendingDrafts[u.uid];
    if (existing) return existing;
    const needsEmpNumber =
      !u.employeeNumber || u.employeeNumber.startsWith('NEW-') || u.employeeNumber.trim() === '';
    const baseNum = Number(nextSuggestedEmpNo.replace(/\D/g, '')) || 101;
    return {
      employeeNumber: needsEmpNumber ? `EMP-${baseNum + idx}` : u.employeeNumber,
      fullName: u.fullName?.trim() || '',
      username: u.username?.trim() || u.email.split('@')[0] || '',
      phoneNumber: u.phoneNumber?.trim() || '',
      role: 'factory_staff',
    };
  };

  const updatePendingDraft = (
    u: UserAccount,
    idx: number,
    patch: Partial<PendingApprovalDraft>
  ) => {
    setPendingDrafts((prev) => {
      const current = prev[u.uid] || getPendingDraft(u, idx);
      return {
        ...prev,
        [u.uid]: { ...current, ...patch },
      };
    });
  };

  const handleRoleChange = (nextRole: Exclude<UserRole, 'pending'>) => {
    setRole(nextRole);
    setPerms(getDefaultPermissionsForRole(nextRole));
  };

  const togglePerm = (p: PermissionKey) => {
    setPerms((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));
  };

  const handleApprovePending = async (targetUser: UserAccount, idx: number) => {
    if (!account) return;
    const draft = getPendingDraft(targetUser, idx);
    const cleanEmp = draft.employeeNumber.trim();
    const cleanName = draft.fullName.trim();
    const cleanUser = draft.username.trim();
    const cleanPhone = draft.phoneNumber.trim();
    const cleanPhonePass = normalizePhoneForPassword(cleanPhone);

    if (!cleanEmp || !cleanName || !cleanUser || !cleanPhone) {
      setFeedback({
        type: 'error',
        text: 'يجب استكمال جميع البيانات الأساسية للموظف (الرقم الوظيفي، الاسم الكامل، اسم المستخدم، ورقم الهاتف) قبل الموافقة على الطلب.',
      });
      return;
    }

    if (cleanPhonePass.length < 4) {
      setFeedback({
        type: 'error',
        text: 'رقم الهاتف يجب أن لا يقل عن 4 أرقام لأنه يُستخدم ككلمة مرور مبدئية للدخول.',
      });
      return;
    }

    setBusy(true);
    setBusyUid(targetUser.uid);
    setFeedback(null);
    try {
      await updateUserAccountByAdmin(account, targetUser, {
        employeeNumber: cleanEmp,
        username: cleanUser,
        fullName: cleanName,
        phoneNumber: cleanPhone,
        resetPasswordToPhone: true,
        role: draft.role,
        status: 'active',
        permissions: getDefaultPermissionsForRole(draft.role),
      });
      setPendingDrafts((prev) => {
        const next = { ...prev };
        delete next[targetUser.uid];
        return next;
      });
      setFeedback({
        type: 'success',
        text: `تمت الموافقة وتفعيل حساب "${cleanName}" بوظيفة ${ROLE_LABELS[draft.role]} (${cleanEmp}). كلمة المرور المبدئية هي رقم الهاتف المسجل.`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: formatActionError(err, 'تعذر قبول الطلب وتفعيل الحساب.'),
      });
    } finally {
      setBusy(false);
      setBusyUid(null);
    }
  };

  const handleRejectPending = async (targetUser: UserAccount) => {
    if (!account) return;
    setBusy(true);
    setBusyUid(targetUser.uid);
    setFeedback(null);
    try {
      await updateUserAccountByAdmin(account, targetUser, {
        employeeNumber: targetUser.employeeNumber || nextSuggestedEmpNo,
        username: targetUser.username || targetUser.email.split('@')[0] || 'employee',
        fullName: targetUser.fullName || targetUser.email.split('@')[0] || 'موظف',
        phoneNumber: targetUser.phoneNumber,
        role: 'pending',
        status: 'suspended',
        permissions: [],
      });
      setFeedback({
        type: 'success',
        text: `تم رفض وإيقاف طلب "${targetUser.fullName || targetUser.email}".`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: formatActionError(err, 'تعذر رفض الطلب.'),
      });
    } finally {
      setBusy(false);
      setBusyUid(null);
    }
  };

  const handleCreateInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!account) return;
    setFeedback(null);

    const finalEmp = empNo.trim() || nextSuggestedEmpNo;
    const finalUsername = username.trim() || email.split('@')[0] || '';
    const finalFullName = fullName.trim();
    const finalPhone = phoneNumber.trim();

    if (!email.trim() || !finalEmp || !finalUsername || !finalFullName || !finalPhone) {
      setFeedback({
        type: 'error',
        text: 'يرجى إدخال جميع البيانات الأساسية للموظف بما فيها رقم الهاتف.',
      });
      return;
    }

    if (normalizePhoneForPassword(finalPhone).length < 4) {
      setFeedback({
        type: 'error',
        text: 'رقم الهاتف يجب أن لا يقل عن 4 أرقام لأنه يُستخدم ككلمة مرور مبدئية.',
      });
      return;
    }

    setBusy(true);
    try {
      const isOwnerInvite = email.trim().toLowerCase() === BOOTSTRAP_ADMIN_EMAIL;
      const isManagerTarget = !isOwnerInvite && (role === 'ceo' || role === 'branch_manager');
      const sanitizedPerms = isManagerTarget
        ? perms.filter((p) => !DEPARTMENT_OPERATION_PERMISSIONS.includes(p))
        : perms;
      await createUserInvite(account, {
        email,
        employeeNumber: finalEmp,
        username: finalUsername,
        fullName: finalFullName,
        phoneNumber: finalPhone,
        role,
        status: 'active',
        permissions: sanitizedPerms,
      });
      setEmail('');
      setEmpNo('');
      setUsername('');
      setFullName('');
      setPhoneNumber('');
      setFeedback({
        type: 'success',
        text: 'تم تسجيل الموظف بنجاح. بعد موافقته على ربط بريده عبر Google، سيدخل بالرقم الوظيفي ورقم الهاتف ككلمة مرور مبدئية.',
      });
    } catch (err) {
      setFeedback({ type: 'error', text: formatActionError(err, 'تعذر الإضافة.') });
    } finally {
      setBusy(false);
    }
  };

  const handleSaveUserEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!account || !editingUser) return;
    setFeedback(null);

    const cleanPhone = (editingUser.phoneNumber || '').trim();
    const targetStatus = editingUser.status === 'suspended' ? 'suspended' : 'active';
    if (
      targetStatus === 'active' &&
      (!editingUser.fullName.trim() ||
        !editingUser.employeeNumber.trim() ||
        !editingUser.username.trim() ||
        normalizePhoneForPassword(cleanPhone).length < 4)
    ) {
      setFeedback({
        type: 'error',
        text: 'يجب إدخال جميع البيانات الأساسية ورقم الهاتف (4 أرقام فأكثر) قبل حفظ وتفعيل الحساب.',
      });
      return;
    }

    setBusy(true);
    try {
      const nextRole = editingUser.role === 'pending' ? 'factory_staff' : editingUser.role;
      const isOwnerTarget = (editingUser.email || '').trim().toLowerCase() === BOOTSTRAP_ADMIN_EMAIL;
      const isManagerTarget =
        !isOwnerTarget && (nextRole === 'ceo' || nextRole === 'branch_manager');
      const sanitizedPerms = isOwnerTarget
        ? editingUser.permissions
        : isManagerTarget
        ? editingUser.permissions.filter((p) => !DEPARTMENT_OPERATION_PERMISSIONS.includes(p))
        : editingUser.permissions;
      await updateUserAccountByAdmin(account, editingUser, {
        employeeNumber: editingUser.employeeNumber,
        username: editingUser.username,
        fullName: editingUser.fullName,
        phoneNumber: cleanPhone,
        resetPasswordToPhone,
        role: nextRole,
        status: targetStatus,
        permissions: sanitizedPerms,
      });
      setEditingUser(null);
      setResetPasswordToPhone(false);
      setFeedback({ type: 'success', text: 'تم تحديث بيانات وصلاحيات الموظف بنجاح.' });
    } catch (err) {
      setFeedback({ type: 'error', text: formatActionError(err, 'تعذر التحديث.') });
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteInvite = async (inv: UserInvite) => {
    if (!account) return;
    setBusy(true);
    setFeedback(null);
    try {
      await deleteUserInvite(account, inv);
      setFeedback({ type: 'success', text: `تم إلغاء دعوة "${inv.fullName}".` });
    } catch (err) {
      setFeedback({ type: 'error', text: formatActionError(err, 'تعذر إلغاء الدعوة.') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-white border border-zinc-200 rounded-2xl p-5">
        <h2 className="text-xl font-bold text-zinc-900 font-display">
          إدارة حسابات الموظفين والصلاحيات
        </h2>
        <p className="mt-1 text-sm text-zinc-500">
          استكمال البيانات الأساسية للموظف ورقم الهاتف قبل الموافقة على التفعيل، مع تعيين كلمة المرور المبدئية مساوية لرقم الهاتف
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

      {/* Pending User Requests with Mandatory Basic Data + Phone Number */}
      <div
        className={`bg-white rounded-2xl overflow-hidden border ${
          pendingUsers.length > 0 ? 'border-amber-300' : 'border-zinc-200'
        }`}
      >
        <div
          className={`px-5 py-4 border-b flex flex-wrap items-center justify-between gap-2 ${
            pendingUsers.length > 0
              ? 'bg-amber-50/70 border-amber-200'
              : 'bg-zinc-50/60 border-zinc-100'
          }`}
        >
          <div className="flex items-center gap-2">
            <Clock
              className={`h-5 w-5 ${
                pendingUsers.length > 0 ? 'text-amber-600' : 'text-zinc-400'
              }`}
            />
            <h3 className="text-base font-bold text-zinc-900 font-display">
              طلبات الانضمام الجديدة بانتظار استكمال البيانات والموافقة ({pendingUsers.length})
            </h3>
          </div>
          {pendingUsers.length > 0 && (
            <span className="text-xs font-semibold text-amber-800">
              إلزامي: أدخل جميع البيانات الأساسية ورقم الهاتف قبل الموافقة
            </span>
          )}
        </div>

        {pendingUsers.length === 0 ? (
          <div className="px-5 py-4 text-xs text-zinc-500">
            لا توجد طلبات انضمام معلقة حالياً. عند تسجيل أي موظف جديد والموافقة على ربط بريده الإلكتروني سيظهر طلبه هنا لاستكمال بياناته وتفعيله.
          </div>
        ) : (
          <div className="divide-y divide-zinc-200">
            {pendingUsers.map((u, idx) => {
              const draft = getPendingDraft(u, idx);
              const targetDept = getDepartmentForRole(draft.role);
              const isRowBusy = busyUid === u.uid;
              const isDraftComplete =
                Boolean(draft.employeeNumber.trim()) &&
                Boolean(draft.fullName.trim()) &&
                Boolean(draft.username.trim()) &&
                normalizePhoneForPassword(draft.phoneNumber).length >= 4;

              return (
                <div key={u.uid} className="p-4 lg:p-5 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs text-zinc-600">
                      البريد الإلكتروني المرتبط:{' '}
                      <strong className="text-zinc-900 font-mono">{u.email}</strong>
                    </div>
                    <div className="text-[11px] text-zinc-500">
                      سيتم التفعيل في إدارة:{' '}
                      <strong className="text-zinc-800">{DEPARTMENT_LABELS[targetDept]}</strong>{' '}
                      · كلمة المرور المبدئية = رقم الهاتف
                    </div>
                  </div>

                  {/* Mandatory Basic Data Inputs */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                    <div>
                      <label className="block text-[11px] font-semibold text-zinc-700 mb-1">
                        الرقم الوظيفي *
                      </label>
                      <input
                        type="text"
                        required
                        disabled={busy}
                        value={draft.employeeNumber}
                        onChange={(e) =>
                          updatePendingDraft(u, idx, { employeeNumber: e.target.value })
                        }
                        placeholder="EMP-101"
                        className="w-full min-h-[40px] rounded-xl border border-zinc-300 bg-white px-3 text-xs font-semibold text-zinc-900"
                      />
                    </div>

                    <div>
                      <label className="block text-[11px] font-semibold text-zinc-700 mb-1">
                        الاسم الكامل *
                      </label>
                      <input
                        type="text"
                        required
                        disabled={busy}
                        value={draft.fullName}
                        onChange={(e) => updatePendingDraft(u, idx, { fullName: e.target.value })}
                        placeholder="الاسم الكامل للموظف"
                        className="w-full min-h-[40px] rounded-xl border border-zinc-300 bg-white px-3 text-xs font-semibold text-zinc-900"
                      />
                    </div>

                    <div>
                      <label className="block text-[11px] font-semibold text-zinc-700 mb-1">
                        اسم المستخدم *
                      </label>
                      <input
                        type="text"
                        required
                        disabled={busy}
                        value={draft.username}
                        onChange={(e) => updatePendingDraft(u, idx, { username: e.target.value })}
                        placeholder="username"
                        className="w-full min-h-[40px] rounded-xl border border-zinc-300 bg-white px-3 text-xs font-semibold text-zinc-900"
                      />
                    </div>

                    <div>
                      <label className="block text-[11px] font-semibold text-zinc-700 mb-1">
                        رقم الهاتف (كلمة المرور المبدئية) *
                      </label>
                      <input
                        type="tel"
                        required
                        disabled={busy}
                        value={draft.phoneNumber}
                        onChange={(e) =>
                          updatePendingDraft(u, idx, { phoneNumber: e.target.value })
                        }
                        placeholder="مثال: 771234567"
                        className="w-full min-h-[40px] rounded-xl border border-zinc-300 bg-white px-3 text-xs font-semibold text-zinc-900 tabular-nums"
                      />
                    </div>

                    <div>
                      <label className="block text-[11px] font-semibold text-zinc-700 mb-1">
                        الدور الوظيفي *
                      </label>
                      <select
                        aria-label={`اختر وظيفة ${draft.fullName || u.email}`}
                        value={draft.role}
                        disabled={busy}
                        onChange={(e) =>
                          updatePendingDraft(u, idx, {
                            role: e.target.value as Exclude<UserRole, 'pending'>,
                          })
                        }
                        className="w-full min-h-[40px] rounded-xl border border-zinc-300 bg-white px-3 text-xs font-semibold text-zinc-900"
                      >
                        {ASSIGNABLE_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABELS[r]}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                    <span
                      className={`text-[11px] font-medium ${
                        isDraftComplete ? 'text-emerald-700' : 'text-amber-700'
                      }`}
                    >
                      {isDraftComplete
                        ? 'البيانات الأساسية مكتملة — جاهز للموافقة والتفعيل'
                        : 'أكمل جميع الحقول الإلزامية (بما فيها رقم الهاتف من 4 أرقام فأكثر) للموافقة'}
                    </span>

                    <div className="flex items-center gap-2.5">
                      <button
                        type="button"
                        disabled={busy || !isDraftComplete}
                        onClick={() => void handleApprovePending(u, idx)}
                        className="min-h-[40px] inline-flex items-center justify-center gap-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 px-5 py-2 text-xs font-bold text-white cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <CheckCircle2 className="h-4 w-4" />
                        <span>{isRowBusy ? 'جاري التفعيل...' : 'موافقة وتفعيل'}</span>
                      </button>

                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleRejectPending(u)}
                        className="min-h-[40px] inline-flex items-center justify-center gap-1.5 rounded-xl border border-red-200 bg-red-50 hover:bg-red-100 px-3.5 py-2 text-xs font-bold text-red-700 cursor-pointer disabled:opacity-50"
                      >
                        <XCircle className="h-4 w-4" />
                        <span>رفض</span>
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Pre-register / Invite Employee */}
      <form
        onSubmit={handleCreateInvite}
        className="bg-white border border-zinc-200 rounded-2xl p-5 space-y-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <UserPlus className="h-5 w-5 text-[#D91B23]" />
            <h3 className="text-base font-bold text-zinc-900 font-display">
              إضافة موظف جديد مسبقاً (دعوة بحساب Google)
            </h3>
          </div>
          <span className="text-[11px] text-zinc-500">
            كلمة المرور المبدئية للموظف هي رقم الهاتف المدخل هنا
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <input
            type="text"
            value={empNo}
            onChange={(e) => setEmpNo(e.target.value)}
            placeholder={`الرقم الوظيفي (تلقائي: ${nextSuggestedEmpNo})`}
            className="min-h-[42px] rounded-xl border border-zinc-200 px-3 text-sm"
          />
          <input
            type="text"
            required
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="الاسم الكامل للموظف *"
            className="min-h-[42px] rounded-xl border border-zinc-200 px-3 text-sm"
          />
          <input
            type="tel"
            required
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value)}
            placeholder="رقم الهاتف (كلمة المرور المبدئية) *"
            className="min-h-[42px] rounded-xl border border-zinc-200 px-3 text-sm"
          />
          <input
            type="email"
            required
            value={email}
            onChange={(e) => {
              const nextEmail = e.target.value;
              setEmail(nextEmail);
              if (!username || username === email.split('@')[0]) {
                setUsername(nextEmail.split('@')[0] || '');
              }
            }}
            placeholder="بريد Google للموظف *"
            className="min-h-[42px] rounded-xl border border-zinc-200 px-3 text-sm"
          />
          <input
            type="text"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="اسم المستخدم *"
            className="min-h-[42px] rounded-xl border border-zinc-200 px-3 text-sm"
          />
          <select
            value={role}
            onChange={(e) => handleRoleChange(e.target.value as Exclude<UserRole, 'pending'>)}
            className="min-h-[42px] rounded-xl border border-zinc-200 px-3 text-sm"
          >
            {ASSIGNABLE_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <div className="text-xs font-semibold text-zinc-700 mb-2">الصلاحيات الممنوحة:</div>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(PERMISSION_LABELS) as PermissionKey[])
              .filter((p) =>
                role === 'ceo' || role === 'branch_manager'
                  ? !DEPARTMENT_OPERATION_PERMISSIONS.includes(p)
                  : true
              )
              .map((p) => {
                const active = perms.includes(p);
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => togglePerm(p)}
                    className={`min-h-[34px] px-3 py-1 rounded-lg border text-xs font-medium cursor-pointer ${
                      active
                        ? 'bg-[#18181B] text-white border-[#18181B]'
                        : 'bg-white text-zinc-600 border-zinc-200'
                    }`}
                  >
                    {PERMISSION_LABELS[p]}
                  </button>
                );
              })}
          </div>
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={busy}
            className="min-h-[42px] px-5 rounded-xl bg-[#D91B23] text-xs font-bold text-white cursor-pointer disabled:opacity-50"
          >
            إضافة وتعيين الصلاحيات
          </button>
        </div>
      </form>

      {/* Active & Suspended Employees Table */}
      <div className="bg-white border border-zinc-200 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-zinc-100">
          <h3 className="text-base font-bold text-zinc-900 font-display">
            الموظفون المسجلون ({registeredUsers.length})
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-right text-sm">
            <thead className="bg-zinc-50 border-b border-zinc-200 text-xs text-zinc-500">
              <tr>
                <th className="px-4 py-3 font-semibold">الرقم الوظيفي</th>
                <th className="px-3 py-3 font-semibold">الموظف والهاتف</th>
                <th className="px-3 py-3 font-semibold">الإدارة والدور</th>
                <th className="px-3 py-3 font-semibold">الحالة</th>
                <th className="px-3 py-3 font-semibold">إدارة</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {registeredUsers.map((u) => (
                <tr key={u.uid} className="hover:bg-zinc-50/70">
                  <td className="px-4 py-3 font-mono text-xs font-bold text-zinc-700">
                    {u.employeeNumber}
                  </td>
                  <td className="px-3 py-3">
                    <div className="font-semibold text-zinc-900">{u.fullName}</div>
                    <div className="text-xs text-zinc-500">{u.email}</div>
                    <div className="text-xs text-zinc-600 mt-0.5 flex items-center gap-1">
                      <Phone className="h-3 w-3 text-zinc-400" />
                      <span className="font-mono tabular-nums">
                        {u.phoneNumber || 'غير مسجل'}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-xs text-zinc-700">
                    <div className="font-semibold">{DEPARTMENT_LABELS[u.department]}</div>
                    <div className="text-zinc-500">{ROLE_LABELS[u.role]}</div>
                  </td>
                  <td className="px-3 py-3">
                    <StatusBadge
                      label={ACCOUNT_STATUS_LABELS[u.status]}
                      tone={
                        u.status === 'active'
                          ? 'success'
                          : u.status === 'suspended'
                          ? 'danger'
                          : 'warning'
                      }
                    />
                  </td>
                  <td className="px-3 py-3">
                    <button
                      type="button"
                      onClick={() => {
                        const isOwnerTarget =
                          (u.email || '').trim().toLowerCase() === BOOTSTRAP_ADMIN_EMAIL;
                        const isMgr =
                          !isOwnerTarget && (u.role === 'ceo' || u.role === 'branch_manager');
                        setResetPasswordToPhone(false);
                        setEditingUser({
                          ...u,
                          phoneNumber: u.phoneNumber || '',
                          permissions: isOwnerTarget
                            ? Array.from(new Set([...u.permissions, ...ALL_PERMISSIONS]))
                            : isMgr
                            ? u.permissions.filter((p) => !DEPARTMENT_OPERATION_PERMISSIONS.includes(p))
                            : [...u.permissions],
                        });
                      }}
                      className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#D91B23] hover:underline cursor-pointer"
                    >
                      <Shield className="h-3.5 w-3.5" />
                      <span>تعديل البيانات والصلاحيات</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pending Invites */}
      {invites.filter((i) => !i.claimed).length > 0 && (
        <div className="bg-white border border-zinc-200 rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-100">
            <h3 className="text-base font-bold text-zinc-900 font-display">
              حسابات مدعوة بانتظار ربط البريد للمرة الأولى
            </h3>
          </div>
          <div className="divide-y divide-zinc-100">
            {invites
              .filter((i) => !i.claimed)
              .map((inv) => (
                <div key={inv.id} className="px-5 py-3 flex items-center justify-between text-xs">
                  <div>
                    <span className="font-bold text-zinc-900">{inv.fullName}</span> · {inv.email} ·{' '}
                    {inv.phoneNumber ? (
                      <span className="font-mono text-zinc-600">{inv.phoneNumber} · </span>
                    ) : null}
                    <span className="text-zinc-600">{ROLE_LABELS[inv.role]}</span>
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleDeleteInvite(inv)}
                    className="inline-flex items-center gap-1 text-red-600 font-semibold cursor-pointer disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>إلغاء الدعوة</span>
                  </button>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Edit User Modal */}
      {editingUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 overflow-y-auto">
          <form
            onSubmit={handleSaveUserEdit}
            className="w-full max-w-2xl rounded-2xl bg-white border border-zinc-200 p-6 space-y-4 my-8"
          >
            <div className="flex items-center gap-2">
              <UserCheck className="h-5 w-5 text-[#D91B23]" />
              <h3 className="text-lg font-bold text-zinc-900 font-display">
                تحديث حساب الموظف: {editingUser.fullName}
              </h3>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-zinc-700 mb-1">
                  الاسم الكامل *
                </label>
                <input
                  type="text"
                  required
                  value={editingUser.fullName}
                  onChange={(e) => setEditingUser({ ...editingUser, fullName: e.target.value })}
                  className="w-full min-h-[42px] rounded-xl border border-zinc-200 px-3 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-700 mb-1">
                  الرقم الوظيفي *
                </label>
                <input
                  type="text"
                  required
                  value={editingUser.employeeNumber}
                  onChange={(e) =>
                    setEditingUser({ ...editingUser, employeeNumber: e.target.value })
                  }
                  className="w-full min-h-[42px] rounded-xl border border-zinc-200 px-3 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-700 mb-1">
                  اسم المستخدم *
                </label>
                <input
                  type="text"
                  required
                  value={editingUser.username}
                  onChange={(e) => setEditingUser({ ...editingUser, username: e.target.value })}
                  className="w-full min-h-[42px] rounded-xl border border-zinc-200 px-3 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-700 mb-1">
                  رقم الهاتف (كلمة المرور المبدئية) *
                </label>
                <input
                  type="tel"
                  required={editingUser.status !== 'suspended'}
                  value={editingUser.phoneNumber || ''}
                  onChange={(e) =>
                    setEditingUser({ ...editingUser, phoneNumber: e.target.value })
                  }
                  placeholder="مثال: 771234567"
                  className="w-full min-h-[42px] rounded-xl border border-zinc-200 px-3 text-sm tabular-nums"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-700 mb-1">
                  الدور الوظيفي والإدارة
                </label>
                <select
                  value={editingUser.role === 'pending' ? 'factory_staff' : editingUser.role}
                  onChange={(e) => {
                    const nextRole = e.target.value as Exclude<UserRole, 'pending'>;
                    setEditingUser({
                      ...editingUser,
                      role: nextRole,
                      permissions: getDefaultPermissionsForRole(nextRole),
                    });
                  }}
                  className="w-full min-h-[42px] rounded-xl border border-zinc-200 px-3 text-sm"
                >
                  {ASSIGNABLE_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-700 mb-1">حالة الحساب</label>
                <select
                  value={editingUser.status === 'suspended' ? 'suspended' : 'active'}
                  onChange={(e) =>
                    setEditingUser({
                      ...editingUser,
                      status: e.target.value as 'active' | 'suspended',
                    })
                  }
                  className="w-full min-h-[42px] rounded-xl border border-zinc-200 px-3 text-sm"
                >
                  <option value="active">نشط</option>
                  <option value="suspended">موقوف</option>
                </select>
              </div>
            </div>

            <label className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-3.5 py-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={resetPasswordToPhone}
                onChange={(e) => setResetPasswordToPhone(e.target.checked)}
                className="h-4 w-4 rounded border-zinc-300 text-[#D91B23]"
              />
              <RotateCcw className="h-4 w-4 text-zinc-600 shrink-0" />
              <span className="text-xs font-semibold text-zinc-800">
                إعادة تعيين كلمة مرور الموظف لتطابق رقم الهاتف المسجل أعلاه
              </span>
            </label>

            <div>
              <div className="text-xs font-semibold text-zinc-700 mb-2">
                تخصيص الصلاحيات التفصيلية:
              </div>
              <div className="flex flex-wrap gap-2">
                {(Object.keys(PERMISSION_LABELS) as PermissionKey[])
                  .filter((p) =>
                    (editingUser.email || '').trim().toLowerCase() !== BOOTSTRAP_ADMIN_EMAIL &&
                    (editingUser.role === 'ceo' || editingUser.role === 'branch_manager')
                      ? !DEPARTMENT_OPERATION_PERMISSIONS.includes(p)
                      : true
                  )
                  .map((p) => {
                    const has = editingUser.permissions.includes(p);
                    return (
                      <button
                        key={p}
                        type="button"
                        onClick={() =>
                          setEditingUser({
                            ...editingUser,
                            permissions: has
                              ? editingUser.permissions.filter((x) => x !== p)
                              : [...editingUser.permissions, p],
                          })
                        }
                        className={`min-h-[34px] px-3 py-1 rounded-lg border text-xs font-medium cursor-pointer ${
                          has
                            ? 'bg-[#18181B] text-white border-[#18181B]'
                            : 'bg-white text-zinc-600 border-zinc-200'
                        }`}
                      >
                        {PERMISSION_LABELS[p]}
                      </button>
                    );
                  })}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  setEditingUser(null);
                  setResetPasswordToPhone(false);
                }}
                className="min-h-[40px] px-4 rounded-xl border border-zinc-200 text-xs font-semibold cursor-pointer"
              >
                إلغاء
              </button>
              <button
                type="submit"
                disabled={busy}
                className="min-h-[40px] px-5 rounded-xl bg-[#D91B23] text-xs font-bold text-white cursor-pointer disabled:opacity-50"
              >
                حفظ التغييرات وتفعيل الحساب
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
