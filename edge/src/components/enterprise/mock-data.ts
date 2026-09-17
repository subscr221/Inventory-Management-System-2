// Mock data for the enterprise views (workflows, RBAC, reports). These are stand-ins until the
// edge app exposes a real bootstrap endpoint for each. Kept in one module so the wiring is
// obvious and the replacement point is trivial.

export interface WorkflowStep {
  id: string;
  name: string;
  description: string;
  status: 'pending' | 'in-progress' | 'completed' | 'rejected';
  assignee?: string;
  dueDate?: string;
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  status: 'draft' | 'active' | 'completed' | 'cancelled';
  steps: WorkflowStep[];
  createdBy: string;
  createdAt: string;
}

export interface Permission {
  id: string;
  name: string;
  description: string;
}

export interface Role {
  id: string;
  name: string;
  description: string;
  permissions: string[];
}

export interface RbacUser {
  id: string;
  name: string;
  email: string;
  roleId: string;
}

export interface ReportTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  lastGenerated?: string;
}

export interface ReportData {
  id: string;
  name: string;
  generatedAt: string;
  format: 'pdf' | 'excel' | 'csv';
  size: string;
  createdBy: string;
}

export const MOCK_WORKFLOWS: Workflow[] = [
  {
    id: 'wf-indent-1042',
    name: 'Indent approval #1042',
    description: 'Purchase requisition for raw material, awaiting procurement sign-off.',
    status: 'active',
    createdBy: 'Raman Gate Officer',
    createdAt: '2026-09-17T10:00:00Z',
    steps: [
      {
        id: 'submit',
        name: 'Requisition submitted',
        description: 'The requisition was captured on the edge device and synced.',
        status: 'completed',
        assignee: 'Raman Gate Officer',
      },
      {
        id: 'approve',
        name: 'Procurement approval',
        description: 'Authorise the requisition and release the PO.',
        status: 'pending',
        assignee: 'Procurement Specialist',
        dueDate: '2026-09-20T00:00:00Z',
      },
      {
        id: 'release',
        name: 'Purchase order release',
        description: 'Release the PO to the supplier.',
        status: 'pending',
        assignee: 'Procurement Specialist',
      },
    ],
  },
  {
    id: 'wf-count-2041',
    name: 'Cycle count variance #2041',
    description: 'Recorded count differs from system balance; variance needs approval.',
    status: 'active',
    createdBy: 'Warehouse Manager',
    createdAt: '2026-09-16T08:30:00Z',
    steps: [
      {
        id: 'count',
        name: 'Count entered',
        description: 'The physical count was entered on the device.',
        status: 'completed',
        assignee: 'Warehouse Manager',
      },
      {
        id: 'review',
        name: 'Variance review',
        description: 'Investigate the variance and confirm the adjustment.',
        status: 'completed',
        assignee: 'Warehouse Manager',
      },
      {
        id: 'adjust',
        name: 'Adjustment approval',
        description: 'Approve the stock adjustment to reconcile the balance.',
        status: 'pending',
        assignee: 'Logistics Coordinator',
        dueDate: '2026-09-22T00:00:00Z',
      },
    ],
  },
];

export const MOCK_PERMISSIONS: Permission[] = [
  { id: 'perm.capture', name: 'Capture events', description: 'Record inventory movements on the edge device.' },
  { id: 'perm.approve', name: 'Approve actions', description: 'Approve requisitions, counts, and transfers.' },
  { id: 'perm.reports', name: 'View reports', description: 'Generate and download reports.' },
  { id: 'perm.rbac', name: 'Manage access', description: 'Manage roles, users, and permissions.' },
];

export const MOCK_ROLES: Role[] = [
  {
    id: 'role.warehouse-manager',
    name: 'Warehouse Manager',
    description: 'Oversees stock, counts, and warehouse operations.',
    permissions: ['perm.capture', 'perm.approve', 'perm.reports'],
  },
  {
    id: 'role.procurement-specialist',
    name: 'Procurement Specialist',
    description: 'Raises and approves requisitions and purchase orders.',
    permissions: ['perm.capture', 'perm.approve'],
  },
  {
    id: 'role.logistics-coordinator',
    name: 'Logistics Coordinator',
    description: 'Coordinates transfers, dispatches, and delivery.',
    permissions: ['perm.capture', 'perm.reports'],
  },
  {
    id: 'role.admin',
    name: 'Administrator',
    description: 'Full access, including access management.',
    permissions: ['perm.capture', 'perm.approve', 'perm.reports', 'perm.rbac'],
  },
];

export const MOCK_USERS: RbacUser[] = [
  { id: 'user.alice', name: 'Alice Fernandes', email: 'alice@example.com', roleId: 'role.warehouse-manager' },
  { id: 'user.rakesh', name: 'Rakesh Iyer', email: 'rakesh@example.com', roleId: 'role.procurement-specialist' },
  { id: 'user.meera', name: 'Meera Nair', email: 'meera@example.com', roleId: 'role.logistics-coordinator' },
  { id: 'user.admin', name: 'System Admin', email: 'admin@example.com', roleId: 'role.admin' },
];

export const MOCK_REPORT_TEMPLATES: ReportTemplate[] = [
  {
    id: 'rpt.inventory-summary',
    name: 'Inventory summary',
    description: 'On-hand balances by item, lot, and location.',
    category: 'inventory',
    lastGenerated: '2026-09-15T09:00:00Z',
  },
  {
    id: 'rpt.movement-history',
    name: 'Movement history',
    description: 'All inventory movements in a date range.',
    category: 'inventory',
  },
  {
    id: 'rpt.indent-status',
    name: 'Requisitions status',
    description: 'Open and decided requisitions with approval state.',
    category: 'procurement',
  },
  {
    id: 'rpt.dispatch-summary',
    name: 'Dispatch summary',
    description: 'Dispatched orders with documents and GST state.',
    category: 'operations',
  },
];

export const MOCK_REPORTS: ReportData[] = [
  {
    id: 'rep.1',
    name: 'Inventory summary',
    generatedAt: '2026-09-15T09:00:00Z',
    format: 'pdf',
    size: '248 KB',
    createdBy: 'Warehouse Manager',
  },
  {
    id: 'rep.2',
    name: 'Movement history (weekly)',
    generatedAt: '2026-09-14T17:30:00Z',
    format: 'excel',
    size: '1.2 MB',
    createdBy: 'Logistics Coordinator',
  },
];
