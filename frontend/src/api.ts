import { appConfig } from "./config";
import {
  AgentRegisterResponse,
  ClusterConfig,
  ClusterNodesPayload,
  ClusterNodesRefreshPayload,
  InspectionAgent,
  InspectionItem,
  InspectionItemsExportPayload,
  InspectionItemsImportResult,
  InspectionRun,
  InspectionRunListItem,
  InspectionSchedule,
  LicenseStatus,
  AuthRole,
  AuthLoginChallenge,
  AuthUser,
} from "./types";

const API_BASE = appConfig.apiBaseUrl.replace(/\/$/, "");

interface RequestOptions {
  timeoutMs?: number;
}

function extractErrorMessage(raw: string, fallback: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return fallback;
  }
  try {
    const payload: unknown = JSON.parse(trimmed);
    if (typeof payload === "string") {
      return payload.trim() || fallback;
    }
    if (payload && typeof payload === "object") {
      const candidate =
        (payload as { detail?: unknown }).detail ??
        (payload as { message?: unknown }).message ??
        (payload as { error?: unknown }).error;
      if (typeof candidate === "string") {
        return candidate.trim() || fallback;
      }
      if (Array.isArray(candidate)) {
        const messages = candidate
          .map((item) => {
            if (typeof item === "string") {
              return item.trim();
            }
            if (item && typeof item === "object") {
              const detail =
                (item as { msg?: unknown; message?: unknown; detail?: unknown })
                  .msg ??
                (item as { message?: unknown }).message ??
                (item as { detail?: unknown }).detail;
              if (typeof detail === "string") {
                return detail.trim();
              }
            }
            return "";
          })
          .filter(Boolean);
        if (messages.length > 0) {
          return messages.join("; ");
        }
      }
    }
  } catch {
    // Keep original text when it is not JSON.
  }
  return trimmed;
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
      credentials: "include",
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
    const rawMessage = await response.text();
    const message = extractErrorMessage(
      rawMessage,
      response.statusText || "Request failed"
    );
    throw new Error(message);
  }

  if (response.status === 204) {
    return {} as T;
  }

  return (await response.json()) as T;
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.length % 2 === 0 ? hex : `0${hex}`;
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error("登录参数无效");
    }
    bytes[i] = byte;
  }
  return bytes;
}

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return globalThis.btoa(binary);
}

async function buildLoginProof(
  password: string,
  challenge: AuthLoginChallenge
): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = await globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const derivedBits = await globalThis.crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: hexToBytes(challenge.salt),
      iterations: challenge.iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    256
  );
  const hmacKey = await globalThis.crypto.subtle.importKey(
    "raw",
    derivedBits,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    hmacKey,
    encoder.encode(challenge.nonce)
  );
  return bufferToBase64(signature);
}

function supportsSecureLogin(): boolean {
  const secureContext =
    typeof globalThis.isSecureContext === "boolean"
      ? globalThis.isSecureContext
      : true;
  return Boolean(globalThis.crypto?.subtle) && secureContext;
}

export function getCurrentUser(): Promise<AuthUser> {
  return request<AuthUser>("/auth/me");
}

export async function login(
  username: string,
  password: string
): Promise<AuthUser> {
  if (supportsSecureLogin()) {
    const challenge = await request<AuthLoginChallenge>(
      "/auth/login-challenge",
      {
        method: "POST",
        body: JSON.stringify({ username }),
      }
    );
    const proof = await buildLoginProof(password, challenge);
    return request<AuthUser>("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username,
        nonce: challenge.nonce,
        proof,
        scheme: challenge.scheme,
      }),
    });
  }
  return request<AuthUser>("/auth/login", {
    method: "POST",
    body: JSON.stringify({
      username,
      password,
      scheme: "password",
    }),
  });
}

export function logout(): Promise<Record<string, string>> {
  return request<Record<string, string>>("/auth/logout", { method: "POST" });
}

export function changePassword(
  oldPassword: string,
  newPassword: string
): Promise<Record<string, string>> {
  return request<Record<string, string>>("/auth/password", {
    method: "POST",
    body: JSON.stringify({
      old_password: oldPassword,
      new_password: newPassword,
    }),
  });
}

export function getRoles(): Promise<AuthRole[]> {
  return request<AuthRole[]>("/roles");
}

