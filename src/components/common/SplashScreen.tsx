import React from 'react';
import { BRAND_ENGLISH, BRAND_NAME } from '../../constants/departments';
import { BrandLogo } from './BrandLogo';

interface SplashScreenProps {
  message?: string;
}

export const SplashScreen: React.FC<SplashScreenProps> = ({
  message = 'جاري تشغيل النظام وتأمين الجلسة...',
}) => {
  return (
    <div
      className="fixed inset-0 z-50 min-h-[100dvh] bg-[#FAFAFA] flex flex-col items-center justify-between px-6 py-10 safe-pt safe-pb safe-px"
      dir="rtl"
      aria-live="polite"
    >
      <div className="h-1 w-16 rounded-full bg-[#D91B23]/20" />

      <div className="flex flex-col items-center text-center max-w-xs w-full space-y-5">
        <div className="relative flex items-center justify-center">
          <div className="absolute -inset-3 rounded-3xl bg-[#D91B23]/10 animate-pulse" />
          <div className="relative rounded-2xl bg-white p-2 shadow-sm border border-zinc-200">
            <BrandLogo size="lg" />
          </div>
        </div>

        <div className="space-y-1.5">
          <h1 className="text-2xl font-extrabold text-zinc-900 font-display tracking-tight">
            {BRAND_NAME}
          </h1>
          <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
            {BRAND_ENGLISH} · نظام متابعة الجرد اليومي
          </p>
        </div>

        <div className="w-48 space-y-2.5 pt-2">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200">
            <div className="h-full w-1/2 rounded-full bg-[#D91B23] animate-[pulse_1.2s_ease-in-out_infinite]" />
          </div>
          <p className="text-xs font-medium text-zinc-500">{message}</p>
        </div>
      </div>

      <p className="text-[11px] font-medium text-zinc-400">بواسطة م.ابراهيم ويس</p>
    </div>
  );
};
