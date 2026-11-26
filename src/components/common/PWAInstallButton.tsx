import React, { useState } from 'react';
import { Download, Share, Smartphone, X } from 'lucide-react';
import { usePWAInstall } from '../../hooks/usePWAInstall';

const IOSInstallGuideModal: React.FC<{ open: boolean; onClose: () => void }> = ({
  open,
  onClose,
}) => {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 safe-pt safe-pb">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 border border-zinc-200 shadow-xl text-right">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-lg font-bold text-zinc-900 font-display">
            تثبيت التطبيق على الآيفون والآيباد
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق"
            className="h-8 w-8 inline-flex items-center justify-center rounded-lg border border-zinc-200 text-zinc-500 hover:bg-zinc-50 cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <ol className="mt-4 space-y-2.5 text-sm text-zinc-600 list-decimal list-inside leading-relaxed">
          <li>
            افتح التطبيق عبر متصفح <strong>Safari</strong> واضغط على أيقونة{' '}
            <strong className="inline-flex items-center gap-1 text-zinc-900">
              المشاركة <Share className="h-3.5 w-3.5 inline text-[#D91B23]" />
            </strong>{' '}
            أسفل الشاشة.
          </li>
          <li>
            مرّر للأسفل واختر <strong>إضافة إلى الشاشة الرئيسية</strong> (Add to Home Screen).
          </li>
          <li>
            اضغط <strong>إضافة</strong> ليفتح التطبيق بملء الشاشة بدون شريط المتصفح.
          </li>
        </ol>
        <button
          type="button"
          onClick={onClose}
          className="mt-5 w-full min-h-[44px] rounded-xl bg-[#18181B] py-2 text-sm font-semibold text-white hover:bg-zinc-800 cursor-pointer"
        >
          فهمت
        </button>
      </div>
    </div>
  );
};

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={() => void install()}
        className="min-h-[36px] inline-flex items-center gap-1.5 rounded-xl bg-[#D91B23] px-3 py-1.5 text-xs font-bold text-white hover:bg-[#B9141B] transition-colors whitespace-nowrap shrink-0 cursor-pointer shadow-xs"
        aria-label="تثبيت التطبيق على الشاشة الرئيسية"
      >
        <Download className="h-3.5 w-3.5 shrink-0" />
        <span>تثبيت التطبيق</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          className="min-h-[36px] inline-flex items-center gap-1.5 rounded-xl border border-[#D91B23]/30 bg-red-50/70 px-3 py-1.5 text-xs font-bold text-[#D91B23] hover:bg-red-100/70 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Smartphone className="h-3.5 w-3.5 shrink-0" />
          <span>تثبيت على iOS</span>
        </button>
        <IOSInstallGuideModal open={showIOSGuide} onClose={() => setShowIOSGuide(false)} />
      </>
    );
  }

  return null;
};

export const PWAInstallBanner: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem('pwa_banner_dismissed') === '1';
    } catch {
      return false;
    }
  });

  if (isInstalled || dismissed || (!isInstallable && !isIOS)) {
    return null;
  }

  const handleDismiss = () => {
    setDismissed(true);
    try {
      sessionStorage.setItem('pwa_banner_dismissed', '1');
    } catch {
      // Ignore storage errors in private browsing
    }
  };

  return (
    <>
      <div
        className="fixed safe-bottom-offset right-4 left-4 sm:left-auto sm:right-6 sm:w-[380px] z-40 rounded-2xl border border-zinc-200 bg-white/95 backdrop-blur p-3.5 shadow-xl flex items-center justify-between gap-3 no-print"
        dir="rtl"
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-10 w-10 rounded-xl bg-[#D91B23] text-white flex items-center justify-center shrink-0">
            <Smartphone className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-bold text-zinc-900 truncate">
              ثبّت تطبيق المذاق اليمني
            </p>
            <p className="text-[11px] text-zinc-500 truncate">
              افتح الجرد بملء الشاشة وبسرعة من الشاشة الرئيسية
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => {
              if (isInstallable) {
                void install();
              } else if (isIOS) {
                setShowIOSGuide(true);
              }
            }}
            className="min-h-[36px] rounded-xl bg-[#D91B23] px-3 py-1.5 text-xs font-bold text-white hover:bg-[#B9141B] cursor-pointer whitespace-nowrap"
          >
            {isIOS && !isInstallable ? 'طريقة التثبيت' : 'تثبيت الآن'}
          </button>
          <button
            type="button"
            onClick={handleDismiss}
            aria-label="إخفاء إشعار التثبيت"
            className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <IOSInstallGuideModal open={showIOSGuide} onClose={() => setShowIOSGuide(false)} />
    </>
  );
};
