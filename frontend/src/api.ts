import { appConfig } from "./config";
import {
  ClusterConfig,
  InspectionItem,
  InspectionRun,
  InspectionRunListItem,
  InspectionItemsExportPayload,
  InspectionItemsImportResult,
  LicenseStatus,
} from "./types";

const API_BASE = appConfig.apiBaseUrl.replace(/\/$/, "");

interface RequestOptions {
  timeoutMs?: number;
}

async function request<T>(
  path: string,
  init?: RequestInit,
  options?: RequestOptions
): Promise<T> {
  const isFormData = init?.body instanceof FormData;
  const headers: HeadersInit = {
    Accept: "application/json",
  };
  if (!isFormData) {
    headers["Content-Type"] = "application/json";
  }

  const supportsAbort = typeof AbortController !== "undefined";
  const controller =
    supportsAbort && options?.timeoutMs ? new AbortController() : null;
  const timeoutId =
    controller && options?.timeoutMs
      ? globalThis.setTimeout(() => controller.abort(), options.timeoutMs)
      : null;

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: controller?.signal ?? init?.signal,
      headers: {
        ...headers,
        ...(init?.headers || {}),
      },
    });
  } catch (err) {
    if (
      controller &&
      err instanceof DOMException &&
      err.name === "AbortError"
    ) {
      throw new Error("请求超时，请稍后重试");
    }
    throw err;
  } finally {
    if (timeoutId !== null) {
      globalThis.clearTimeout(timeoutId);
    }
  }

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

export function exportInspectionItems(): Promise<InspectionItemsExportPayload> {
  return request<InspectionItemsExportPayload>("/inspection-items/export");
}

export function importInspectionItems(
  formData: FormData
): Promise<InspectionItemsImportResult> {
  return request<InspectionItemsImportResult>("/inspection-items/import", {
    method: "POST",
    body: formData,
  });
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

export function getReportDownloadUrl(
  runId: number,
  format: "pdf" | "md" = "pdf"
): string {
  const params = new URLSearchParams();
  if (format !== "pdf") {
    params.set("format", format);
  }
  const query = params.toString();
  return `${API_BASE}/inspection-runs/${runId}/report${
    query ? `?${query}` : ""
  }`;
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

export function deleteCluster(
  clusterId: number,
  options?: { deleteFiles?: boolean }
): Promise<void> {
  const params = new URLSearchParams();
  if (options?.deleteFiles) {
    params.set("delete_files", "true");
  }
  const query = params.toString();
  const url = query ? `/clusters/${clusterId}?${query}` : `/clusters/${clusterId}`;
  return request<void>(url, {
    method: "DELETE",
  });
}

export function testClusterConnection(clusterId: number): Promise<ClusterConfig> {
  return request<ClusterConfig>(
    `/clusters/${clusterId}/test-connection`,
    {
      method: "POST",
    },
    { timeoutMs: 10000 }
  );
}

export function createInspectionItem(payload: {
  name: string;
  description?: string;
  check_type: string;
  config?: Record<string, unknown>;
}): Promise<InspectionItem> {
  return request<InspectionItem>("/inspection-items", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateInspectionItem(
  itemId: number,
  payload: {
    name?: string;
    description?: string;
    check_type?: string;
    config?: Record<string, unknown> | null;
  }
): Promise<InspectionItem> {
  return request<InspectionItem>(`/inspection-items/${itemId}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function deleteInspectionItem(itemId: number): Promise<void> {
  return request<void>(`/inspection-items/${itemId}`, {
    method: "DELETE",
  });
}

export function deleteInspectionRun(
  runId: number,
  options?: { deleteFiles?: boolean }
): Promise<void> {
  const params = new URLSearchParams();
  if (options?.deleteFiles) {
    params.set("delete_files", "true");
  }
  const query = params.toString();
  const url = query ? `/inspection-runs/${runId}?${query}` : `/inspection-runs/${runId}`;
  return request<void>(url, {
    method: "DELETE",
  });
}

export function cancelInspectionRun(runId: number): Promise<InspectionRun> {
  return request<InspectionRun>(`/inspection-runs/${runId}/cancel`, {
    method: "POST",
  });
}

export function getLicenseStatus(): Promise<LicenseStatus> {
  return request<LicenseStatus>("/license/status");
}

export function uploadLicense(file: File): Promise<LicenseStatus> {
  const formData = new FormData();
  formData.append("file", file, file.name || "license.json");
  return request<LicenseStatus>("/license/upload", {
    method: "POST",
    body: formData,
  });
}
