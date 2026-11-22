import React, { useState } from 'react';
import { CheckCircle2, Eye, EyeOff, KeyRound, X } from 'lucide-react';
import { useFirebase } from '../../app/providers/FirebaseProvider';
import { changeOwnPassword, formatActionError } from '../../services/inventory/firestoreService';

export const ChangePasswordModal: React.FC<{
  open: boolean;
  onClose: () => void;
}> = ({ open, onClose }) => {
  const { account } = useFirebase();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPasswords, setShowPasswords] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  if (!open || !account) return null;

  const hasExistingPassword = Boolean((account.passwordHash && account.passwordSalt) || account.phoneNumber);

  const resetAndClose = () => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setError(null);
    setSuccess(false);
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    if (hasExistingPassword && !currentPassword.trim()) {
      setError('يرجى إدخال كلمة المرور الحالية.');
      return;
    }
    if (newPassword.trim().length < 4 || newPassword.trim().length > 64) {
      setError('كلمة المرور الجديدة يجب أن تكون 4 خانات على الأقل (حتى 64 خانة).');
      return;
    }
    if (newPassword.trim() !== confirmPassword.trim()) {
      setError('تأكيد كلمة المرور غير مطابق لكلمة المرور الجديدة.');
      return;
    }

    setBusy(true);
    try {
      await changeOwnPassword(account, currentPassword, newPassword);
      setSuccess(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setError(formatActionError(err, 'تعذر تغيير كلمة المرور.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" dir="rtl">
      <div className="w-full max-w-md rounded-2xl bg-white border border-zinc-200 p-6 shadow-lg">
        <div className="flex items-center justify-between border-b border-zinc-100 pb-3">
          <div className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-[#D91B23]" />
            <h3 className="text-base font-bold text-zinc-900 font-display">تغيير كلمة المرور</h3>
          </div>
          <button
            type="button"
            onClick={resetAndClose}
            aria-label="إغلاق"
            className="h-8 w-8 rounded-lg inline-flex items-center justify-center text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div className="rounded-xl bg-zinc-50 border border-zinc-200 px-3.5 py-2.5 text-xs text-zinc-600">
            الرقم الوظيفي:{' '}
            <span className="font-mono font-bold text-zinc-900">{account.employeeNumber}</span>
            {account.phoneNumber && (
              <span className="mr-3">
                · الهاتف المسجل:{' '}
                <span className="font-mono font-semibold text-zinc-800">{account.phoneNumber}</span>
              </span>
            )}
          </div>

          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-medium text-red-700">
              {error}
            </div>
          )}

          {success && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-xs font-semibold text-emerald-800 flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <span>تم تحديث كلمة المرور بنجاح. استخدمها في المرات القادمة عند تسجيل الدخول.</span>
            </div>
          )}

          {hasExistingPassword && (
            <div>
              <label
                htmlFor="cp-current"
                className="block text-xs font-semibold text-zinc-700 mb-1"
              >
                كلمة المرور الحالية
              </label>
              <input
                id="cp-current"
                type={showPasswords ? 'text' : 'password'}
                required
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="رقم الهاتف أو كلمة المرور الحالية"
                className="w-full min-h-[42px] rounded-xl border border-zinc-200 px-3 text-sm"
              />
            </div>
          )}

          <div>
            <label htmlFor="cp-new" className="block text-xs font-semibold text-zinc-700 mb-1">
              كلمة المرور الجديدة
            </label>
            <input
              id="cp-new"
              type={showPasswords ? 'text' : 'password'}
              required
              minLength={4}
              maxLength={64}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="4 خانات فأكثر (سهلة وواضحة)"
              className="w-full min-h-[42px] rounded-xl border border-zinc-200 px-3 text-sm"
            />
          </div>

          <div>
            <label
              htmlFor="cp-confirm"
              className="block text-xs font-semibold text-zinc-700 mb-1"
            >
              تأكيد كلمة المرور الجديدة
            </label>
            <input
              id="cp-confirm"
              type={showPasswords ? 'text' : 'password'}
              required
              minLength={4}
              maxLength={64}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="أعد إدخال كلمة المرور الجديدة"
              className="w-full min-h-[42px] rounded-xl border border-zinc-200 px-3 text-sm"
            />
          </div>

          <button
            type="button"
            onClick={() => setShowPasswords((prev) => !prev)}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-zinc-600 hover:text-zinc-900 cursor-pointer"
          >
            {showPasswords ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            <span>{showPasswords ? 'إخفاء كلمات المرور' : 'إظهار كلمات المرور'}</span>
          </button>

          <div className="flex justify-end gap-2 pt-2 border-t border-zinc-100">
            <button
              type="button"
              onClick={resetAndClose}
              className="min-h-[40px] px-4 rounded-xl border border-zinc-200 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 cursor-pointer"
            >
              إغلاق
            </button>
            <button
              type="submit"
              disabled={busy}
              className="min-h-[40px] px-5 rounded-xl bg-[#D91B23] text-xs font-bold text-white hover:bg-[#B9141B] cursor-pointer disabled:opacity-50"
            >
              {busy ? 'جاري الحفظ...' : 'حفظ كلمة المرور'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
