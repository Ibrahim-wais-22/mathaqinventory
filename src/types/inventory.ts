import type { Timestamp } from 'firebase/firestore';

export type DepartmentId = 'management' | 'factory' | 'production' | 'sales' | 'waste';
export type OperationalDepartmentId = 'factory' | 'production' | 'sales' | 'waste';

export type UserRole =
  | 'ceo'
  | 'branch_manager'
  | 'factory_staff'
  | 'production_staff'
  | 'sales_staff'
  | 'waste_staff'
  | 'pending';

export type AccountStatus = 'active' | 'suspended' | 'pending_activation';

export type PermissionKey =
  | 'manage_users'
  | 'manage_catalog'
  | 'approve_products_technical'
  | 'approve_products_admin'
  | 'factory_operations'
  | 'production_operations'
  | 'sales_operations'
  | 'waste_operations'
  | 'view_results'
  | 'view_reports'
  | 'export_reports'
  | 'approve_corrections'
  | 'close_session'
  | 'reopen_session'
  | 'backdate_entries'
  | 'view_audit_logs';

export type ProductApprovalStatus =
  | 'pending_technical'
  | 'pending_admin'
  | 'approved'
  | 'rejected'
  | 'inactive';

export type SessionStatus = 'open' | 'closed' | 'reopened';
export type ReportStatus = 'draft' | 'submitted' | 'pending_review' | 'approved' | 'closed';
export type TransferStatus = 'pending_receipt' | 'received' | 'discrepancy_logged';
export type VarianceType = 'matched' | 'deficit' | 'surplus';
export type ApprovalType =
  | 'product_technical'
  | 'product_admin'
  | 'report_correction'
  | 'session_reopen'
  | 'delivery_variance_settlement';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface Branch {
  id: string;
  name: string;
  code: string;
  timezone: string;
  isActive: boolean;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface UserAccount {
  uid: string;
  employeeNumber: string;
  username: string;
  fullName: string;
  phoneNumber?: string;
  passwordSalt?: string;
  passwordHash?: string;
  passwordUpdatedAt?: Timestamp;
  email: string;
  department: DepartmentId;
  role: UserRole;
  branchId: string;
  status: AccountStatus;
  permissions: PermissionKey[];
  inviteId?: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface UserInvite {
  id: string;
  email: string;
  employeeNumber: string;
  username: string;
  fullName: string;
  phoneNumber?: string;
  passwordSalt?: string;
  passwordHash?: string;
  department: DepartmentId;
  role: Exclude<UserRole, 'pending'>;
  branchId: string;
  status: 'active' | 'suspended';
  permissions: PermissionKey[];
  claimed: boolean;
  createdBy: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface Category {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  createdBy: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface ProductUnitOption {
  name: string;
  factor: number;
}

export type UnitBreakdown = Record<string, number>;

export type ReportQtyFieldKey =
  | 'preparedQty'
  | 'independentProductionQty'
  | 'salesQty'
  | 'damagedQty'
  | 'validRemainingQty'
  | 'invalidRemainingQty';

export interface Product {
  id: string;
  name: string;
  categoryId: string;
  unit: string;
  units?: ProductUnitOption[];
  isActive: boolean;
  approvalStatus: ProductApprovalStatus;
  allowedDepartments: OperationalDepartmentId[];
  createdBy: string;
  createdByName: string;
  technicalApprovedBy?: string;
  technicalApprovedByName?: string;
  adminApprovedBy?: string;
  adminApprovedByName?: string;
  rejectionReason?: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface DailySession {
  id: string;
  branchId: string;
  inventoryDate: string; // YYYY-MM-DD in Asia/Aden
  status: SessionStatus;
  previousSessionId?: string;
  openingBalanceApproved: boolean;
  closedBy?: string;
  closedByName?: string;
  closingDecisionNote?: string;
  reopenedBy?: string;
  reopenedByName?: string;
  reopenReason?: string;
  createdBy: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface DepartmentReport {
  id: string;
  sessionId: string;
  branchId: string;
  inventoryDate: string;
  department: OperationalDepartmentId;
  status: ReportStatus;
  itemCount: number;
  createdBy: string;
  submittedBy?: string;
  submittedByName?: string;
  approvedBy?: string;
  approvedByName?: string;
  lastCorrectionReason?: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface DepartmentReportItem {
  id: string; // productId
  reportId: string;
  sessionId: string;
  branchId: string;
  inventoryDate: string;
  department: OperationalDepartmentId;
  productId: string;
  categoryId: string;
  preparedQty?: number | null;
  independentProductionQty?: number | null;
  salesQty?: number | null;
  damagedQty?: number | null;
  validRemainingQty?: number | null;
  invalidRemainingQty?: number | null;
  unitBreakdowns?: Partial<Record<ReportQtyFieldKey, UnitBreakdown>> | null;
  note?: string;
  updatedBy: string;
  updatedByName: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface FactoryTransfer {
  id: string;
  sessionId: string;
  branchId: string;
  inventoryDate: string;
  transferNumber: string;
  status: TransferStatus;
  totalSentQty: number;
  totalReceivedQty: number;
  totalVarianceQty: number;
  factoryNote?: string;
  productionNote?: string;
  createdBy: string;
  createdByName: string;
  receivedBy?: string;
  receivedByName?: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface FactoryTransferItem {
  id: string; // productId
  transferId: string;
  sessionId: string;
  productId: string;
  productName: string;
  unit: string;
  sentQty: number;
  receivedQty?: number | null;
  varianceQty?: number | null;
  sentBreakdown?: UnitBreakdown | null;
  receivedBreakdown?: UnitBreakdown | null;
  note?: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface ProductionEntry {
  id: string;
  sessionId: string;
  branchId: string;
  inventoryDate: string;
  productId: string;
  qty: number;
  unitBreakdown?: UnitBreakdown | null;
  note?: string;
  createdBy: string;
  createdByName: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface ProductResult {
  id: string; // sessionId_productId
  sessionId: string;
  branchId: string;
  inventoryDate: string;
  productId: string;
  productName: string;
  categoryId: string;
  categoryName: string;
  unit: string;
  openingBalance: number;
  factorySentQty: number;
  factoryReceivedQty: number;
  deliveryVarianceQty: number;
  independentProductionQty: number;
  totalProduction: number;
  totalAvailable: number;
  salesQty: number;
  damagedQty: number;
  validRemainingQty: number;
  invalidRemainingQty: number;
  variance: number;
  varianceType: VarianceType;
  isFinalized: boolean;
  computedBy: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface ApprovalRequest {
  id: string;
  type: ApprovalType;
  sessionId?: string;
  inventoryDate?: string;
  targetCollection: string;
  targetId: string;
  productId?: string;
  department?: string;
  status: ApprovalStatus;
  reason: string;
  fieldKey?: string;
  oldValue?: number | null;
  newValue?: number | null;
  requestedBy: string;
  requestedByName: string;
  reviewedBy?: string;
  reviewedByName?: string;
  reviewNote?: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface AuditLog {
  id: string;
  sessionId?: string;
  inventoryDate?: string;
  branchId?: string;
  department?: string;
  actorUid: string;
  actorName: string;
  actorRole: string;
  action: string;
  targetCollection: string;
  targetId: string;
  oldValueSummary?: string;
  newValueSummary?: string;
  reason?: string;
  createdAt?: Timestamp;
}

export interface SystemSetting {
  id: string;
  timezone: string;
  activeBranchId: string;
  seeded: boolean;
  updatedBy: string;
  updatedAt?: Timestamp;
}
