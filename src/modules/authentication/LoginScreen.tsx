import React, { useState } from 'react';
import {
  Eye,
  EyeOff,
  KeyRound,
  Link2,
  LogIn,
  Mail,
  Unlink,
  UserPlus,
} from 'lucide-react';
import { BRAND_NAME } from '../../constants/departments';
import { useFirebase } from '../../app/providers/FirebaseProvider';
import { BrandLogo } from '../../components/common/BrandLogo';
import { OfflineIndicator } from '../../components/common/OfflineIndicator';
import { PWAInstallBanner, PWAInstallButton } from '../../components/common/PWAInstallButton';

type LoginTab = 'credentials' | 'first_time';

export const LoginScreen: React.FC = () => {
  const {
    signInWithGoogle,
    signInWithCredentials,
    unlinkGoogleAccount,
    linkedEmail,
    authError,
    clearAuthError,
    authLoading,
  } = useFirebase();

  const [tab, setTab] = useState<LoginTab>('credentials');
  const [employeeNumber, setEmployeeNumber] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [emailLinkConsent, setEmailLinkConsent] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const activeError = localError || authError;

  const handleSwitchTab = (next: LoginTab) => {
    setTab(next);
    setLocalError(null);
    clearAuthError();
  };

  const handleCredentialSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    clearAuthError();

    if (!employeeNumber.trim() || !password.trim()) {
      setLocalError('يرجى إدخال الرقم الوظيفي وكلمة المرور.');
      return;
    }

    setSubmitting(true);
    try {
      await signInWithCredentials(employeeNumber, password);
    } finally {
      setSubmitting(false);
    }
  };

  const handleFirstTimeGoogleLink = async () => {
    setLocalError(null);
    clearAuthError();

    setSubmitting(true);
    try {
      const result = await signInWithGoogle(emailLinkConsent);
      if (result === 'already_active') {
        setTab('credentials');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleUnlink = async () => {
    setLocalError(null);
    clearAuthError();
    setSubmitting(true);
    try {
      await unlinkGoogleAccount();
    } finally {
      setSubmitting(false);
    }
  };

  const isBusy = authLoading || submitting;

  return (
    <div className="min-h-[100dvh] bg-[#FAFAFA] flex flex-col p-4 sm:p-6 safe-pt safe-pb safe-px" dir="rtl">
      <div className="flex items-center justify-between max-w-5xl w-full mx-auto">
        <div className="flex items-center gap-3">
          <BrandLogo size="sm" />
          <span className="font-display font-bold text-zinc-900 text-base">{BRAND_NAME}</span>
        </div>
        <PWAInstallButton />
      </div>

      <main className="flex-1 flex items-center justify-center py-8">
        <div className="w-full max-w-md bg-white border border-zinc-200 rounded-2xl p-6 sm:p-8 shadow-xs">
          <div className="flex flex-col items-center text-center">
            <BrandLogo size="lg" />
            <h1 className="mt-4 text-2xl font-extrabold text-zinc-900 font-display text-balance">
              تسجيل الدخول
            </h1>
            <p className="mt-1 text-sm text-zinc-500">{BRAND_NAME}</p>
          </div>

          <div className="mt-6 grid grid-cols-2 gap-1.5 rounded-xl bg-zinc-100 p-1">
            <button
              type="button"
              onClick={() => handleSwitchTab('credentials')}
              className={`min-h-[40px] rounded-lg px-3 py-2 text-xs font-bold inline-flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
                tab === 'credentials'
                  ? 'bg-white text-zinc-900 shadow-xs'
                  : 'text-zinc-600 hover:text-zinc-900'
              }`}
            >
              <KeyRound className="h-3.5 w-3.5 shrink-0 text-[#D91B23]" />
              <span>دخول</span>
            </button>
            <button
              type="button"
              onClick={() => handleSwitchTab('first_time')}
              className={`min-h-[40px] rounded-lg px-3 py-2 text-xs font-bold inline-flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
                tab === 'first_time'
                  ? 'bg-white text-zinc-900 shadow-xs'
                  : 'text-zinc-600 hover:text-zinc-900'
              }`}
            >
              <UserPlus className="h-3.5 w-3.5 shrink-0 text-[#D91B23]" />
              <span>أول مرة</span>
            </button>
          </div>

          {activeError && (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs font-medium text-red-700 leading-relaxed">
              {activeError}
            </div>
          )}

          {tab === 'credentials' ? (
            <form onSubmit={handleCredentialSubmit} className="mt-5 space-y-4">
              {linkedEmail && (
                <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 flex items-center justify-between gap-2">
                  <div className="min-w-0 flex items-center gap-1.5 text-xs font-medium text-zinc-700">
                    <Mail className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                    <span className="truncate">{linkedEmail}</span>
                  </div>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => void handleUnlink()}
                    className="shrink-0 inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold text-zinc-600 hover:text-zinc-900 hover:bg-zinc-200/60 cursor-pointer disabled:opacity-50"
                  >
                    <Unlink className="h-3 w-3" />
                    <span>تغيير</span>
                  </button>
                </div>
              )}

              <div>
                <label
                  htmlFor="login-emp-no"
                  className="block text-xs font-semibold text-zinc-700 mb-1.5"
                >
                  الرقم الوظيفي
                </label>
                <input
                  id="login-emp-no"
                  type="text"
                  required
                  autoComplete="username"
                  value={employeeNumber}
                  onChange={(e) => setEmployeeNumber(e.target.value)}
                  placeholder="أدخل الرقم الوظيفي"
                  className="w-full min-h-[44px] rounded-xl border border-zinc-300 bg-white px-3.5 text-sm font-semibold text-zinc-900 placeholder:font-normal placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-[#D91B23]/20 focus:border-[#D91B23]"
                />
              </div>

              <div>
                <label
                  htmlFor="login-password"
                  className="block text-xs font-semibold text-zinc-700 mb-1.5"
                >
                  كلمة المرور
                </label>
                <div className="relative">
                  <input
                    id="login-password"
                    type={showPassword ? 'text' : 'password'}
                    required
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="أدخل كلمة المرور"
                    className="w-full min-h-[44px] rounded-xl border border-zinc-300 bg-white pl-10 pr-3.5 text-sm font-semibold text-zinc-900 placeholder:font-normal placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-[#D91B23]/20 focus:border-[#D91B23]"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((prev) => !prev)}
                    aria-label={showPassword ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'}
                    className="absolute inset-y-0 left-0 px-3 flex items-center text-zinc-400 hover:text-zinc-700 cursor-pointer"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={isBusy}
                className="w-full min-h-[46px] flex items-center justify-center gap-2 rounded-xl bg-[#D91B23] px-5 py-3 text-sm font-bold text-white hover:bg-[#B9141B] transition-colors cursor-pointer disabled:opacity-60"
              >
                <LogIn className="h-4 w-4" />
                <span>{isBusy ? 'جاري الدخول...' : 'تسجيل الدخول'}</span>
              </button>
            </form>
          ) : (
            <div className="mt-5 space-y-4">
              <label className="flex items-center gap-2.5 rounded-xl border border-zinc-200 bg-zinc-50/70 p-3.5 cursor-pointer hover:bg-zinc-50 transition-colors">
                <input
                  type="checkbox"
                  checked={emailLinkConsent}
                  onChange={(e) => {
                    setEmailLinkConsent(e.target.checked);
                    if (e.target.checked) setLocalError(null);
                  }}
                  className="h-4 w-4 rounded border-zinc-300 text-[#D91B23] focus:ring-[#D91B23]"
                />
                <span className="text-xs font-semibold text-zinc-800">
                  أوافق على ربط بريدي الإلكتروني عبر Google
                </span>
              </label>

              <button
                type="button"
                onClick={() => void handleFirstTimeGoogleLink()}
                disabled={isBusy}
                className="w-full min-h-[46px] flex items-center justify-center gap-2.5 rounded-xl bg-[#D91B23] px-5 py-3 text-sm font-bold text-white hover:bg-[#B9141B] transition-colors cursor-pointer disabled:opacity-60"
              >
                <Link2 className="h-4 w-4" />
                <span>{isBusy ? 'جاري الربط...' : 'ربط البريد عبر Google'}</span>
              </button>
            </div>
          )}
        </div>
      </main>

      <footer className="pt-2 pb-1 text-center text-[11px] font-medium text-zinc-400">
        بواسطة م.ابراهيم ويس
      </footer>
      <OfflineIndicator />
      <PWAInstallBanner />
    </div>
  );
};
