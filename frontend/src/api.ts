import { appConfig } from "./config";
import {
  ClusterConfig,
  InspectionItem,
  InspectionRun,
  InspectionRunListItem,
} from "./types";

const API_BASE = appConfig.apiBaseUrl.replace(/\/$/, "");

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const isFormData = init?.body instanceof FormData;
  const headers: HeadersInit = {
    Accept: "application/json",
  };
  if (!isFormData) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...headers,
      ...(init?.headers || {}),
    },
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || "Request failed");
  }

  if (response.status === 204) {
    return {} as T;
  }

  return (await response.json()) as T;
}

export function getInspectionItems(): Promise<InspectionItem[]> {
  return request<InspectionItem[]>("/inspection-items");
}

export function createInspectionRun(
  itemIds: number[],
  clusterId: number,
  operator?: string
): Promise<InspectionRun> {
  return request<InspectionRun>("/inspection-runs", {
    method: "POST",
    body: JSON.stringify({ item_ids: itemIds, cluster_id: clusterId, operator }),
  });
}

export function getInspectionRuns(): Promise<InspectionRunListItem[]> {
  return request<InspectionRunListItem[]>("/inspection-runs");
}

export function getInspectionRun(runId: number): Promise<InspectionRun> {
  return request<InspectionRun>(`/inspection-runs/${runId}`);
}

export function getReportDownloadUrl(runId: number): string {
  return `${API_BASE}/inspection-runs/${runId}/report`;
}

export function getClusters(): Promise<ClusterConfig[]> {
  return request<ClusterConfig[]>("/clusters");
}

export function registerCluster(formData: FormData): Promise<ClusterConfig> {
  return request<ClusterConfig>("/clusters", {
    method: "POST",
    body: formData,
  });
}

export function updateCluster(
  clusterId: number,
  formData: FormData
): Promise<ClusterConfig> {
  return request<ClusterConfig>(`/clusters/${clusterId}`, {
    method: "PUT",
    body: formData,
  });
}

export function deleteCluster(clusterId: number): Promise<void> {
  return request<void>(`/clusters/${clusterId}`, {
    method: "DELETE",
  });
}

export function deleteInspectionRun(runId: number): Promise<void> {
  return request<void>(`/inspection-runs/${runId}`, {
    method: "DELETE",
  });
}
