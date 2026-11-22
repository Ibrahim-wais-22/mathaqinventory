import type {
  AccountStatus,
  ApprovalType,
  DepartmentId,
  OperationalDepartmentId,
  PermissionKey,
  ProductApprovalStatus,
  ReportStatus,
  SessionStatus,
  TransferStatus,
  UserRole,
  VarianceType,
} from '../types/inventory';

export const BRAND_NAME = 'مطاعم المذاق اليمني';
export const BRAND_ENGLISH = 'Al Mathaq Al Yemeni';
export const BRAND_LOGO_URL = '/assets/aistudio/WhatsApp_Image_2026-11-21_at_8.51.07_AM_f3716b06.jpeg';
export const BOOTSTRAP_ADMIN_EMAIL = 'mathaqinventory@gmail.com';
export const DEFAULT_BRANCH_ID = 'branch_main';
export const DEFAULT_BRANCH_NAME = 'الفرع الرئيسي — المذاق اليمني';
export const TIMEZONE = 'Asia/Aden';

export const DEPARTMENT_LABELS: Record<DepartmentId, string> = {
  management: 'الإدارة العليا',
  factory: 'المعمل',
  production: 'الإنتاج',
  sales: 'المبيعات',
  waste: 'الهدر',
};

export const OPERATIONAL_DEPARTMENTS: OperationalDepartmentId[] = [
  'factory',
  'production',
  'sales',
  'waste',
];

export const ROLE_LABELS: Record<UserRole, string> = {
  ceo: 'المدير التنفيذي',
  branch_manager: 'مدير الفرع',
  factory_staff: 'موظف المعمل',
  production_staff: 'موظف الإنتاج',
  sales_staff: 'موظف المبيعات',
  waste_staff: 'موظف الهدر',
  pending: 'بانتظار التفعيل',
};

export const ACCOUNT_STATUS_LABELS: Record<AccountStatus, string> = {
  active: 'نشط',
  suspended: 'موقوف',
  pending_activation: 'بانتظار التفعيل',
};

export const PERMISSION_LABELS: Record<PermissionKey, string> = {
  manage_users: 'إدارة المستخدمين والصلاحيات',
  manage_catalog: 'إدارة الأصناف والمجموعات',
  approve_products_technical: 'الاعتماد الفني للأصناف',
  approve_products_admin: 'الاعتماد الإداري للأصناف',
  factory_operations: 'عمليات المعمل والتوريدات',
  production_operations: 'استلام الإنتاج والإنتاج المستقل',
  sales_operations: 'تسجيل المبيعات بالعدد',
  waste_operations: 'تسجيل الهدر والمتبقي',
  view_results: 'الاطلاع على نتائج الجرد',
  view_reports: 'الاطلاع على التقارير التفصيلية',
  export_reports: 'تصدير التقارير (PDF و Excel)',
  approve_corrections: 'اعتماد التصحيحات والفروقات',
  close_session: 'إغلاق يوم الجرد',
  reopen_session: 'إعادة فتح يوم مغلق',
  backdate_entries: 'تسجيل عمليات بتواريخ سابقة',
  view_audit_logs: 'الاطلاع على سجل العمليات والتدقيق',
};

export const DEFAULT_ROLE_PERMISSIONS: Record<Exclude<UserRole, 'pending'>, PermissionKey[]> = {
  ceo: Object.keys(PERMISSION_LABELS) as PermissionKey[],
  branch_manager: Object.keys(PERMISSION_LABELS) as PermissionKey[],
  factory_staff: ['factory_operations', 'backdate_entries'],
  production_operations: undefined as never,
  production_staff: [
    'production_operations',
    'approve_products_technical',
    'view_results',
    'backdate_entries',
  ],
  sales_staff: ['sales_operations', 'view_results', 'backdate_entries'],
  waste_staff: ['waste_operations', 'backdate_entries'],
} as unknown as Record<Exclude<UserRole, 'pending'>, PermissionKey[]>;

// Clean initialization without stray keys
export function getDefaultPermissionsForRole(role: Exclude<UserRole, 'pending'>): PermissionKey[] {
  switch (role) {
    case 'ceo':
    case 'branch_manager':
      return Object.keys(PERMISSION_LABELS) as PermissionKey[];
    case 'factory_staff':
      return ['factory_operations', 'backdate_entries'];
    case 'production_staff':
      return ['production_operations', 'approve_products_technical', 'view_results', 'backdate_entries'];
    case 'sales_staff':
      return ['sales_operations', 'view_results', 'backdate_entries'];
    case 'waste_staff':
      return ['waste_operations', 'backdate_entries'];
  }
}

export function getDepartmentForRole(role: Exclude<UserRole, 'pending'>): DepartmentId {
  switch (role) {
    case 'ceo':
    case 'branch_manager':
      return 'management';
    case 'factory_staff':
      return 'factory';
    case 'production_staff':
      return 'production';
    case 'sales_staff':
      return 'sales';
    case 'waste_staff':
      return 'waste';
  }
}

export const SESSION_STATUS_LABELS: Record<SessionStatus, string> = {
  open: 'يوم مفتوح',
  closed: 'يوم مغلق',
  reopened: 'معاد فتحه للتصحيح',
};

