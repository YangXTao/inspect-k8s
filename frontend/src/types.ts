export type InspectionItem = {
  id: number;
  name: string;
  description?: string;
  check_type: string;
};

export type ClusterConfig = {
  id: number;
  name: string;
  prometheus_url?: string | null;
  contexts: string[];
  connection_status: "connected" | "failed" | "warning" | "unknown";
  connection_message?: string | null;
  last_checked_at?: string | null;
  created_at: string;
  updated_at: string;
};

export type InspectionResult = {
  id: number;
  item_id: number;
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
  status: "passed" | "warning" | "failed";
  summary?: string;
  report_path?: string;
  created_at: string;
  completed_at?: string;
  results: InspectionResult[];
};

export type InspectionRunListItem = {
  id: number;
  operator?: string;
  cluster_id: number;
  cluster_name: string;
  status: "passed" | "warning" | "failed";
  summary?: string;
  report_path?: string;
  created_at: string;
  completed_at?: string;
};
