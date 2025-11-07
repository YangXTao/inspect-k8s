export type InspectionItem = {
  id: number;
  name: string;
  description?: string;
  check_type: string;
  config?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

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
};

export type InspectionRunStatus =
  | "running"
  | "paused"
  | "cancelled"
  | "passed"
  | "warning"
  | "failed";

export type InspectionResult = {
  id: number;
  item_id: number | null;
  status: "passed" | "warning" | "failed";
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
  summary?: string;
  report_path?: string;
  total_items: number;
  processed_items: number;
  progress: number;
  created_at: string;
  completed_at?: string;
  results: InspectionResult[];
};

export type InspectionRunListItem = {
  id: number;
  operator?: string;
  cluster_id: number;
  cluster_name: string;
  status: InspectionRunStatus;
  summary?: string;
  report_path?: string;
  total_items: number;
  processed_items: number;
  progress: number;
  created_at: string;
  completed_at?: string;
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
