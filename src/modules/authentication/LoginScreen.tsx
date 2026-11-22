import React from 'react';
import { LogIn, ShieldCheck } from 'lucide-react';
import { BRAND_ENGLISH, BRAND_NAME } from '../../constants/departments';
import { useFirebase } from '../../app/providers/FirebaseProvider';
import { BrandLogo } from '../../components/common/BrandLogo';
import { PWAInstallButton } from '../../components/common/PWAInstallButton';

export const LoginScreen: React.FC = () => {
  const { signInWithGoogle, authError, authLoading } = useFirebase();

  return (
    <div className="min-h-screen bg-[#FAFAFA] flex flex-col justify-between p-6" dir="rtl">
      <div className="flex items-center justify-between max-w-5xl w-full mx-auto">
        <div className="flex items-center gap-3">
          <BrandLogo size="sm" />
          <span className="font-display font-bold text-zinc-900 text-base">{BRAND_NAME}</span>
        </div>
        <PWAInstallButton />
      </div>

      <main className="flex-1 flex items-center justify-center py-10">
        <div className="w-full max-w-md bg-white border border-zinc-200 rounded-2xl p-8">
          <div className="flex flex-col items-center text-center">
            <BrandLogo size="lg" />
            <h1 className="mt-5 text-2xl font-extrabold text-zinc-900 font-display text-balance">
              نظام متابعة الجرد اليومي
            </h1>
            <p className="mt-1 text-sm text-zinc-500">
              {BRAND_NAME} · {BRAND_ENGLISH}
            </p>
          </div>

          <div className="mt-8 border-t border-zinc-100 pt-6">
            <p className="text-sm text-zinc-600 leading-relaxed text-center">
              سجّل الدخول بحسابك الوظيفي المعتمد عبر Google للوصول إلى مساحة عمل إدارتك ومتابعة
              عمليات الجرد اليومية.
            </p>

            {authError && (
              <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs font-medium text-red-700">
                {authError}
              </div>
            )}

            <button
              type="button"
              onClick={() => void signInWithGoogle()}
              disabled={authLoading}
              className="mt-6 w-full min-h-[48px] flex items-center justify-center gap-3 rounded-xl bg-[#D91B23] px-5 py-3 text-sm font-bold text-white hover:bg-[#B9141B] transition-colors cursor-pointer disabled:opacity-60"
            >
              <LogIn className="h-5 w-5" />
              <span>{authLoading ? 'جاري التحقق من الحساب...' : 'تسجيل الدخول بحساب Google'}</span>
            </button>
          </div>

          <div className="mt-6 flex items-center justify-center gap-2 text-xs text-zinc-500">
            <ShieldCheck className="h-4 w-4 text-emerald-600 shrink-0" />
            <span>حسابات مستقلة لكل موظف · صلاحيات محمية على مستوى الخادم</span>
          </div>
        </div>
      </main>

      <footer className="text-center text-xs text-zinc-400">
        {BRAND_NAME} · المنطقة الزمنية المعتمدة: Asia/Aden
      </footer>
    </div>
  );
};