export function createRole(payload: {
  name: string;
  display_name?: string;
  description?: string;
  permissions: string[];
}): Promise<AuthRole> {
  return request<AuthRole>("/roles", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateRole(
  roleId: number,
  payload: {
    display_name?: string;
    description?: string;
    permissions?: string[];
  }
): Promise<AuthRole> {
  return request<AuthRole>(`/roles/${roleId}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function deleteRole(roleId: number): Promise<void> {
  return request<void>(`/roles/${roleId}`, {
    method: "DELETE",
  });
}

export function getUsers(): Promise<AuthUser[]> {
  return request<AuthUser[]>("/users");
}

export function createUser(payload: {
  username: string;
  display_name?: string;
  password: string;
  roles: string[];
}): Promise<AuthUser> {
  return request<AuthUser>("/users", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateUser(
  userId: number,
  payload: {
    display_name?: string;
    password?: string;
    roles?: string[];
    is_active?: boolean;
  }
): Promise<AuthUser> {
  return request<AuthUser>(`/users/${userId}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function deleteUser(userId: number): Promise<void> {
  return request<void>(`/users/${userId}`, {
    method: "DELETE",
  });
}

export function getInspectionItems(): Promise<InspectionItem[]> {
  return request<InspectionItem[]>("/inspection-items");
}

export function exportInspectionItems(): Promise<InspectionItemsExportPayload> {
  return request<InspectionItemsExportPayload>("/inspection-items/export");
}

export async function exportInspectionItemsYaml(): Promise<string> {
  const response = await fetch(`${API_BASE}/inspection-items/export-yaml`, {
    headers: { Accept: "text/yaml" },
    credentials: "include",
  });
  if (!response.ok) {
    const rawMessage = await response.text();
    const errorMessage = extractErrorMessage(
      rawMessage,
      response.statusText || "Request failed"
    );
    throw new Error(errorMessage);
  }
  return response.text();
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
  operator?: string,
  prometheusVersion?: string
): Promise<InspectionRun> {
  return request<InspectionRun>("/inspection-runs", {
    method: "POST",
    body: JSON.stringify({
      item_ids: itemIds,
      cluster_id: clusterId,
      operator,
      prometheus_version: prometheusVersion,
    }),
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

export function getClusterNodes(
  clusterId: number
): Promise<ClusterNodesPayload> {
  return request<ClusterNodesPayload>(`/clusters/${clusterId}/nodes`);
}

export function refreshClusterNodes(
  clusterId: number
): Promise<ClusterNodesRefreshPayload> {
  return request<ClusterNodesRefreshPayload>(
    `/clusters/${clusterId}/nodes/refresh`,
    {
      method: "POST",
    }
  );
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
  prometheus_version?: string;
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
    prometheus_version?: string;
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

export function getInspectionSchedules(): Promise<InspectionSchedule[]> {
  return request<InspectionSchedule[]>("/inspection-schedules");
}

export function createInspectionSchedule(payload: {
  name?: string;
  cron: string;
  cluster_ids: number[];
  item_ids: number[];
  is_enabled?: boolean;
}): Promise<InspectionSchedule> {
  return request<InspectionSchedule>("/inspection-schedules", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateInspectionSchedule(
  scheduleId: number,
  payload: {
    name?: string | null;
    cron?: string;
    cluster_ids?: number[];
    item_ids?: number[];
    is_enabled?: boolean;
  }
): Promise<InspectionSchedule> {
  return request<InspectionSchedule>(`/inspection-schedules/${scheduleId}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function deleteInspectionSchedule(scheduleId: number): Promise<void> {
  return request<void>(`/inspection-schedules/${scheduleId}`, {
    method: "DELETE",
  });
}

export function getAgents(): Promise<InspectionAgent[]> {
  return request<InspectionAgent[]>("/agents");
}

export function createAgent(payload: {
  name: string;
  cluster_id?: number | null;
  description?: string;
  prometheus_url?: string | null;
}): Promise<AgentRegisterResponse> {
  return request<AgentRegisterResponse>("/agents", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateAgent(
  agentId: number,
  payload: {
    name?: string;
    description?: string;
    is_enabled?: boolean;
    cluster_id?: number | null;
    prometheus_url?: string | null;
  }
): Promise<InspectionAgent> {
  return request<InspectionAgent>(`/agents/${agentId}`, {
    method: "PUT",
    body: JSON.stringify(payload),
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

export function pauseInspectionRun(runId: number): Promise<InspectionRun> {
  return request<InspectionRun>(`/inspection-runs/${runId}/pause`, {
    method: "POST",
  });
}

export function resumeInspectionRun(runId: number): Promise<InspectionRun> {
  return request<InspectionRun>(`/inspection-runs/${runId}/resume`, {
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

export function uploadLicenseText(content: string): Promise<LicenseStatus> {
  return request<LicenseStatus>("/license/import-text", {
    method: "POST",
    body: JSON.stringify({ content }),
  });
}
