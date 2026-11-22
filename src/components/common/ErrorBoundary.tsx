import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    let readable = error.message || 'حدث خطأ غير متوقع في التطبيق.';
    try {
      const parsed = JSON.parse(error.message);
      if (parsed?.error) {
        readable = `خطأ في قاعدة البيانات أو الصلاحيات: ${parsed.error}`;
      }
    } catch {
      // keep raw message
    }
    return { hasError: true, message: readable };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#FAFAFA] flex items-center justify-center p-6" dir="rtl">
          <div className="w-full max-w-lg bg-white border border-zinc-200 rounded-2xl p-8 text-center">
            <div className="mx-auto mb-4 h-12 w-12 rounded-xl bg-red-50 text-[#D91B23] flex items-center justify-center">
              <AlertTriangle className="h-6 w-6" />
            </div>
            <h2 className="text-xl font-bold text-zinc-900 font-display">تعذر إتمام العملية</h2>
            <p className="mt-2 text-sm text-zinc-600 leading-relaxed">{this.state.message}</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-6 inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#D91B23] text-white text-sm font-semibold hover:bg-[#B9141B] transition-colors cursor-pointer"
            >
              <RefreshCw className="h-4 w-4" />
              إعادة تحميل الصفحة
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