export const REPORT_STATUS_LABELS: Record<ReportStatus, string> = {
  draft: 'مسودة',
  submitted: 'مرحّل',
  pending_review: 'بانتظار المراجعة',
  approved: 'معتمد',
  closed: 'مغلق',
};

export const TRANSFER_STATUS_LABELS: Record<TransferStatus, string> = {
  pending_receipt: 'بانتظار الاستلام',
  received: 'تم الاستلام مطابقاً',
  discrepancy_logged: 'مستلم مع فرق تسليم',
};

export const PRODUCT_APPROVAL_LABELS: Record<ProductApprovalStatus, string> = {
  pending_technical: 'بانتظار الاعتماد الفني',
  pending_admin: 'بانتظار الاعتماد الإداري',
  approved: 'معتمد',
  rejected: 'مرفوض',
  inactive: 'غير نشط',
};

export const VARIANCE_LABELS: Record<VarianceType, string> = {
  matched: 'مطابق',
  deficit: 'عجز',
  surplus: 'زيادة',
};

export const APPROVAL_TYPE_LABELS: Record<ApprovalType, string> = {
  product_technical: 'اعتماد فني لصنف جديد',
  product_admin: 'اعتماد إداري لصنف جديد',
  report_correction: 'طلب تصحيح بعد الترحيل',
  session_reopen: 'إعادة فتح يوم مغلق',
  delivery_variance_settlement: 'تسوية فرق تسليم',
};

export interface SeedCategorySpec {
  id: string;
  name: string;
  sortOrder: number;
}

export interface SeedProductSpec {
  id: string;
  name: string;
  categoryId: string;
  unit: string;
  allowedDepartments: OperationalDepartmentId[];
}

export const SEED_CATEGORIES: SeedCategorySpec[] = [
  { id: 'cat_meats', name: 'اللحوم', sortOrder: 1 },
  { id: 'cat_chicken', name: 'الدجاج', sortOrder: 2 },
  { id: 'cat_appetizers', name: 'المقبلات', sortOrder: 3 },
  { id: 'cat_stews', name: 'الإدامات', sortOrder: 4 },
];

export const SEED_PRODUCTS: SeedProductSpec[] = [
  {
    id: 'prod_mandi_lamb',
    name: 'مندي لحم بلدي',
    categoryId: 'cat_meats',
    unit: 'نفر',
    allowedDepartments: ['factory', 'production', 'sales', 'waste'],
  },
  {
    id: 'prod_haneeth_lamb',
    name: 'حنيذ لحم',
    categoryId: 'cat_meats',
    unit: 'نفر',
    allowedDepartments: ['factory', 'production', 'sales', 'waste'],
  },
  {
    id: 'prod_zurbian_lamb',
    name: 'زربيان لحم عدني',
    categoryId: 'cat_meats',
    unit: 'نفر',
    allowedDepartments: ['factory', 'production', 'sales', 'waste'],
  },
  {
    id: 'prod_madhbi_chicken',
    name: 'مظبي دجاج على الحجر',
    categoryId: 'cat_chicken',
    unit: 'حبة',
    allowedDepartments: ['factory', 'production', 'sales', 'waste'],
  },
  {
    id: 'prod_mandi_chicken',
    name: 'مندي دجاج',
    categoryId: 'cat_chicken',
    unit: 'حبة',
    allowedDepartments: ['factory', 'production', 'sales', 'waste'],
  },
  {
    id: 'prod_madghout_chicken',
    name: 'مضغوط دجاج',
    categoryId: 'cat_chicken',
    unit: 'حبة',
    allowedDepartments: ['factory', 'production', 'sales', 'waste'],
  },
  {
    id: 'prod_shafout',
    name: 'شفوت يمني',
    categoryId: 'cat_appetizers',
    unit: 'صحن',
    allowedDepartments: ['factory', 'production', 'sales', 'waste'],
  },
  {
    id: 'prod_sahawiq_cheese',
    name: 'سحاوق بالجبن',
    categoryId: 'cat_appetizers',
    unit: 'علبة',
    allowedDepartments: ['factory', 'production', 'sales', 'waste'],
  },
  {
    id: 'prod_fresh_salad',
    name: 'سلطة خضراء طازجة',
    categoryId: 'cat_appetizers',
    unit: 'صحن',
    allowedDepartments: ['production', 'sales', 'waste'],
  },
  {
    id: 'prod_fahsa',
    name: 'فحسة لحم بالبرام',
    categoryId: 'cat_stews',
    unit: 'برام',
    allowedDepartments: ['factory', 'production', 'sales', 'waste'],
  },
  {
    id: 'prod_saltah',
    name: 'سلتة يمنية',
    categoryId: 'cat_stews',
    unit: 'برام',
    allowedDepartments: ['factory', 'production', 'sales', 'waste'],
  },
  {
    id: 'prod_uqda_chicken',
    name: 'عقدة دجاج',
    categoryId: 'cat_stews',
    unit: 'صحن',
    allowedDepartments: ['factory', 'production', 'sales', 'waste'],
  },
];
