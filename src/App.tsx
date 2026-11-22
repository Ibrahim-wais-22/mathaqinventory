import React, { useEffect, useState } from 'react';
import { FirebaseProvider, useFirebase } from './app/providers/FirebaseProvider';
import { AppShell } from './app/layouts/AppShell';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { LoginScreen } from './modules/authentication/LoginScreen';
import { PendingActivationScreen } from './modules/authentication/PendingActivationScreen';
import { FactoryWorkspace } from './modules/factory/FactoryWorkspace';
import { ApprovalsAndAuditView } from './modules/inventory/ApprovalsAndAuditView';
import { ExecutiveDashboard, type NavTabId } from './modules/inventory/ExecutiveDashboard';
import { ProductionWorkspace } from './modules/production/ProductionWorkspace';
import { CatalogManagement } from './modules/products/CatalogManagement';
import { ReportsHub } from './modules/reports/ReportsHub';
import { SalesWorkspace } from './modules/sales/SalesWorkspace';
import { UsersManagement } from './modules/users/UsersManagement';
import { WasteWorkspace } from './modules/waste/WasteWorkspace';

const AuthenticatedApp: React.FC = () => {
  const { firebaseUser, account, authLoading, isAdmin, hasPermission } = useFirebase();
  const [activeTab, setActiveTab] = useState<NavTabId>('dashboard');
  const [reportFilter, setReportFilter] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!account || account.status !== 'active') return;
    if (isAdmin) {
      setActiveTab('dashboard');
    } else if (account.department === 'factory') {
      setActiveTab('factory');
    } else if (account.department === 'production') {
      setActiveTab('production');
    } else if (account.department === 'sales') {
      setActiveTab('sales');
    } else if (account.department === 'waste') {
      setActiveTab('waste');
    }
  }, [account?.uid, account?.status, account?.department, isAdmin]);

  if (authLoading) {
    return (
      <div className="min-h-screen bg-[#FAFAFA] flex items-center justify-center p-6" dir="rtl">
        <div className="text-center space-y-3">
          <div className="h-10 w-10 mx-auto rounded-full border-4 border-zinc-200 border-t-[#D91B23] animate-spin" />
          <p className="text-sm font-semibold text-zinc-600">
            جاري تحميل بيانات نظام المذاق اليمني...
          </p>
        </div>
      </div>
    );
  }

  if (!firebaseUser || !account) {
    return <LoginScreen />;
  }

  if (account.status !== 'active') {
    return <PendingActivationScreen />;
  }

  const handleNavigate = (tab: NavTabId, repFilter?: string) => {
    // Enforce authorization guard before switching views
    if (!isAdmin) {
      const allowedDeptTab = account.department as NavTabId;
      const canReports = tab === 'reports' && hasPermission('view_reports');
      const canCatalog = tab === 'catalog' && hasPermission('manage_catalog');
      if (tab !== allowedDeptTab && !canReports && !canCatalog) {
        return;
      }
    }
    setReportFilter(repFilter);
    setActiveTab(tab);
  };

  const renderWorkspace = () => {
    if (activeTab === 'dashboard' && isAdmin) {
      return <ExecutiveDashboard onNavigate={handleNavigate} />;
    }
    if (activeTab === 'factory' && (isAdmin || account.department === 'factory')) {
      return <FactoryWorkspace />;
    }
    if (activeTab === 'production' && (isAdmin || account.department === 'production')) {
      return <ProductionWorkspace />;
    }
    if (activeTab === 'sales' && (isAdmin || account.department === 'sales')) {
      return <SalesWorkspace />;
    }
    if (activeTab === 'waste' && (isAdmin || account.department === 'waste')) {
      return <WasteWorkspace />;
    }
    if (activeTab === 'catalog' && (isAdmin || hasPermission('manage_catalog'))) {
      return <CatalogManagement />;
    }
    if (activeTab === 'users' && isAdmin) {
      return <UsersManagement />;
    }
    if (activeTab === 'approvals' && isAdmin) {
      return <ApprovalsAndAuditView />;
    }
    if (activeTab === 'reports' && (isAdmin || hasPermission('view_reports'))) {
      return <ReportsHub initialReportId={reportFilter} />;
    }

    // Fallback to user's own department
    switch (account.department) {
      case 'factory':
        return <FactoryWorkspace />;
      case 'production':
        return <ProductionWorkspace />;
      case 'sales':
        return <SalesWorkspace />;
      case 'waste':
        return <WasteWorkspace />;
      default:
        return <ExecutiveDashboard onNavigate={handleNavigate} />;
    }
  };

  return (
    <AppShell activeTab={activeTab} onSelectTab={(tab) => handleNavigate(tab)}>
      {renderWorkspace()}
    </AppShell>
  );
};

export default function App() {
  return (
    <ErrorBoundary>
      <FirebaseProvider>
        <AuthenticatedApp />
      </FirebaseProvider>
    </ErrorBoundary>
  );
}
