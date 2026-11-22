import React, { useMemo, useState } from 'react';
import {
  BarChart3,
  Calendar,
  CheckSquare,
  ChefHat,
  Factory,
  History,
  KeyRound,
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
import { ChangePasswordModal } from '../../components/common/ChangePasswordModal';
import { OfflineIndicator } from '../../components/common/OfflineIndicator';
import { PWAInstallButton } from '../../components/common/PWAInstallButton';
import { RecentActivityDrawer } from '../../components/common/RecentActivityDrawer';
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
  const [activityOpen, setActivityOpen] = useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);

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

  return (
    <div className="min-h-screen bg-[#FAFAFA] text-[#18181B] flex flex-col" dir="rtl">
      {/* Sticky Top Header + Top Tab Bar */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-zinc-200 no-print">
        {/* Top Utility Row: Brand, Date Control, User & Logout */}
        <div className="max-w-7xl mx-auto px-4 lg:px-8 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <BrandLogo size="sm" />
            <div className="min-w-0 flex items-center gap-2">
              <span className="font-display font-bold text-sm lg:text-base text-zinc-900 whitespace-nowrap truncate">
                {BRAND_NAME}
              </span>
              {account && (
                <span className="hidden xl:inline text-xs text-zinc-500 whitespace-nowrap truncate">
                  · {account.fullName} ({ROLE_LABELS[account.role]} ·{' '}
                  {DEPARTMENT_LABELS[account.department]})
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            {/* Inventory Date Selector (Asia/Aden) */}
            <div className="flex items-center gap-1.5 shrink-0">
              <Calendar className="h-4 w-4 text-zinc-400 hidden sm:block" />
              <input
                type="date"
                value={inventoryDate}
                disabled={!allowBackdate}
                onChange={(e) => setInventoryDate(e.target.value)}
                aria-label="تاريخ الجرد"
                className="min-h-[36px] rounded-xl border border-zinc-200 bg-white px-2.5 text-xs font-semibold text-zinc-800 tabular-nums disabled:bg-zinc-100"
              />
              {currentSession && (
                <span className="hidden md:inline text-xs text-zinc-500 whitespace-nowrap">
                  · {SESSION_STATUS_LABELS[currentSession.status]}
                </span>
              )}
            </div>

            <PWAInstallButton />

            {isAdmin && (
              <button
                type="button"
                onClick={() => setActivityOpen(true)}
                className="min-h-[36px] inline-flex items-center gap-1.5 rounded-xl border border-zinc-200 bg-white px-2.5 sm:px-3 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                aria-label="آخر العمليات والتعديلات"
                title="آخر العمليات والتعديلات"
              >
                <History className="h-4 w-4 text-[#D91B23] shrink-0" />
                <span className="hidden md:inline">آخر العمليات</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => setChangePasswordOpen(true)}
              className="min-h-[36px] inline-flex items-center gap-1.5 rounded-xl border border-zinc-200 bg-white px-2.5 sm:px-3 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 transition-colors cursor-pointer whitespace-nowrap shrink-0"
              aria-label="تغيير كلمة المرور"
              title="تغيير كلمة المرور"
            >
              <KeyRound className="h-4 w-4 text-zinc-600 shrink-0" />
              <span className="hidden md:inline">كلمة المرور</span>
            </button>

            <button
              type="button"
              onClick={() => void logout()}
              className="min-h-[36px] inline-flex items-center gap-1.5 rounded-xl border border-zinc-200 bg-white px-2.5 sm:px-3 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 transition-colors cursor-pointer whitespace-nowrap shrink-0"
              aria-label="تسجيل الخروج"
            >
              <LogOut className="h-4 w-4 shrink-0" />
              <span className="hidden sm:inline">تسجيل الخروج</span>
            </button>
          </div>
        </div>

        {/* Horizontal Top Navigation Tab Bar */}
        <div className="border-t border-zinc-100 bg-white">
          <nav
            aria-label="التنقل الرئيسي"
            className="max-w-7xl mx-auto px-4 lg:px-8 flex items-center gap-1 overflow-x-auto"
          >
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onSelectTab(item.id)}
                  aria-current={active ? 'page' : undefined}
                  className={`min-h-[44px] inline-flex items-center gap-2 px-3.5 py-2 text-xs sm:text-sm border-b-2 transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    active
                      ? 'border-[#D91B23] text-[#D91B23] font-bold bg-red-50/40'
                      : 'border-transparent text-zinc-600 hover:text-zinc-900 hover:bg-zinc-50 font-semibold'
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 p-4 lg:p-8 pb-10 max-w-7xl w-full mx-auto">
        {children}
      </main>

      <OfflineIndicator />

      {isAdmin && (
        <RecentActivityDrawer
          open={activityOpen}
          onClose={() => setActivityOpen(false)}
          onOpenFullAudit={() => onSelectTab('approvals')}
        />
      )}

      <ChangePasswordModal
        open={changePasswordOpen}
        onClose={() => setChangePasswordOpen(false)}
      />
    </div>
  );
};
