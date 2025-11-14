export type InspectionItem = {
  id: number;
  name: string;
  description?: string;
  check_type: string;
  config?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

export type ExecutionMode = "server" | "agent";

export type ClusterConfig = {
  id: number;
  name: string;
  prometheus_url?: string | null;
  contexts: string[];
  connection_status: "connected" | "failed" | "warning" | "unknown";
  connection_message?: string | null;
  kubernetes_version?: string | null;
  node_count?: number | null;
  last_checked_at?: string | null;
  created_at: string;
  updated_at: string;
  execution_mode: ExecutionMode;
  default_agent_id?: number | null;
  default_agent_name?: string | null;
};

export type InspectionAgentStatus = "queued" | "running" | "finished" | "failed";

export type InspectionRunStatus =
  | "queued"
  | "running"
  | "finished"
  | "failed"
  | "cancelled";

export type InspectionResultStatus = "passed" | "warning" | "failed";

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
  created_at: string;
  completed_at?: string;
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
  created_at: string;
  completed_at?: string;
  executor: ExecutionMode;
  agent_status?: InspectionAgentStatus | null;
  agent_status_label?: string | null;
  agent_id?: number | null;
  agent_name?: string | null;
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
  created_at: string;
  updated_at: string;
};

export type AgentRegisterResponse = {
  id: number;
  name: string;
  token: string;
  cluster_id?: number | null;
};
