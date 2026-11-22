import React from 'react';
import { Clock, LogOut, ShieldAlert, Unlink } from 'lucide-react';
import { ACCOUNT_STATUS_LABELS, BRAND_NAME } from '../../constants/departments';
import { useFirebase } from '../../app/providers/FirebaseProvider';
import { BrandLogo } from '../../components/common/BrandLogo';

export const PendingActivationScreen: React.FC = () => {
  const { account, logout, unlinkGoogleAccount } = useFirebase();
  const isSuspended = account?.status === 'suspended';

  return (
    <div className="min-h-screen bg-[#FAFAFA] flex items-center justify-center p-6" dir="rtl">
      <div className="w-full max-w-md bg-white border border-zinc-200 rounded-2xl p-8 text-center">
        <div className="flex justify-center">
          <BrandLogo size="md" />
        </div>

        <div
          className={`mx-auto mt-6 h-12 w-12 rounded-xl flex items-center justify-center ${
            isSuspended ? 'bg-red-50 text-[#D91B23]' : 'bg-amber-50 text-[#D97706]'
          }`}
        >
          {isSuspended ? <ShieldAlert className="h-6 w-6" /> : <Clock className="h-6 w-6" />}
        </div>

        <h2 className="mt-4 text-xl font-bold text-zinc-900 font-display">
          {isSuspended ? 'الحساب موقوف حالياً' : 'تم ربط البريد — بانتظار التفعيل الإداري'}
        </h2>

        <p className="mt-2 text-sm text-zinc-600 leading-relaxed">
          {isSuspended
            ? 'تم إيقاف صلاحية الدخول لهذا الحساب. يرجى مراجعة المدير التنفيذي أو مدير الفرع.'
            : 'تمت الموافقة على ربط بريدك الإلكتروني بنجاح. بانتظار قيام الإدارة بإدخال بياناتك الأساسية (بما فيها الرقم الوظيفي ورقم الهاتف) وتفعيل حسابك. بعد التفعيل سيكون دخولك بالرقم الوظيفي وكلمة المرور المبدئية هي رقم هاتفك.'}
        </p>

        {account && (
          <div className="mt-5 rounded-xl bg-zinc-50 border border-zinc-200 p-4 text-right text-xs text-zinc-600 space-y-1.5">
            <div>
              <span className="font-semibold text-zinc-800">البريد المرتبط:</span> {account.email}
            </div>
            <div>
              <span className="font-semibold text-zinc-800">الرقم الوظيفي الحالي:</span>{' '}
              <span className="tabular-nums font-mono">{account.employeeNumber}</span>
            </div>
            {account.phoneNumber && (
              <div>
                <span className="font-semibold text-zinc-800">رقم الهاتف:</span>{' '}
                <span className="tabular-nums font-mono">{account.phoneNumber}</span>
              </div>
            )}
            <div>
              <span className="font-semibold text-zinc-800">حالة الحساب:</span>{' '}
              {ACCOUNT_STATUS_LABELS[account.status]}
            </div>
          </div>
        )}

        <div className="mt-6 space-y-2.5">
          <button
            type="button"
            onClick={() => void logout()}
            className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-2.5 text-sm font-semibold text-zinc-800 hover:bg-zinc-50 cursor-pointer"
          >
            <LogOut className="h-4 w-4" />
            <span>العودة لشاشة الدخول</span>
          </button>

          <button
            type="button"
            onClick={() => void unlinkGoogleAccount()}
            className="w-full min-h-[40px] inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-2 text-xs font-semibold text-zinc-600 hover:bg-zinc-100 cursor-pointer"
          >
            <Unlink className="h-3.5 w-3.5" />
            <span>فك ربط البريد واستخدام حساب Google آخر</span>
          </button>
        </div>

        <p className="mt-4 text-xs text-zinc-400">{BRAND_NAME}</p>
      </div>
    </div>
  );
};
