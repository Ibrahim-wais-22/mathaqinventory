import React, { useMemo } from 'react';
import {
  BarChart3,
  Calendar,
  CheckSquare,
  ChefHat,
  Factory,
  LayoutDashboard,
  LogOut,
  Package,
  ShoppingBag,
  Trash2,
  Users,
} from 'lucide-react';
import {
  BRAND_NAME,
  DEPARTMENT_LABELS,
  ROLE_LABELS,
  SESSION_STATUS_LABELS,
} from '../../constants/departments';
import { useFirebase } from '../../app/providers/FirebaseProvider';
import { BrandLogo } from '../../components/common/BrandLogo';
import { OfflineIndicator } from '../../components/common/OfflineIndicator';
import { PWAInstallButton } from '../../components/common/PWAInstallButton';
import type { NavTabId } from '../../modules/inventory/ExecutiveDashboard';

interface NavItem {
  id: NavTabId;
  label: string;
  icon: React.FC<{ className?: string }>;
}

export const AppShell: React.FC<{
  activeTab: NavTabId;
  onSelectTab: (tab: NavTabId) => void;
  children: React.ReactNode;
}> = ({ activeTab, onSelectTab, children }) => {
  const {
    account,
    isAdmin,
    hasPermission,
    inventoryDate,
    setInventoryDate,
    currentSession,
    logout,
  } = useFirebase();

  const navItems: NavItem[] = useMemo(() => {
    if (!account) return [];
    const items: NavItem[] = [];

    if (isAdmin) {
      items.push({ id: 'dashboard', label: 'لوحة التحكم', icon: LayoutDashboard });
      items.push({ id: 'factory', label: 'المعمل', icon: Factory });
      items.push({ id: 'production', label: 'الإنتاج', icon: ChefHat });
      items.push({ id: 'sales', label: 'المبيعات', icon: ShoppingBag });
      items.push({ id: 'waste', label: 'الهدر والمتبقي', icon: Trash2 });
      items.push({ id: 'catalog', label: 'الأصناف والمجموعات', icon: Package });
      items.push({ id: 'approvals', label: 'الاعتمادات والتدقيق', icon: CheckSquare });
      items.push({ id: 'reports', label: 'التقارير', icon: BarChart3 });
      items.push({ id: 'users', label: 'المستخدمون', icon: Users });
      return items;
    }

    if (account.department === 'factory') {
      items.push({ id: 'factory', label: 'عمليات المعمل', icon: Factory });
    } else if (account.department === 'production') {
      items.push({ id: 'production', label: 'عمليات الإنتاج', icon: ChefHat });
    } else if (account.department === 'sales') {
      items.push({ id: 'sales', label: 'تسجيل المبيعات', icon: ShoppingBag });
    } else if (account.department === 'waste') {
      items.push({ id: 'waste', label: 'تسجيل الهدر', icon: Trash2 });
    }

    if (hasPermission('manage_catalog')) {
      items.push({ id: 'catalog', label: 'الأصناف والمجموعات', icon: Package });
    }

    if (hasPermission('view_reports')) {
      items.push({ id: 'reports', label: 'التقارير', icon: BarChart3 });
    }

    return items;
  }, [account, isAdmin, hasPermission]);

  const allowBackdate = isAdmin || hasPermission('backdate_entries');
  const activeItem = navItems.find((i) => i.id === activeTab) || navItems[0];

  return (
    <div className="min-h-screen bg-[#FAFAFA] text-[#18181B] flex flex-col lg:flex-row" dir="rtl">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:w-[264px] lg:flex-col lg:fixed lg:inset-y-0 lg:right-0 bg-white border-l border-zinc-200 z-30 no-print">
        <div className="p-5 border-b border-zinc-100 flex items-center gap-3">
          <BrandLogo size="md" />
          <div className="min-w-0">
            <div className="font-display font-bold text-sm text-zinc-900 truncate">{BRAND_NAME}</div>
            <div className="text-xs text-zinc-500 truncate">متابعة الجرد اليومي</div>
          </div>
        </div>

        <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectTab(item.id)}
                className={`w-full min-h-[42px] flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                  active
                    ? 'bg-[#D91B23] text-white'
                    : 'text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>

        {account && (
          <div className="p-4 border-t border-zinc-100 space-y-3">
            <div className="text-xs space-y-0.5">
              <div className="font-bold text-zinc-900 truncate">{account.fullName}</div>
              <div className="text-zinc-500 truncate">
                {ROLE_LABELS[account.role]} · {DEPARTMENT_LABELS[account.department]}
              </div>
              <div className="font-mono text-[11px] text-zinc-400 tabular-nums">
                {account.employeeNumber}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void logout()}
              className="w-full min-h-[40px] inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 cursor-pointer"
            >
              <LogOut className="h-4 w-4" />
              <span>تسجيل الخروج</span>
            </button>
          </div>
        )}
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 lg:pr-[264px] flex flex-col min-w-0">
        {/* Top Bar */}
        <header className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-zinc-200 px-4 lg:px-8 h-16 flex items-center justify-between gap-4 no-print">
          <div className="flex items-center gap-3 min-w-0">
            <div className="lg:hidden">
              <BrandLogo size="sm" />
            </div>
            <h1 className="text-base font-bold text-zinc-900 font-display truncate">
              {activeItem?.label || BRAND_NAME}
            </h1>
          </div>

          {/* Inventory Date Selector (Asia/Aden) */}
          <div className="flex items-center gap-2 shrink-0">
            <Calendar className="h-4 w-4 text-zinc-400 hidden sm:block" />
            <input
              type="date"
              value={inventoryDate}
              disabled={!allowBackdate}
              onChange={(e) => setInventoryDate(e.target.value)}
              aria-label="تاريخ الجرد"
              className="min-h-[38px] rounded-xl border border-zinc-200 bg-white px-2.5 text-xs font-semibold text-zinc-800 tabular-nums disabled:bg-zinc-100"
            />
            {currentSession && (
              <span className="hidden md:inline text-xs text-zinc-500 whitespace-nowrap">
                · {SESSION_STATUS_LABELS[currentSession.status]}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <PWAInstallButton />
            <button
              type="button"
              onClick={() => void logout()}
              className="lg:hidden min-h-[38px] min-w-[38px] flex items-center justify-center rounded-xl border border-zinc-200 text-zinc-700 cursor-pointer"
              aria-label="تسجيل الخروج"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </header>

        <main className="flex-1 p-4 lg:p-8 pb-24 lg:pb-10 max-w-7xl w-full mx-auto">
          {children}
        </main>
      </div>

      {/* Mobile Bottom Navigation */}
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-30 bg-white/95 backdrop-blur border-t border-zinc-200 flex items-center overflow-x-auto px-2 h-16 no-print">
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectTab(item.id)}
              className={`min-w-[72px] flex-1 h-full flex flex-col items-center justify-center gap-1 px-2 cursor-pointer ${
                active ? 'text-[#D91B23]' : 'text-zinc-500'
              }`}
            >
              <Icon className="h-5 w-5" />
              <span className="text-[10px] font-semibold whitespace-nowrap">{item.label}</span>
            </button>
          );
        })}
      </nav>

      <OfflineIndicator />
    </div>
  );
};
