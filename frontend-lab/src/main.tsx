import { createRoot } from 'react-dom/client';
import type { ComponentType } from 'react';
import PriceCheckTab from './islands/PriceCheckTab/PriceCheckTab';
import StatisticsTab from './islands/StatisticsTab/StatisticsTab';
import ActivityLogTab from './islands/ActivityLogTab/ActivityLogTab';
import TestListTab from './islands/TestListTab/TestListTab';
import HREmployeesTab from './islands/HREmployeesTab/HREmployeesTab';
import ReportsTab from './islands/ReportsTab/ReportsTab';
import SettingsTab from './islands/SettingsTab/SettingsTab';
import SecurityRBACTab from './islands/SecurityRBACTab/SecurityRBACTab';
import DashboardTab from './islands/DashboardTab/DashboardTab';
import ClientsTab from './islands/ClientsTab/ClientsTab';
import AddClientTab from './islands/AddClientTab/AddClientTab';
import PendingSamplesTab from './islands/PendingSamplesTab/PendingSamplesTab';
import TechScreenTab from './islands/TechScreenTab/TechScreenTab';
import TestResultsTab from './islands/TestResultsTab/TestResultsTab';
import WarehouseTab from './islands/WarehouseTab/WarehouseTab';
import TransactionHistoryTab from './islands/TransactionHistoryTab/TransactionHistoryTab';
import FinancialOverviewTab from './islands/FinancialOverviewTab/FinancialOverviewTab';

// Each migrated tab in index_lab.html gets one mount point, keyed here by its container id.
// showTab() (script_lab.js) keeps owning navigation/visibility (toggling .active on the
// unchanged outer .tab-content wrapper) — these roots just mount once and manage their own
// data/state from then on.
const islands: Record<string, ComponentType> = {
  'price-check-react-root': PriceCheckTab,
  'statistics-react-root': StatisticsTab,
  'activity-log-react-root': ActivityLogTab,
  'test-list-react-root': TestListTab,
  'hr-header-react-root': HREmployeesTab,
  'reports-react-root': ReportsTab,
  'settings-react-root': SettingsTab,
  'security-react-root': SecurityRBACTab,
  'dashboard-react-root': DashboardTab,
  'clients-react-root': ClientsTab,
  'add-client-react-root': AddClientTab,
  'pending-samples-react-root': PendingSamplesTab,
  'tech-screen-react-root': TechScreenTab,
  'test-results-react-root': TestResultsTab,
  'warehouse-react-root': WarehouseTab,
  'transaction-history-react-root': TransactionHistoryTab,
  'financial-overview-react-root': FinancialOverviewTab,
};

document.addEventListener('DOMContentLoaded', () => {
  for (const [containerId, Component] of Object.entries(islands)) {
    const container = document.getElementById(containerId);
    if (container) createRoot(container).render(<Component />);
  }
});
