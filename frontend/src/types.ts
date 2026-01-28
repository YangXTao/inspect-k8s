export type InspectionItem = {
  id: number;
  name: string;
  description?: string;
  check_type: string;
  prometheus_version?: string | null;
  config?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

export type ExecutionMode = "server" | "agent";

export type AuthUser = {
  id: number;
  username: string;
  display_name?: string | null;
  role: string;
  roles?: string[];
  permissions?: string[];
  is_active?: boolean;
};

export type AuthRole = {
  id: number;
  name: string;
  display_name: string;
  description?: string | null;
  permissions: string[];
  is_system: boolean;
};

export type AuditLog = {
  id: number;
  user_id?: number | null;
  username?: string | null;
  action: string;
  entity_type: string;
  entity_id?: number | null;
  description?: string | null;
  ip_address?: string | null;
  user_agent?: string | null;
  status?: string | null;
  created_at: string;
};

export type AuditLogList = {
  items: AuditLog[];
  total: number;
  page: number;
  page_size: number;
};

export type AuthLoginChallenge = {
  salt: string;
  iterations: number;
  nonce: string;
  scheme: string;
};

export type ClusterConfig = {
  id: number;
  name: string;
  prometheus_url?: string | null;
  contexts: string[];
  description?: string | null;
  connection_status: "connected" | "failed" | "warning" | "unknown";
  connection_message?: string | null;
  agent_health_message?: string | null;
  kubernetes_version?: string | null;
  node_count?: number | null;
  last_checked_at?: string | null;
  created_at: string;
  updated_at: string;
  execution_mode: ExecutionMode;
  default_agent_id?: number | null;
  default_agent_name?: string | null;
  default_agent_description?: string | null;
};

export type OverviewSummary = {
  cluster_total: number;
  cluster_online: number;
  node_ready?: number | null;
  node_total?: number | null;
  pod_total?: number | null;
};

export type InspectionAgentStatus =
  | "queued"
  | "running"
  | "paused"
  | "finished"
  | "failed";

export type InspectionRunStatus =
  | "queued"
  | "running"
  | "paused"
  | "finished"
  | "failed"
  | "cancelled";

export type InspectionResultStatus = "passed" | "warning" | "critical" | "failed";

export type InspectionResult = {
  id: number;
  item_id: number | null;
  status: InspectionResultStatus;
  detail?: string;
  suggestion?: string;
  item_name: string;
};

export type InspectionRun = {
  id: number;
  operator?: string;
  cluster_id: number;
  cluster_name: string;
  status: InspectionRunStatus;
  status_label: string;
  summary?: string;
  report_path?: string;
  total_items: number;
  processed_items: number;
  progress: number;
  pod_count?: number | null;
  created_at: string;
  completed_at?: string;
  prometheus_version?: string | null;
  executor: ExecutionMode;
  agent_status?: InspectionAgentStatus | null;
  agent_status_label?: string | null;
  agent_id?: number | null;
  agent_name?: string | null;
  results: InspectionResult[];
};

export type InspectionRunListItem = {
  id: number;
  operator?: string;
  cluster_id: number;
  cluster_name: string;
  status: InspectionRunStatus;
  status_label: string;
  summary?: string;
  report_path?: string;
  total_items: number;
  processed_items: number;
  progress: number;
  pod_count?: number | null;
  created_at: string;
  completed_at?: string;
  prometheus_version?: string | null;
  executor: ExecutionMode;
  agent_status?: InspectionAgentStatus | null;
  agent_status_label?: string | null;
  agent_id?: number | null;
  agent_name?: string | null;
};

export type InspectionSchedule = {
  id: number;
  name?: string | null;
  cron: string;
  cluster_ids: number[];
  cluster_name_map?: Record<string, string>;
  item_ids: number[];
  is_enabled: boolean;
  last_run_at?: string | null;
  created_at: string;
  updated_at: string;
};

export type InspectionItemsExportPayload = {
  exported_at: string;
  items: InspectionItem[];
};

export type InspectionItemsImportResult = {
  created: number;
  updated: number;
  total: number;
};

export type ClusterNodesPayload = {
  output: string;
  retrieved_at: string;
};

export type ClusterNodesRefreshPayload = {
  agent_id: number;
  requested_at: string;
};

export type LicenseStatus = {
  valid: boolean;
  reason?: string | null;
  product?: string | null;
  licensee?: string | null;
  issued_at?: string | null;
  not_before?: string | null;
  expires_at?: string | null;
  features: string[];
};

export type InspectionAgent = {
  id: number;
  name: string;
  cluster_id?: number | null;
  cluster_name?: string | null;
  description?: string | null;
  is_enabled: boolean;
  prometheus_url?: string | null;
  last_seen_at?: string | null;
  nodes_report_requested_at?: string | null;
  created_at: string;
  updated_at: string;
};

export type AgentRegisterResponse = {
  id: number;
  name: string;
  token: string;
  cluster_id?: number | null;
};
