import {
  ChangeEvent,
  FormEvent,
  type RefObject,
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { Helmet } from "react-helmet";
import {
  cancelInspectionRun,
  createAgent as apiCreateAgent,
  createInspectionItem as apiCreateInspectionItem,
  createInspectionRun,
  deleteCluster as apiDeleteCluster,
  deleteInspectionItem as apiDeleteInspectionItem,
  deleteInspectionRun as apiDeleteInspectionRun,
  deleteInspectionRunsBulk as apiDeleteInspectionRunsBulk,
  deleteInspectionSchedule as apiDeleteInspectionSchedule,
  exportInspectionItems,
  exportInspectionItemsYaml,
  getAgents,
  getClusters,
  getClusterNodes,
  getInspectionItems,
  getInspectionRun,
  getInspectionRuns,
  getInspectionSchedules,
  getLicenseStatus,
  getRoles,
  getReportDownloadUrl,
  getCurrentUser,
  getAuditLogs,
  recordAuditLog,
  logout,
  changePassword,
  login,
  importInspectionItems,
  pauseInspectionRun,
  refreshClusterNodes,
  registerCluster,
  resumeInspectionRun,
  testClusterConnection,
  updateAgent as apiUpdateAgent,
  updateCluster,
  createInspectionSchedule as apiCreateInspectionSchedule,
  updateInspectionSchedule as apiUpdateInspectionSchedule,
  getOverviewSummary,
  getOverviewMetrics,
  uploadLicense,
  uploadLicenseText,
  updateInspectionItem as apiUpdateInspectionItem,
  createRole,
  updateRole,
  deleteRole,
  getUsers,
  createUser,
  updateUser,
  deleteUser,
} from "./api";
import { appConfig } from "./config";
import TopNavigation from "./components/TopNavigation";
import SettingsPage from "./components/SettingsPage";
import ConfirmationModal from "./ConfirmationModal";
import CompanyLogoUrl from "./assets/company-logo.png?url";
import type {
  AgentRegisterResponse,
  ClusterConfig,
  ExecutionMode,
  InspectionAgent,
  InspectionAgentStatus,
  InspectionItem,
  InspectionResult,
  InspectionResultStatus,
  InspectionRun,
  InspectionRunListItem,
  InspectionRunStatus,
  InspectionSchedule,
  LicenseStatus,
  AuthUser,
  AuthRole,
  AuditLog,
  OverviewSummary,
  OverviewMetrics,
} from "./types";

type NoticeType = "success" | "warning" | "error" | null;
import type {
  ConfirmDialogState,
  ConfirmDialogOption,
  SettingsModalTab,
  SettingsModalTabRenderContext,
} from "./types-ui";

type ConfirmVariant = "primary" | "danger";
type NoticeScope = "overview" | "clusterDetail" | "history" | "runDetail";
type GlobalNotice = {
  key: string;
  type: Exclude<NoticeType, null>;
  message: string;
};

const ERROR_AUTO_DISMISS_MS = 15000;

const useAutoClearError = (
  error: string | null,
  setError: (value: string | null) => void
) => {
  useEffect(() => {
    if (!error || typeof window === "undefined") {
      return;
    }
    const timeout = window.setTimeout(() => {
      setError(null);
    }, ERROR_AUTO_DISMISS_MS);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [error, setError]);
};

type LicenseCapabilities = {
  loading: boolean;
  valid: boolean;
  reason: string | null;
  features: string[];
  canManageClusters: boolean;
  canManageAgents: boolean;
  canRunInspections: boolean;
  canDownloadReports: boolean;
  status: LicenseStatus | null;
};

const CLUSTER_ID_STORAGE_KEY = "clusterDisplayIdMap.v1";
const CLUSTER_PAGE_SIZE_OPTIONS = [10, 20, 50];
const DEFAULT_CLUSTER_PAGE_SIZE = CLUSTER_PAGE_SIZE_OPTIONS[0];
const RUN_PAGE_SIZE_OPTIONS = [20, 50, 100] as const;
const AUDIT_PAGE_SIZE_OPTIONS = [20, 50, 100] as const;
const CLUSTER_ITEM_PAGE_SIZE_OPTIONS = [10, 20, 50] as const;
const RESULT_PAGE_SIZE_OPTIONS = [20, 50, 100] as const;
const SCHEDULE_REFRESH_INTERVAL = 15000;
const DEFAULT_PROMETHEUS_VERSION = "3.2";
const DEFAULT_PROMETHEUS_VERSION_OPTIONS = [
  "1.8",
  "2.55",
  ...Array.from({ length: 10 }, (_, index) => `3.${index}`),
];
const PROMETHEUS_VERSION_STORAGE_KEY = "prometheusVersionOptions.v1";
const DEFAULT_SCHEDULE_CRON = ["0", "0", "*", "*", "*"] as const;
type RolePermissionOption = {
  key: string;
  label: string;
};

type RolePermissionRow = {
  label: string;
  options: RolePermissionOption[];
};

type RolePermissionBlock = {
  title?: string;
  rows: RolePermissionRow[];
};

const ROLE_PERMISSION_BLOCKS: RolePermissionBlock[] = [
  {
    rows: [
      {
        label: "定时巡检",
        options: [
          { key: "schedule.read", label: "查看" },
          { key: "schedule.create", label: "新增" },
          { key: "schedule.update", label: "修改" },
          { key: "schedule.delete", label: "删除" },
        ],
      },
    ],
  },
  {
    rows: [
      {
        label: "历史巡检",
        options: [
          { key: "history.read", label: "查看" },
          { key: "history.create", label: "新增" },
          { key: "history.update", label: "修改" },
          { key: "history.delete", label: "删除" },
        ],
      },
    ],
  },
  {
    rows: [
      {
        label: "审计日志",
        options: [{ key: "audit.read", label: "查看" }],
      },
    ],
  },
  {
    title: "设置",
    rows: [
      {
        label: "License",
        options: [
          { key: "license.upload", label: "添加" },
          { key: "license.view", label: "查看" },
        ],
      },
      {
        label: "Prometheus 版本",
        options: [
          { key: "prometheus.create", label: "新增" },
          { key: "prometheus.update", label: "修改" },
          { key: "prometheus.delete", label: "删除" },
          { key: "prometheus.read", label: "查看" },
        ],
      },
      {
        label: "巡检项",
        options: [
          { key: "inspectionItem.create", label: "新增" },
          { key: "inspectionItem.update", label: "修改" },
          { key: "inspectionItem.delete", label: "删除" },
          { key: "inspectionItem.read", label: "查看" },
        ],
      },
      {
        label: "角色",
        options: [
          { key: "role.create", label: "新增" },
          { key: "role.update", label: "修改" },
          { key: "role.delete", label: "删除" },
          { key: "role.read", label: "查看" },
        ],
      },
      {
        label: "用户",
        options: [
          { key: "user.create", label: "新增" },
          { key: "user.update", label: "修改" },
          { key: "user.delete", label: "删除" },
          { key: "user.read", label: "查看" },
        ],
      },
    ],
  },
  {
    title: "集群",
    rows: [
      {
        label: "Agent/集群",
        options: [
          { key: "clusterAgent.create", label: "新增" },
          { key: "clusterAgent.update", label: "修改" },
          { key: "clusterAgent.test", label: "连接测试" },
          { key: "clusterAgent.delete", label: "删除" },
          { key: "clusterAgent.read", label: "查看" },
        ],
      },
      {
        label: "巡检记录",
        options: [
          { key: "runRecord.read", label: "查看" },
          { key: "runRecord.delete", label: "删除" },
        ],
      },
      {
        label: "巡检结果",
        options: [
          { key: "result.read", label: "查看" },
          { key: "result.delete", label: "删除" },
        ],
      },
      {
        label: "巡检报告",
        options: [
          { key: "report.read", label: "查看" },
          { key: "report.delete", label: "删除" },
        ],
      },
    ],
  },
];

const loadPrometheusVersionOptions = () => {
  if (typeof window === "undefined") {
    return DEFAULT_PROMETHEUS_VERSION_OPTIONS;
  }
  try {
    const raw = window.localStorage.getItem(PROMETHEUS_VERSION_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_PROMETHEUS_VERSION_OPTIONS;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return DEFAULT_PROMETHEUS_VERSION_OPTIONS;
    }
    const merged = [...DEFAULT_PROMETHEUS_VERSION_OPTIONS];
    const seen = new Set(merged);
    parsed.forEach((value) => {
      if (typeof value !== "string") {
        return;
      }
      const trimmed = value.trim();
      if (!trimmed || seen.has(trimmed)) {
        return;
      }
      seen.add(trimmed);
      merged.push(trimmed);
    });
    return merged;
  } catch {
    return DEFAULT_PROMETHEUS_VERSION_OPTIONS;
  }
};

const normalizePrometheusVersion = (
  value?: string | null,
  options: string[] = DEFAULT_PROMETHEUS_VERSION_OPTIONS
) => {
  if (!value) {
    return DEFAULT_PROMETHEUS_VERSION;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return DEFAULT_PROMETHEUS_VERSION;
  }
  if (options.includes(trimmed)) {
    return trimmed;
  }
  return trimmed;
};

const isLicenseRelatedMessage = (value?: string | null) => {
  if (!value) {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  const lower = trimmed.toLowerCase();

  return (
    lower.includes("license") ||
    trimmed.includes("授权") ||
    trimmed.includes("未生效") ||
    trimmed.includes("未安装")
  );
};

const isPromqlType = (value?: string | null) =>
  (value ?? "").trim() === "promql";

const isRancherLocalType = (value?: string | null) =>
  (value ?? "").trim() === "rancher_local";

const resolveClusterRancherLocal = (cluster?: ClusterConfig | null) =>
  Boolean(
    cluster && (cluster.isRancherLocal ?? cluster.is_rancher_local)
  );

const resolveClusterRancherUrl = (cluster?: ClusterConfig | null) =>
  cluster?.rancherUrl ?? cluster?.rancher_url ?? "";

const resolveClusterRancherApiKey = (cluster?: ClusterConfig | null) =>
  cluster?.rancherApiKey ?? cluster?.rancher_api_key ?? "";

const resolveClusterRancherVersion = (cluster?: ClusterConfig | null) =>
  cluster?.rancherVersion ?? cluster?.rancher_version ?? "";

const HISTORY_STATUS_OPTIONS: {
  value: InspectionRunStatus | "all";
  label: string;
}[] = [
  { value: "all", label: "全部" },
  { value: "queued", label: "排队中" },
  { value: "running", label: "执行中" },
  { value: "paused", label: "暂停中" },
  { value: "finished", label: "已完成" },
  { value: "failed", label: "已失败" },
  { value: "cancelled", label: "已取消" },
];
const AUDIT_ACTION_OPTIONS = [
  { value: "all", label: "全部" },
  { value: "query", label: "查询" },
  { value: "login", label: "登录" },
  { value: "logout", label: "退出" },
  { value: "create", label: "新增" },
  { value: "update", label: "修改" },
  { value: "delete", label: "删除" },
  { value: "download", label: "下载" },
];
const AUDIT_ENTITY_OPTIONS = [
  { value: "all", label: "全部对象" },
  { value: "auth_user", label: "用户" },
  { value: "cluster", label: "集群" },
  { value: "inspection_schedule", label: "定时巡检" },
  { value: "inspection_run", label: "巡检记录" },
  { value: "inspection_item", label: "巡检项" },
  { value: "prometheus_version", label: "Prometheus版本" },
];
const SETTINGS_BASE_PATH = "/setting";
const SETTINGS_TAB_IDS = [
  "overview",
  "inspection",
  "prometheus-version",
  "users",
  "license",
] as const;
const CONNECTION_TEST_OPERATOR = "__system_connection_test__";

const BEIJING_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const STATUS_CIRCLE_RADIUS = 18;
const STATUS_CIRCLE_CIRCUMFERENCE = 2 * Math.PI * STATUS_CIRCLE_RADIUS;
const CLUSTER_HEARTBEAT_REFRESH_INTERVAL = 30000;
const RUN_STATUS_POLL_INTERVAL = 800;
const RUN_STATUS_POLL_RETRY_INTERVAL = 1200;
const LICENSE_POLL_INTERVAL = 60000;

const clampProgress = (value?: number) => {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 100) {
    return 100;
  }
  return Math.round(value);
};

const parseNodesOutput = (output: string) => {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    return null;
  }
  const header = lines[0].trim();
  if (!header) {
    return null;
  }
  const columns = header
    .split(/\s{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (!columns.length) {
    return null;
  }
  const rows = lines.slice(1).map((line) => {
    const cells = line
      .trim()
      .split(/\s{2,}/)
      .map((item) => item.trim());
    if (cells.length < columns.length) {
      return [...cells, ...Array(columns.length - cells.length).fill("")];
    }
    return cells.slice(0, columns.length);
  });
  const externalIndex = columns.findIndex(
    (column) => column.trim().toUpperCase() === "EXTERNAL-IP"
  );
  if (externalIndex >= 0) {
    const isNoneValue = (value: string) => {
      const normalized = value.trim().toLowerCase();
      return (
        !normalized ||
        normalized === "<none>" ||
        normalized === "none" ||
        normalized === "-" ||
        normalized === "<unknown>"
      );
    };
    const shouldHide = rows.every((row) =>
      isNoneValue(row[externalIndex] || "")
    );
    if (shouldHide) {
      const filteredColumns = columns.filter(
        (_, index) => index !== externalIndex
      );
      const filteredRows = rows.map((row) =>
        row.filter((_, index) => index !== externalIndex)
      );
      return { columns: filteredColumns, rows: filteredRows };
    }
  }
  return { columns, rows };
};

const statusClass = (status: InspectionRunStatus) => {
  switch (status) {
    case "queued":
      return "status-pill queued";
    case "running":
      return "status-pill running";
    case "paused":
      return "status-pill paused";
    case "finished":
      return "status-pill success";
    case "failed":
      return "status-pill danger";
    case "cancelled":
      return "status-pill cancelled";
    default:
      return "status-pill";
  }
};

const renderRunStatusBadge = (
  status: InspectionRunStatus,
  statusLabel: string,
  progress?: number
) => {
  if (status === "running" || status === "paused") {
    const clamped = clampProgress(progress);
    const progressClassName =
      status === "paused"
        ? "status-progress status-progress-circle paused"
        : "status-progress status-progress-circle";
    return (
      <div className={progressClassName}>
        <div className="status-circle">
          <svg viewBox="0 0 40 40">
            <circle className="status-circle-bg" cx="20" cy="20" r={STATUS_CIRCLE_RADIUS} />
            <circle
              className="status-circle-value"
              cx="20"
              cy="20"
              r={STATUS_CIRCLE_RADIUS}
              strokeDasharray={STATUS_CIRCLE_CIRCUMFERENCE}
              strokeDashoffset={
                ((100 - clamped) / 100) * STATUS_CIRCLE_CIRCUMFERENCE
              }
            />
          </svg>
          <span className="status-circle-label">{clamped}%</span>
        </div>
        <span className={statusClass(status)}>{statusLabel}</span>
      </div>
    );
  }

  return <span className={statusClass(status)}>{statusLabel}</span>;
};

const formatDate = (value?: string | null) => {
  if (!value) {
    return "-";
  }

  let normalised = value.trim();
  const hasTimezoneSuffix = /([+-]\d\d:\d\d|[zZ])$/.test(normalised);
  if (!hasTimezoneSuffix) {
    normalised = normalised.replace(" ", "T");
    normalised = `${normalised}Z`;
  }

  const parsed = new Date(normalised);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return BEIJING_TIME_FORMATTER.format(parsed);
};

const resolveAuditActionLabel = (action?: string | null) => {
  const normalized = (action ?? "").trim();
  if (!normalized) {
    return "-";
  }
  const mapping = new Map(
    AUDIT_ACTION_OPTIONS.filter((option) => option.value !== "all").map(
      (option) => [option.value, option.label]
    )
  );
  return mapping.get(normalized) ?? normalized;
};

const resolveAuditEntityLabel = (entityType?: string | null) => {
  const normalized = (entityType ?? "").trim();
  if (!normalized) {
    return "-";
  }
  const mapping = new Map(
    AUDIT_ENTITY_OPTIONS.filter((option) => option.value !== "all").map(
      (option) => [option.value, option.label]
    )
  );
  mapping.set("cluster_config", "集群");
  mapping.set("inspection_agent", "集群");
  mapping.set("auth_role", "角色");
  mapping.set("inspection_result", "巡检结果");
  mapping.set("audit_log", "审计日志");
  mapping.set("report", "巡检记录");
  mapping.set("overview", "首页");
  mapping.set("setting", "设置");
  mapping.set("license", "License");
  return mapping.get(normalized) ?? "其他";
};

const parseDateValue = (value?: string | null) => {
  if (!value) {
    return null;
  }

  let normalised = value.trim();
  if (!normalised) {
    return null;
  }

  const hasTimezoneSuffix = /([+-]\d\d:\d\d|[zZ])$/.test(normalised);
  if (!hasTimezoneSuffix) {
    normalised = normalised.replace(" ", "T");
    normalised = `${normalised}Z`;
  }

  const parsed = new Date(normalised);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
};

const describeExecutor = (
  executor: ExecutionMode,
  agentName?: string | null,
  agentId?: number | null
) => {
  if (executor === "server") {
    return "Agent 执行";
  }
  const trimmedName = agentName?.trim();
  if (trimmedName) {
    return `Agent · ${trimmedName}`;
  }
  if (typeof agentId === "number") {
    return `Agent #${agentId}`;
  }
  return "Agent";
};

const describeAgentStatus = (
  status?: InspectionAgentStatus | null,
  label?: string | null
) => {
  if (label && label.trim()) {
    return label.trim();
  }
  switch (status) {
    case "queued":
      return "待执行";
    case "running":
      return "执行中";
    case "paused":
      return "暂停中";
    case "finished":
      return "已完成";
    case "failed":
      return "执行失败";
    default:
      return "-";
  }
};

const agentStatusClassName = (status?: InspectionAgentStatus | null) => {
  switch (status) {
    case "queued":
      return "status-pill warning";
    case "running":
      return "status-pill running";
    case "paused":
      return "status-pill paused";
    case "finished":
      return "status-pill success";
    case "failed":
      return "status-pill danger";
    default:
      return "status-pill";
  }
};

const clusterStatusMeta = {
  connected: { label: "连接正常", className: "connected" },
  failed: { label: "连接失败", className: "failed" },
  warning: { label: "待校验", className: "warning" },
  unknown: { label: "未校验", className: "unknown" },
  pending: { label: "待注册", className: "pending" },
} as const;

type ClusterConnectionStatus = "connected" | "failed" | "warning" | "unknown" | "pending";

const getClusterStatusMeta = (status: string) =>
  clusterStatusMeta[status as keyof typeof clusterStatusMeta] ||
  clusterStatusMeta.unknown;

const resolveNoticeScope = (pathname: string): NoticeScope => {
  if (pathname.startsWith("/history")) {
    return "history";
  }
  if (pathname.startsWith("/clusters/")) {
    return pathname.includes("/runs/") ? "runDetail" : "clusterDetail";
  }
  return "overview";
};

const CLUSTER_SLUG_PREFIX = "C-";

const hasChineseCharacter = (value: string) =>
  /[\u3400-\u9FFF\uF900-\uFAFF]/.test(value);

const compareInspectionItemByName = (
  a: InspectionItem,
  b: InspectionItem
) => {
  const nameA = (a.name ?? "").trim();
  const nameB = (b.name ?? "").trim();
  const aHasChinese = hasChineseCharacter(nameA);
  const bHasChinese = hasChineseCharacter(nameB);

  if (aHasChinese !== bHasChinese) {
    return aHasChinese ? 1 : -1;
  }

  const localeResult = nameA.localeCompare(nameB, "zh-Hans-CN", {
    sensitivity: "base",
    numeric: true,
  });
  if (localeResult !== 0) {
    return localeResult;
  }

  return (a.id ?? 0) - (b.id ?? 0);
};

const hashString = (value: string) => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36).toUpperCase();
};

const createDeterministicClusterSlug = (cluster: ClusterConfig) => {
  const hash = hashString(`${cluster.id}:${cluster.name || ""}`);
  const randomSegment = hash.slice(-4).padStart(4, "0");
  return `${CLUSTER_SLUG_PREFIX}${randomSegment}`;
};

const decodeClusterKeyToId = (
  clusterKey: string,
  displayMap: Record<number, string>,
  clusters: ClusterConfig[]
): number | null => {
  const mappedEntry = Object.entries(displayMap).find(
    ([, value]) => value === clusterKey
  );
  if (mappedEntry) {
    return Number(mappedEntry[0]);
  }

  const match = /^C-([A-Z0-9]+)(?:-[A-Z0-9]+)?$/i.exec(clusterKey);
  if (!match) {
    return null;
  }

  const candidate = parseInt(match[1], 36);
  if (Number.isNaN(candidate)) {
    return null;
  }

  if (
    displayMap[candidate] ||
    clusters.some((cluster) => cluster.id === candidate)
  ) {
    return candidate;
  }

  return candidate;
};

const loadStoredClusterDisplayIds = (): Record<number, string> => {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(CLUSTER_ID_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, string>;
    const result: Record<number, string> = {};
    Object.entries(parsed).forEach(([key, value]) => {
      const numericKey = Number(key);
      if (Number.isInteger(numericKey) && typeof value === "string") {
        result[numericKey] = value;
      }
    });
    return result;
  } catch {
    return {};
  }
};

const persistClusterDisplayIds = (map: Record<number, string>) => {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      CLUSTER_ID_STORAGE_KEY,
      JSON.stringify(map)
    );
  } catch {
    // ignore storage failure
  }
};

const getClusterDisplayId = (
  map: Record<number, string>,
  clusterId: number,
  cluster?: ClusterConfig
) =>
  map[clusterId] ??
  (cluster ? createDeterministicClusterSlug(cluster) : `cluster-${clusterId}`);

const normaliseClusterName = (name: string) =>
  name.trim().replace(/\s+/g, "-").toLowerCase() || "cluster";

const ARCHIVED_CLUSTER_SUFFIX_PATTERN = /\s*\(已归档-(\d+)\)\s*$/;
const DELETED_CLUSTER_SUFFIX_PATTERN = /\s*\(已删除-(\d+)\)\s*$/;

const resolveArchivedClusterName = (name?: string | null) => {
  const raw = (name ?? "").trim();
  if (!raw) {
    return { baseName: "cluster", archived: false };
  }
  if (ARCHIVED_CLUSTER_SUFFIX_PATTERN.test(raw)) {
    return {
      baseName: raw.replace(ARCHIVED_CLUSTER_SUFFIX_PATTERN, "").trim() || raw,
      archived: true,
    };
  }
  if (DELETED_CLUSTER_SUFFIX_PATTERN.test(raw)) {
    return {
      baseName: raw.replace(DELETED_CLUSTER_SUFFIX_PATTERN, "").trim() || raw,
      archived: true,
    };
  }
  return { baseName: raw, archived: false };
};

const createRunDisplayIdMap = (
  runs: InspectionRunListItem[],
  clusters: ClusterConfig[]
): Record<number, string> => {
  if (runs.length === 0) {
    return {};
  }

  const clusterNameMap = new Map<number, string>();
  clusters.forEach((cluster) => {
    clusterNameMap.set(cluster.id, cluster.name);
  });

  const grouped = new Map<number, InspectionRunListItem[]>();
  runs.forEach((run) => {
    const list = grouped.get(run.cluster_id) ?? [];
    list.push(run);
    grouped.set(run.cluster_id, list);
  });

  const displayIds: Record<number, string> = {};
  grouped.forEach((clusterRuns, clusterId) => {
    clusterRuns
      .slice()
      .sort((a, b) => {
        const timeA = a.created_at ? new Date(a.created_at).getTime() : 0;
        const timeB = b.created_at ? new Date(b.created_at).getTime() : 0;
        if (timeA === timeB) {
          return a.id - b.id;
        }
        return timeA - timeB;
      })
      .forEach((run, index) => {
        const clusterName =
          clusterNameMap.get(clusterId) ??
          run.cluster_name ??
          `cluster-${clusterId}`;
        const slug = normaliseClusterName(clusterName);
        displayIds[run.id] = `${slug}-${String(index + 1).padStart(2, "0")}`;
      });
  });

  return displayIds;
};

const resolveClusterIdFromRouteKey = (
  clusterKey: string | undefined,
  displayMap: Record<number, string>,
  clusters: ClusterConfig[]
): number | null => {
  if (!clusterKey || !clusterKey.trim()) {
    return null;
  }
  const decoded = decodeClusterKeyToId(clusterKey, displayMap, clusters);
  if (decoded !== null) {
    return decoded;
  }
  if (clusterKey.startsWith("#")) {
    const numeric = Number(clusterKey.slice(1));
    return Number.isInteger(numeric) ? numeric : null;
  }
  if (/^\d+$/.test(clusterKey)) {
    return Number(clusterKey);
  }
  return null;
};

const decodeRunKeyToId = (
  runKey: string | undefined,
  displayMap: Record<number, string>
): number | null => {
  if (!runKey || !runKey.trim()) {
    return null;
  }
  const trimmed = runKey.trim();
  const lower = trimmed.toLowerCase();
  const matchedEntry = Object.entries(displayMap).find(
    ([, value]) => value.toLowerCase() === lower
  );
  if (matchedEntry) {
    return Number(matchedEntry[0]);
  }
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  if (trimmed.startsWith("#")) {
    const numeric = Number(trimmed.slice(1));
    return Number.isInteger(numeric) ? numeric : null;
  }
  return null;
};

const inspectionResultStatusMeta = {
  passed: { label: "通过", className: "success" },
  warning: { label: "警告", className: "warning" },
  critical: { label: "严重", className: "critical" },
  failed: { label: "失败", className: "danger" },
} as const;

const getInspectionResultStatusMeta = (status: InspectionResultStatus) =>
  inspectionResultStatusMeta[status as keyof typeof inspectionResultStatusMeta] ??
  inspectionResultStatusMeta.failed;

const extractPercentageValue = (value?: string | null) => {
  if (!value) {
    return null;
  }
  const percentMatch = /(\d+(?:\.\d+)?)\s*%/.exec(value);
  if (percentMatch) {
    const parsed = Number(percentMatch[1]);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const labeledMatch =
    /(?:sample|value|avg|平均|样本|指标)\s*[:：]?\s*([0-9]+(?:\.\d+)?)/i.exec(
      value
    );
  if (labeledMatch) {
    const parsed = Number(labeledMatch[1]);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const numberMatch = /([0-9]+(?:\.\d+)?)/.exec(value);
  if (!numberMatch) {
    return null;
  }
  const parsed = Number(numberMatch[1]);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalize = (value: string) =>
  value.toLowerCase().replace(/[\s._-]+/g, "");

const findResultByKeywords = (
  results: InspectionResult[],
  keywords: string[]
) => {
  if (!results.length) {
    return null;
  }
  const lowered = keywords.map((keyword) => keyword.toLowerCase());
  const normalizedKeywords = keywords.map((keyword) => normalize(keyword));
  return (
    results.find((result) => {
      const name = (result.item_name ?? "").toLowerCase();
      const normalizedName = normalize(name);
      const detail = (result.detail ?? "").toLowerCase();
      const normalizedDetail = normalize(detail);
      const suggestion = (result.suggestion ?? "").toLowerCase();
      const normalizedSuggestion = normalize(suggestion);
      return lowered.some((keyword, index) => {
        if (name.includes(keyword)) {
          return true;
        }
        return normalizedName.includes(normalizedKeywords[index]);
      }) || lowered.some((keyword, index) => {
        if (detail.includes(keyword) || suggestion.includes(keyword)) {
          return true;
        }
        return (
          normalizedDetail.includes(normalizedKeywords[index]) ||
          normalizedSuggestion.includes(normalizedKeywords[index])
        );
      });
    }) ?? null
  );
};

const findResultByNameKeywords = (
  results: InspectionResult[],
  keywords: string[]
) => {
  if (!results.length) {
    return null;
  }
  const lowered = keywords.map((keyword) => keyword.toLowerCase());
  const normalizedKeywords = lowered.map((keyword) => normalize(keyword));
  return (
    results.find((result) => {
      const name = (result.item_name ?? "").toLowerCase();
      const normalizedName = normalize(name);
      return lowered.some((keyword, index) => {
        if (name.includes(keyword)) {
          return true;
        }
        return normalizedName.includes(normalizedKeywords[index]);
      });
    }) ?? null
  );
};

const OVERVIEW_INDICATORS = [
  {
    key: "connection",
    label: "连接状态",
    keywords: ["connection probe", "连接探测", "连接状态"],
  },
  {
    key: "nodes",
    label: "节点状态",
    keywords: ["node health", "nodes status", "节点状态", "节点健康"],
  },
  {
    key: "etcd",
    label: "etcd 状态",
    keywords: ["etcd", "etcd status", "etcd 健康", "etcd health"],
  },
  {
    key: "apiserver",
    label: "apiserver 状态",
    keywords: ["apiserver", "api server", "api server availability"],
  },
  {
    key: "controller-manager",
    label: "controller-manager 状态",
    keywords: [
      "controller manager",
      "controller-manager",
      "controller manager status",
      "检查controller manager",
      "检查controller-manager",
    ],
  },
  {
    key: "scheduler",
    label: "scheduler 状态",
    keywords: ["scheduler", "scheduler status", "检查scheduler"],
  },
  {
    key: "cpu",
    label: "集群 CPU 使用率",
    keywords: ["cluster cpu usage", "cluster cpu", "集群cpu"],
  },
  {
    key: "memory",
    label: "集群内存使用率",
    keywords: ["cluster memory usage", "cluster memory", "集群内存"],
  },
  {
    key: "cert-expiry",
    label: "证书过期时间",
    keywords: ["k8s 证书过期时间检查", "证书过期时间", "证书过期"],
  },
] as const;

const OVERVIEW_INDICATOR_FALLBACK_RUNS = 3;

interface DashboardOverviewProps {
  clusters: ClusterConfig[];
  runs: InspectionRunListItem[];
  clusterDisplayIds: Record<number, string>;
  runDisplayIds: Record<number, string>;
  canViewHistory: boolean;
  overviewSummary: OverviewSummary | null;
  overviewMetrics: OverviewMetrics | null;
  suppressDetailLoading?: boolean;
}

const DashboardOverviewView = ({
  clusters,
  runs,
  clusterDisplayIds,
  runDisplayIds,
  canViewHistory,
  overviewSummary,
  overviewMetrics,
  suppressDetailLoading,
}: DashboardOverviewProps) => {
  const chartWrapperRef = useRef<HTMLDivElement | null>(null);
  const [hoverState, setHoverState] = useState(() => ({
    cpu: {
      index: null as number | null,
      point: null as { x: number; y: number } | null,
      lineX: null as number | null,
      lineY: null as number | null,
      align: "right" as "right" | "left",
    },
    memory: {
      index: null as number | null,
      point: null as { x: number; y: number } | null,
      lineX: null as number | null,
      lineY: null as number | null,
      align: "right" as "right" | "left",
    },
  }));
  const [runDetails, setRunDetails] = useState<Record<number, InspectionRun>>(
    {}
  );
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const latestRuns = useMemo(() => {
    const map = new Map<number, InspectionRunListItem>();
    runs.forEach((run) => {
      const time = new Date(run.completed_at ?? run.created_at).getTime();
      const existing = map.get(run.cluster_id);
      if (!existing) {
        map.set(run.cluster_id, run);
        return;
      }
      const existingTime = new Date(
        existing.completed_at ?? existing.created_at
      ).getTime();
      if (time >= existingTime) {
        map.set(run.cluster_id, run);
      }
    });
    return Array.from(map.values());
  }, [runs]);

  const latestRunByCluster = useMemo(() => {
    const map = new Map<number, InspectionRunListItem>();
    latestRuns.forEach((run) => map.set(run.cluster_id, run));
    return map;
  }, [latestRuns]);

  const recentRunsByCluster = useMemo(() => {
    const map = new Map<number, InspectionRunListItem[]>();
    runs.forEach((run) => {
      const list = map.get(run.cluster_id) ?? [];
      list.push(run);
      map.set(run.cluster_id, list);
    });
    map.forEach((list, clusterId) => {
      list.sort((a, b) => {
        const timeA = new Date(a.completed_at ?? a.created_at).getTime();
        const timeB = new Date(b.completed_at ?? b.created_at).getTime();
        return timeB - timeA;
      });
      map.set(
        clusterId,
        list.slice(0, OVERVIEW_INDICATOR_FALLBACK_RUNS)
      );
    });
    return map;
  }, [runs]);

  useEffect(() => {
    const targetIds: number[] = [];
    recentRunsByCluster.forEach((list) => {
      list.forEach((run) => {
        if (!runDetails[run.id]) {
          targetIds.push(run.id);
        }
      });
    });
    if (targetIds.length === 0) {
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    void Promise.allSettled(
      targetIds.map((runId) =>
        getInspectionRun(runId).then((run) => ({ runId, run }))
      )
    )
      .then((results) => {
        if (cancelled) {
          return;
        }
        setRunDetails((prev) => {
          const next = { ...prev };
          results.forEach((result) => {
            if (result.status === "fulfilled") {
              next[result.value.runId] = result.value.run;
            }
          });
          return next;
        });
        const hasFailure = results.some((result) => result.status === "rejected");
        if (!hasFailure) {
          setDetailError(null);
        } else {
          setDetailError("部分巡检详情加载失败，请稍后刷新。");
        }
      })
      .catch((err) => {
        if (!cancelled) {
          const message =
            err instanceof Error ? err.message : "加载巡检详情失败";
          setDetailError(message);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setDetailLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [recentRunsByCluster, runDetails]);

  const clusterCountLabel = useMemo(() => {
    if (!overviewSummary) {
      return "-";
    }
    const total = overviewSummary.cluster_total;
    const online = overviewSummary.cluster_online;
    if (typeof total !== "number" || typeof online !== "number") {
      return "-";
    }
    return `${online}/${total}`;
  }, [overviewSummary]);

  const nodeCountLabel = useMemo(() => {
    if (!overviewSummary) {
      return "-";
    }
    const total = overviewSummary.node_total;
    const ready = overviewSummary.node_ready;
    if (typeof total !== "number" || typeof ready !== "number") {
      return "-";
    }
    const normalizedReady = Math.min(Math.max(ready, 0), total);
    return `${normalizedReady}/${total}`;
  }, [overviewSummary]);

  const podCountLabel = useMemo(() => {
    const total = overviewSummary?.pod_total;
    return typeof total === "number" ? String(total) : "-";
  }, [overviewSummary]);

  const chartColors = useMemo(
    () => [
      "#2563eb",
      "#22c55e",
      "#f97316",
      "#ec4899",
      "#8b5cf6",
      "#0ea5e9",
      "#10b981",
      "#eab308",
    ],
    []
  );

  const pickColorDeterministic = useCallback(
    (clusterId: number): string => {
      // 稳定哈希，避免因序列顺序变化导致颜色抖动
      let hash = clusterId;
      hash = (hash ^ (hash << 13)) >>> 0;
      hash = (hash ^ (hash >> 17)) >>> 0;
      hash = (hash ^ (hash << 5)) >>> 0;
      const index = hash % chartColors.length;
      return chartColors[index];
    },
    [chartColors]
  );
  const [clusterColorMap, setClusterColorMap] = useState<
    Record<number, string>
  >({});
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      const raw = window.localStorage.getItem("cluster_chart_colors");
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        setClusterColorMap(parsed as Record<number, string>);
      }
    } catch {
      // ignore malformed cache
    }
  }, []);
  useEffect(() => {
    if (!overviewMetrics) {
      return;
    }
    setClusterColorMap((prev) => {
      const next: Record<number, string> = { ...prev };
      const existingIds = new Set(clusters.map((cluster) => cluster.id));
      Object.keys(next).forEach((key) => {
        const numericKey = Number(key);
        if (!existingIds.has(numericKey)) {
          delete next[numericKey];
        }
      });
      const assignColor = (clusterId: number) => {
        if (!next[clusterId]) {
          next[clusterId] = pickColorDeterministic(clusterId);
        }
      };
      overviewMetrics.series.forEach((series) => {
        assignColor(series.cluster_id);
      });
      const changed =
        Object.keys(prev).length !== Object.keys(next).length ||
        Object.keys(next).some((key) => prev[Number(key)] !== next[Number(key)]);
      if (changed && typeof window !== "undefined") {
        try {
          window.localStorage.setItem(
            "cluster_chart_colors",
            JSON.stringify(next)
          );
        } catch {
          // ignore write errors
        }
      }
      return changed ? next : prev;
    });
  }, [overviewMetrics, clusters, chartColors]);

  const intervalSeconds = useMemo(() => {
    if (!overviewMetrics) {
      return 0;
    }
    if (
      typeof overviewMetrics.interval_seconds === "number" &&
      Number.isFinite(overviewMetrics.interval_seconds) &&
      overviewMetrics.interval_seconds > 0
    ) {
      return overviewMetrics.interval_seconds;
    }
    const minutes = overviewMetrics.interval_minutes || 20;
    return Math.max(1, minutes * 60);
  }, [overviewMetrics]);

  const timeline = useMemo(() => {
    if (!overviewMetrics) {
      return [];
    }
    const start = parseDateValue(overviewMetrics.start);
    const end = parseDateValue(overviewMetrics.end);
    if (!start || !end || intervalSeconds <= 0) {
      return [];
    }
    const points: Date[] = [];
    let cursor = new Date(start.getTime());
    while (cursor <= end) {
      points.push(new Date(cursor.getTime()));
      cursor = new Date(cursor.getTime() + intervalSeconds * 1000);
    }
    return points;
  }, [overviewMetrics, intervalSeconds]);

  const formatChartTime = (date: Date) =>
    date.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    });

  const formatTooltipTime = (date: Date) =>
    date.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

  const buildLineSeries = useCallback(
    (metric: "cpu" | "memory") => {
      if (!overviewMetrics || timeline.length === 0) {
        return [];
      }
      const interval = intervalSeconds || 1;
      const toBucketKey = (value: Date) =>
        Math.floor(value.getTime() / 1000 / interval) * interval;
      const timelineKeys = timeline.map((date) => toBucketKey(date));
      return overviewMetrics.series.map((series, index) => {
        const valueMap = new Map<number, number>();
        series.points.forEach((point) => {
          const parsed = parseDateValue(point.reported_at);
          if (!parsed) {
            return;
          }
          const key = toBucketKey(parsed);
          const value =
            metric === "cpu" ? point.cpu_usage : point.memory_usage;
          if (typeof value === "number" && Number.isFinite(value)) {
            valueMap.set(key, value);
          }
        });
        const values = timelineKeys.map((key) => {
          const value = valueMap.get(key);
          return typeof value === "number" ? value : null;
        });
        const color =
          clusterColorMap[series.cluster_id] ??
          chartColors[index % chartColors.length];
        return {
          name: series.cluster_name,
          values,
          color,
        };
      });
    },
    [overviewMetrics, timeline, intervalSeconds, chartColors, clusterColorMap]
  );

  const renderLineChart = (metric: "cpu" | "memory") => {
    if (!overviewMetrics || timeline.length === 0) {
      return <div className="placeholder">暂无数据</div>;
    }
    const series = buildLineSeries(metric);
    if (series.length === 0) {
      return <div className="placeholder">暂无数据</div>;
    }
    const currentHover = hoverState[metric];
    const otherMetric: "cpu" | "memory" = metric === "cpu" ? "memory" : "cpu";
    const width = 640;
    const height = 240;
    const padding = { left: 30, right: 12, top: 12, bottom: 34 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const maxIndex = Math.max(timeline.length - 1, 1);
    const hasAnyValue = series.some((entry) =>
      entry.values.some(
        (value) => typeof value === "number" && Number.isFinite(value)
      )
    );
    const resolveNearestValueIndex = (
      values: Array<number | null>,
      target: number
    ) => {
      if (target < 0 || target > maxIndex) {
        return null;
      }
      const current = values[target];
      if (typeof current === "number" && Number.isFinite(current)) {
        return target;
      }
      for (let offset = 1; offset <= maxIndex; offset += 1) {
        const left = target - offset;
        if (left >= 0) {
          const value = values[left];
          if (typeof value === "number" && Number.isFinite(value)) {
            return left;
          }
        }
        const right = target + offset;
        if (right <= maxIndex) {
          const value = values[right];
          if (typeof value === "number" && Number.isFinite(value)) {
            return right;
          }
        }
      }
      return null;
    };
    const labelIntervalSeconds = 10 * 60;
    const labelBase =
      timeline.length > 0
        ? new Date(
            Math.floor(
              timeline[0].getTime() / 1000 / labelIntervalSeconds
            ) *
              labelIntervalSeconds *
              1000
          )
        : null;
    const toX = (index: number) =>
      padding.left + (index / maxIndex) * plotWidth;
    const toY = (value: number) =>
      padding.top + (1 - value / 100) * plotHeight;
    const buildPath = (values: Array<number | null>) => {
      let path = "";
      values.forEach((value, index) => {
        if (value === null || Number.isNaN(value)) {
          return;
        }
        const x = toX(index);
        const y = toY(Math.min(Math.max(value, 0), 100));
        path = path ? `${path} L ${x} ${y}` : `M ${x} ${y}`;
      });
      return path;
    };
    const handleMouseMove = (event: React.MouseEvent<SVGSVGElement>) => {
      const svg = event.currentTarget;
      const rect = svg.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const point = svg.createSVGPoint();
      point.x = event.clientX;
      point.y = event.clientY;
      const ctm = svg.getScreenCTM();
      if (!ctm) {
        return;
      }
      const svgPoint = point.matrixTransform(ctm.inverse());
      const xSvg = svgPoint.x;
      const ySvg = svgPoint.y;
      if (xSvg < padding.left || xSvg > width - padding.right) {
        setHoverState((prev) => ({
          ...prev,
          [metric]: { ...prev[metric], index: null, point: null, lineX: null, lineY: null },
        }));
        return;
      }
      if (!hasAnyValue) {
        setHoverState((prev) => ({
          ...prev,
          [metric]: { ...prev[metric], index: null, point: null, lineX: null, lineY: null },
        }));
        return;
      }
      const rawIndex =
        ((xSvg - padding.left) / plotWidth) * maxIndex;
      const clamped = Math.min(Math.max(Math.round(rawIndex), 0), maxIndex);
      const align = x > rect.width * 0.72 ? "left" : "right";
      const tooltipX =
        align === "left"
          ? Math.max(0, Math.min(rect.width, x - 12))
          : Math.max(0, Math.min(rect.width, x + 12));
      const tooltipY = Math.max(0, Math.min(rect.height, y + 12));
      const lineY = Math.min(
        Math.max(ySvg, padding.top),
        height - padding.bottom
      );
      const lineX = Math.min(
        Math.max(xSvg, padding.left),
        width - padding.right
      );
      setHoverState((prev) => ({
        ...prev,
        [metric]: {
          index: clamped,
          point: { x: tooltipX, y: tooltipY },
          lineY,
          lineX,
          align,
        },
        [otherMetric]: { ...prev[otherMetric], index: null, point: null, lineX: null, lineY: null },
      }));
    };

    const handleMouseLeave = () => {
      setHoverState((prev) => ({
        ...prev,
        [metric]: { ...prev[metric], index: null, point: null, lineX: null, lineY: null },
      }));
    };

    const tooltipLines =
      currentHover.index === null
        ? []
        : series
            .map((entry) => {
              const nearestIndex = resolveNearestValueIndex(
                entry.values,
                currentHover.index ?? 0
              );
              if (nearestIndex === null) {
                return null;
              }
              const value = entry.values[nearestIndex];
              if (typeof value !== "number" || !Number.isFinite(value)) {
                return null;
              }
              return {
                name: entry.name,
                value: `${value.toFixed(2)}%`,
                color: entry.color,
              };
            })
            .filter(Boolean) as Array<{
            name: string;
            value: string;
            color: string;
          }>;
    const highlightPoints =
      currentHover.index === null
        ? []
        : series
            .map((entry) => {
              const nearestIndex = resolveNearestValueIndex(
                entry.values,
                currentHover.index ?? 0
              );
              if (nearestIndex === null) {
                return null;
              }
              const value = entry.values[nearestIndex];
              if (typeof value !== "number" || !Number.isFinite(value)) {
                return null;
              }
              return {
                name: entry.name,
                x: toX(nearestIndex),
                y: toY(Math.min(Math.max(value, 0), 100)),
                color: entry.color,
              };
            })
            .filter(Boolean) as Array<{
            name: string;
            x: number;
            y: number;
            color: string;
          }>;

    return (
      <div className="overview-line-chart" ref={chartWrapperRef}>
        <div className="overview-line-canvas">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="overview-line-svg"
            preserveAspectRatio="none"
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
          >
            {[0, 50, 100].map((tick) => {
              const y = toY(tick);
              return (
                <g key={`y-${tick}`}>
                  <line
                    x1={padding.left}
                    x2={width - padding.right}
                    y1={y}
                    y2={y}
                    className="overview-line-grid"
                  />
                  <text
                    x={2}
                    y={y + 4}
                    textAnchor="start"
                    className="overview-line-axis-label"
                  >
                    {tick}%
                  </text>
                </g>
              );
            })}
            {series.map((entry) => (
              <path
                key={entry.name}
                d={buildPath(entry.values)}
                className="overview-line-path"
                stroke={entry.color}
              />
            ))}
            {currentHover.lineX !== null && (
              <line
                x1={currentHover.lineX}
                x2={currentHover.lineX}
                y1={padding.top}
                y2={height - padding.bottom}
                className="overview-line-hover"
              />
            )}
            {currentHover.lineY !== null && (
              <line
                x1={padding.left}
                x2={width - padding.right}
                y1={currentHover.lineY}
                y2={currentHover.lineY}
                className="overview-line-hover"
              />
            )}
            {highlightPoints.map((point) => (
              <circle
                key={`highlight-${point.name}`}
                cx={point.x}
                cy={point.y}
                r={4}
                fill="#ffffff"
                stroke={point.color}
                strokeWidth={2}
              />
            ))}
            {timeline.map((time, index) => {
              if (!labelBase) {
                return null;
              }
              const diffSeconds = Math.round(
                (time.getTime() - labelBase.getTime()) / 1000
              );
              if (diffSeconds < 0 || diffSeconds % labelIntervalSeconds !== 0) {
                return null;
              }
              const x = toX(index);
              return (
                <g key={`x-${index}`}>
                  <line
                    x1={x}
                    x2={x}
                    y1={padding.top}
                    y2={height - padding.bottom}
                    className="overview-line-grid overview-line-grid-x"
                  />
                  <text
                    x={x}
                    y={height - 10}
                    textAnchor="middle"
                    className="overview-line-axis-label"
                  >
                    {formatChartTime(time)}
                  </text>
                </g>
              );
            })}
          </svg>
          {currentHover.index !== null && currentHover.point && (
            <div
              className={`overview-line-tooltip ${
                currentHover.align === "left"
                  ? "overview-line-tooltip-left"
                  : "overview-line-tooltip-right"
              }`}
              style={{
                left: currentHover.point.x,
                top: currentHover.point.y,
              }}
            >
              <div className="overview-line-tooltip-time">
                {formatTooltipTime(timeline[currentHover.index])}
              </div>
              {tooltipLines.map((line) => (
                <div key={line.name} className="overview-line-tooltip-row">
                  <span
                    className="overview-line-legend-dot"
                    style={{ background: line.color }}
                  />
                  <span className="overview-line-tooltip-text">
                    {line.name}：{line.value}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="overview-line-legend">
          {series.map((entry) => (
            <div key={entry.name} className="overview-line-legend-item">
              <span
                className="overview-line-legend-dot"
                style={{ background: entry.color }}
              />
              <span>{entry.name}</span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const indicatorCards = useMemo(() => {
    return clusters.map((cluster) => {
      const latestRun = latestRunByCluster.get(cluster.id) ?? null;
      const findIndicatorResult = (
        indicator: (typeof OVERVIEW_INDICATORS)[number]
      ) => {
        const candidates = recentRunsByCluster.get(cluster.id) ?? [];
        for (const run of candidates) {
          const detail = runDetails[run.id];
          if (!detail) {
            continue;
          }
          const result = findResultByNameKeywords(
            detail.results,
            [...indicator.keywords]
          );
          if (result) {
            return result;
          }
        }
        return null;
      };
      const indicators = OVERVIEW_INDICATORS.map((indicator) => {
        if (indicator.key === "connection") {
          const connectionStatus = cluster.connection_status;
          if (connectionStatus === "connected") {
            return {
              key: indicator.key,
              label: indicator.label,
              status: null,
              statusLabel: "正常",
              statusClass: "success",
              statusIcon: "✓",
            };
          }
          return {
            key: indicator.key,
            label: indicator.label,
            status: null,
            statusLabel: "异常",
            statusClass: "danger",
            statusIcon: "✕",
          };
        }
        const result = findIndicatorResult(indicator);
        const status = result?.status ?? null;
        const isCertIndicator = indicator.key === "cert-expiry";
        const isCriticalCert = status === "critical" || status === "failed";
        const isPassed = status === "passed";
        return {
          key: indicator.key,
          label: indicator.label,
          status,
          statusLabel: status
            ? isCertIndicator
              ? isCriticalCert
                ? "异常"
                : "正常"
              : isPassed
                ? "正常"
                : "异常"
            : "-",
          statusClass: status
            ? isCertIndicator
              ? isCriticalCert
                ? "danger"
                : "success"
              : isPassed
                ? "success"
                : "danger"
            : "muted",
          statusIcon: status
            ? isCertIndicator
              ? isCriticalCert
                ? "✕"
                : "✓"
              : isPassed
                ? "✓"
                : "✕"
            : "·",
        };
      });
      const clusterSlug = getClusterDisplayId(
        clusterDisplayIds,
        cluster.id,
        cluster
      );
      const runSlug =
        latestRun && (runDisplayIds[latestRun.id] ?? `#${latestRun.id}`);
      const reportPath =
        latestRun && runSlug
          ? `/clusters/${clusterSlug}/runs/${runSlug}`
          : null;
      return {
        cluster,
        latestRun,
        indicators,
        reportPath: canViewHistory ? reportPath : null,
      };
    });
  }, [
    clusters,
    latestRunByCluster,
    recentRunsByCluster,
    runDetails,
    clusterDisplayIds,
    runDisplayIds,
    canViewHistory,
  ]);

  return (
    <div className="overview-dashboard">
      <section className="overview-metrics">
        <div className="overview-metric-card">
          <div className="overview-metric-title">集群在线/总数</div>
          <div className="overview-metric-value">{clusterCountLabel}</div>
        </div>
        <div className="overview-metric-card">
          <div className="overview-metric-title">节点就绪/总数</div>
          <div className="overview-metric-value">{nodeCountLabel}</div>
        </div>
        <div className="overview-metric-card">
          <div className="overview-metric-title">POD总数</div>
          <div className="overview-metric-value">{podCountLabel}</div>
        </div>
      </section>

      {detailError && (
        <div className="feedback warning overview-feedback">{detailError}</div>
      )}
      {detailLoading && false && (
        <div className="feedback info overview-feedback">正在加载巡检详情...</div>
      )}

      <section className="overview-charts">
        <div className="overview-chart-card">
          <div className="overview-chart-title">集群 CPU 使用率</div>
          {renderLineChart("cpu")}
        </div>
        <div className="overview-chart-card">
          <div className="overview-chart-title">集群内存使用率</div>
          {renderLineChart("memory")}
        </div>
      </section>

      <section className="overview-indicators">
        {indicatorCards.length === 0 ? (
          <div className="placeholder">暂无集群巡检结果</div>
        ) : (
          <div className="overview-indicator-grid">
            {indicatorCards.map((card) => (
              <div key={card.cluster.id} className="overview-indicator-card">
                <div className="overview-indicator-head">
                  <div className="overview-indicator-title">
                    {card.cluster.name}
                  </div>
                  <div className="overview-indicator-meta">
                    最新巡检：
                    {card.latestRun?.completed_at
                      ? formatDate(card.latestRun.completed_at)
                      : card.latestRun?.created_at
                        ? formatDate(card.latestRun.created_at)
                        : "暂无"}
                  </div>
                </div>
                <ul className="overview-indicator-list">
                  {card.indicators.map((item) => (
                    <li key={item.key} className="overview-indicator-item">
                      <span
                        className={`overview-indicator-status ${item.statusClass}`}
                      >
                        {item.statusIcon}
                      </span>
                      <span className="overview-indicator-label">
                        {item.label}
                      </span>
                      <span className="overview-indicator-value">
                        {item.statusLabel}
                      </span>
                    </li>
                  ))}
                </ul>
                {card.reportPath && (
                  <Link
                    to={card.reportPath}
                    className="link-button"
                    state={{ fromOverviewDetail: true }}
                  >
                    查看巡检详情
                  </Link>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};

const assignClusterDisplayIds = (
  clusters: ClusterConfig[],
  current: Record<number, string>
): Record<number, string> => {
  const assigned: Record<number, string> = { ...current };

  clusters.forEach((cluster) => {
    assigned[cluster.id] =
      current[cluster.id] ?? createDeterministicClusterSlug(cluster);
  });

  return assigned;
};

const isSameDisplayMap = (
  prev: Record<number, string>,
  next: Record<number, string>
) => {
  const prevKeys = Object.keys(prev);
  const nextKeys = Object.keys(next);
  if (prevKeys.length !== nextKeys.length) {
    return false;
  }
  return nextKeys.every((key) => {
    const numericKey = Number(key);
    return prev[numericKey] === next[numericKey];
  });
};

const areClusterListsEqual = (
  prev: ClusterConfig[] | null | undefined,
  next: ClusterConfig[]
) => {
  if (!prev || prev.length !== next.length) {
    return false;
  }
  const prevMap = new Map(prev.map((cluster) => [cluster.id, cluster]));
  for (const cluster of next) {
    const previous = prevMap.get(cluster.id);
    if (!previous) {
      return false;
    }
    if (
      previous.name !== cluster.name ||
      previous.connection_status !== cluster.connection_status ||
      (previous.connection_message || "") !==
        (cluster.connection_message || "") ||
      (previous.description || "") !== (cluster.description || "") ||
      (previous.prometheus_url || "") !== (cluster.prometheus_url || "") ||
      (previous.last_checked_at || "") !== (cluster.last_checked_at || "") ||
      (previous.updated_at || "") !== (cluster.updated_at || "") ||
      previous.default_agent_id !== cluster.default_agent_id
    ) {
      return false;
    }
  }
  return true;
};

const areRunListsEqual = (
  prev: InspectionRunListItem[] | null | undefined,
  next: InspectionRunListItem[]
) => {
  if (!prev || prev.length !== next.length) {
    return false;
  }
  const prevMap = new Map(prev.map((run) => [run.id, run]));
  for (const run of next) {
    const previous = prevMap.get(run.id);
    if (!previous) {
      return false;
    }
    if (
      previous.operator !== run.operator ||
      previous.cluster_id !== run.cluster_id ||
      previous.cluster_name !== run.cluster_name ||
      previous.status !== run.status ||
      previous.status_label !== run.status_label ||
      previous.summary !== run.summary ||
      previous.report_path !== run.report_path ||
      previous.total_items !== run.total_items ||
      previous.processed_items !== run.processed_items ||
      previous.progress !== run.progress ||
      previous.created_at !== run.created_at ||
      previous.completed_at !== run.completed_at ||
      previous.executor !== run.executor ||
      previous.agent_status !== run.agent_status ||
      previous.agent_status_label !== run.agent_status_label ||
      previous.agent_id !== run.agent_id ||
      previous.agent_name !== run.agent_name
    ) {
      return false;
    }
  }
  return true;
};

const logWithTimestamp = (
  level: "info" | "warn" | "error" = "info",
  message: string,
  ...details: unknown[]
) => {
  const timestamp = BEIJING_TIME_FORMATTER.format(new Date());
  const logger = console[level] ?? console.log;
  logger(`[${timestamp}] ${message}`, ...details);
};


const normalizeBackendUrl = (value: string) => value.trim().replace(/\/+$/, "");

const buildAgentRegisterCommand = ({
  backendUrl,
  token,
  clusterName,
  prometheusUrl,
}: {
  backendUrl: string;
  token: string;
  clusterName: string;
  prometheusUrl?: string | null;
}) => {
  const baseUrl = normalizeBackendUrl(backendUrl);
  const commandLines = [
    `curl -fL ${baseUrl}/system-agent-install.sh | sh -s -`,
    `  --server ${baseUrl}`,
    `  --token ${token}`,
    `  --cluster-name ${clusterName}`,
  ];
  const trimmedPrometheus = prometheusUrl?.trim();
  if (trimmedPrometheus) {
    commandLines.push(`  --prometheus-url ${trimmedPrometheus}`);
  }
  return commandLines
    .map((line, index) =>
      index === commandLines.length - 1 ? line : `${line} \\`
    )
    .join("\n");
};

interface AgentQuickCreateProps {
  clusters: ClusterConfig[];
  agents: InspectionAgent[];
  canCreateAgents: boolean;
  createDisabledReason: string | null;
  submitting: boolean;
  notice: string | null;
  error: string | null;
  generatedCommand: string | null;
  onCreate: (payload: {
    name: string;
    backend_url: string;
    description?: string;
    prometheus_url?: string | null;
    isRancherLocal?: boolean;
    rancherUrl?: string | null;
    rancherApiKey?: string | null;
  }) => Promise<void>;
  onClearCommand: () => void;
}

const DEFAULT_AGENT_PROM_URL =
  "http://rancher-monitoring-prometheus.cattle-monitoring-system:9090";

const AgentQuickCreate = ({
  clusters,
  agents,
  canCreateAgents,
  createDisabledReason,
  submitting,
  notice,
  error,
  generatedCommand,
  onCreate,
  onClearCommand,
}: AgentQuickCreateProps) => {
  const [name, setName] = useState("");
  const [backendUrl, setBackendUrl] = useState("");
  const [description, setDescription] = useState("");
  const [prometheusUrl, setPrometheusUrl] = useState("");
  const [isRancherLocal, setIsRancherLocal] = useState(false);
  const [rancherUrl, setRancherUrl] = useState("");
  const [rancherApiKey, setRancherApiKey] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const trimmedName = name.trim();
  const trimmedBackendUrl = backendUrl.trim();
  const trimmedPrometheusUrl = prometheusUrl.trim();
  const trimmedRancherUrl = rancherUrl.trim();
  const trimmedRancherApiKey = rancherApiKey.trim();
  const invalidBackendUrl =
    trimmedBackendUrl.length > 0 && !/^https?:\/\//i.test(trimmedBackendUrl);
  const invalidPrometheusUrl =
    trimmedPrometheusUrl.length > 0 &&
    !/^https?:\/\//i.test(trimmedPrometheusUrl);
  const invalidRancherUrl =
    trimmedRancherUrl.length > 0 && !/^https?:\/\//i.test(trimmedRancherUrl);
  const duplicateAgent = useMemo(
    () =>
      trimmedName.length > 0 &&
      agents.some((agent) => agent.name.trim() === trimmedName),
    [agents, trimmedName]
  );
  const duplicateCluster = useMemo(
    () =>
      trimmedName.length > 0 &&
      clusters.some((cluster) => (cluster.name ?? "").trim() === trimmedName),
    [clusters, trimmedName]
  );

  if (!canCreateAgents) {
    return (
      <div className="agent-inline-form">
        <div className="agent-inline-form-header">
          <strong>快速创建 Agent</strong>
          {createDisabledReason && (
            <span className="agent-inline-hint">{createDisabledReason}</span>
          )}
        </div>
        <p className="agent-inline-copy">
          Agent 名称必须与计划接入的集群名称保持一致，注册后不可修改。Backend 地址用于生成注册命令，请填写 Agent 节点可访问的地址。
        </p>
      </div>
    );
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedName = name.trim();
    if (!normalizedName) {
      setFormError("Agent 名称不能为空");
      return;
    }
    if (!trimmedBackendUrl) {
      setFormError("Backend 地址不能为空");
      return;
    }
    if (invalidBackendUrl) {
      setFormError("Backend 地址需以 http:// 或 https:// 开头");
      return;
    }
    if (invalidPrometheusUrl) {
      setFormError("Prometheus 地址需以 http:// 或 https:// 开头");
      return;
    }
    if (isRancherLocal) {
      if (!trimmedRancherUrl) {
        setFormError("Rancher 地址不能为空");
        return;
      }
      if (invalidRancherUrl) {
        setFormError("Rancher 地址需以 http:// 或 https:// 开头");
        return;
      }
      if (!trimmedRancherApiKey) {
        setFormError("Rancher API 密钥不能为空");
        return;
      }
    }
    if (duplicateAgent) {
      setFormError("Agent 名称已存在，请更换其他名称");
      return;
    }
    if (duplicateCluster) {
      setFormError("集群列表中已存在同名项，请勿重复创建");
      return;
    }
    setFormError(null);
    try {
      const resolvedPrometheusUrl =
        trimmedPrometheusUrl || DEFAULT_AGENT_PROM_URL;
      await onCreate({
        name: normalizedName,
        backend_url: trimmedBackendUrl,
        description: description.trim() || undefined,
        prometheus_url: resolvedPrometheusUrl || undefined,
        ...(isRancherLocal
          ? {
              isRancherLocal: true,
              rancherUrl: trimmedRancherUrl,
              rancherApiKey: trimmedRancherApiKey,
            }
          : {}),
      });
      setName("");
      setBackendUrl("");
      setDescription("");
      setPrometheusUrl("");
      setIsRancherLocal(false);
      setRancherUrl("");
      setRancherApiKey("");
    } catch (err) {
      const message = err instanceof Error ? err.message : "创建 Agent 失败";
      setFormError(message);
    }
  };

  return (
    <div className="agent-inline-form">
      <div className="agent-inline-form-header">
        <strong>快速创建 Agent</strong>
        {!canCreateAgents && createDisabledReason && (
          <span className="agent-inline-hint">{createDisabledReason}</span>
        )}
      </div>
      <p className="agent-inline-copy">
        Agent 名称必须与计划接入的集群名称保持一致，注册后不可修改。Backend 地址用于生成注册命令，请填写 Agent 节点可访问的地址。
      </p>
      <form className="agent-inline-form-body" onSubmit={handleSubmit}>
        <input
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Agent / 集群名称"
          disabled={submitting || !canCreateAgents}
        />
        <input
          type="text"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="描述（可选）"
          disabled={submitting || !canCreateAgents}
        />
        <input
          type="text"
          value={backendUrl}
          onChange={(event) => setBackendUrl(event.target.value)}
          placeholder="Backend 地址（必填）"
          disabled={submitting || !canCreateAgents}
        />
        <input
          type="text"
          value={prometheusUrl}
          onChange={(event) => setPrometheusUrl(event.target.value)}
          placeholder="Prometheus 地址（可选）"
          disabled={submitting || !canCreateAgents}
        />
        <label className="agent-inline-toggle">
          <input
            type="checkbox"
            checked={isRancherLocal}
            onChange={(event) => setIsRancherLocal(event.target.checked)}
            disabled={submitting || !canCreateAgents}
          />
          <span>Rancher Local 集群</span>
        </label>
        {isRancherLocal && (
          <>
            <input
              type="text"
              value={rancherUrl}
              onChange={(event) => setRancherUrl(event.target.value)}
              placeholder="Rancher 地址（必填）"
              disabled={submitting || !canCreateAgents}
            />
            <input
              type="password"
              value={rancherApiKey}
              onChange={(event) => setRancherApiKey(event.target.value)}
              placeholder="Rancher API 密钥（必填）"
              disabled={submitting || !canCreateAgents}
            />
          </>
        )}
        <button
          type="submit"
          className="secondary"
          disabled={submitting || !canCreateAgents}
        >
          {submitting ? "创建中..." : "创建 Agent"}
        </button>
      </form>
      {formError && <div className="feedback error">{formError}</div>}
      {error && !formError && <div className="feedback error">{error}</div>}
      {notice && <div className="feedback success">{notice}</div>}
      {generatedCommand && (
        <div className="agent-token-box">
          <p>创建成功，请在目标节点执行以下命令完成注册。</p>
          <code>{generatedCommand}</code>
          <button type="button" className="secondary" onClick={onClearCommand}>
            我已保存命令
          </button>
        </div>
      )}
    </div>
  );
};

interface OverviewProps {
  clusters: ClusterConfig[];
  clusterUploading: boolean;
  clusterNameInput: string;
  clusterPromInput: string;
  setClusterNameInput: (value: string) => void;
  setClusterPromInput: (value: string) => void;
  openKubeconfigModal: () => void;
  kubeconfigSummary: string | null;
  kubeconfigReady: boolean;
  clusterDefaultAgentIdInput: number | null;
  setClusterDefaultAgentIdInput: (value: number | null) => void;
  agents: InspectionAgent[];
  onUpload: () => Promise<void>;
  onEditCluster: (cluster: ClusterConfig) => void;
  onDeleteCluster: (cluster: ClusterConfig) => Promise<void>;
  onDeleteClustersBulk: (clusterIds: number[]) => Promise<void>;
  clusterDisplayIds: Record<number, string>;
  onTestClusterConnection: (
    clusterId: number,
    options?: { quiet?: boolean }
  ) => Promise<void>;
  testingClusterIds: Record<number, boolean>;
  license: LicenseCapabilities;
  canUpdateClusters: boolean;
  canDeleteClusters: boolean;
  canTestClusterAgents: boolean;
  canCreateClusterAgents: boolean;
  canManageAgents: boolean;
  agentSubmitting: boolean;
  agentNotice: string | null;
  agentError: string | null;
  generatedAgentCommand: string | null;
  onCreateAgent: (payload: {
    name: string;
    backend_url: string;
    description?: string;
    prometheus_url?: string | null;
    isRancherLocal?: boolean;
    rancherUrl?: string | null;
    rancherApiKey?: string | null;
  }) => Promise<void>;
  onClearAgentCommand: () => void;
}

const OverviewView = ({
  clusters,
  clusterUploading,
  clusterNameInput,
  clusterPromInput,
  setClusterNameInput,
  setClusterPromInput,
  openKubeconfigModal,
  kubeconfigSummary,
  kubeconfigReady,
  clusterDefaultAgentIdInput,
  setClusterDefaultAgentIdInput,
  agents,
  onUpload,
  onEditCluster,
  onDeleteCluster,
  onDeleteClustersBulk,
  clusterDisplayIds,
  onTestClusterConnection,
  testingClusterIds,
  license,
  canUpdateClusters,
  canDeleteClusters,
  canTestClusterAgents,
  canCreateClusterAgents,
  canManageAgents,
  agentSubmitting,
  agentNotice,
  agentError,
  generatedAgentCommand,
  onCreateAgent,
  onClearAgentCommand,
}: OverviewProps) => {
  const enableServerClusterUpload = false;
  const enableServerConnectionTest = true;
  const canManageClusters = license.canManageClusters;
  const canEditClusters = canManageClusters && canUpdateClusters;
  const canRemoveClusters = canManageClusters && canDeleteClusters;
  const canTestClusters = canManageClusters && canTestClusterAgents;
  const canCreateAgents = canManageAgents && canCreateClusterAgents;
  const createAgentDisabledReason = !canManageAgents
    ? license.reason ?? "当前 License 不支持 Agent 管理。"
    : !canCreateClusterAgents
      ? "当前账户没有创建 Agent 集群的权限。"
      : null;
  const [clusterPageSize, setClusterPageSize] = useState(
    DEFAULT_CLUSTER_PAGE_SIZE
  );
  const [pageJumpInput, setPageJumpInput] = useState("");
  const [clusterFilterStatus, setClusterFilterStatus] = useState<
    ClusterConnectionStatus | "all"
  >("all");
  const [clusterKeyword, setClusterKeyword] = useState("");
  const enabledAgents = useMemo(
    () => agents.filter((agent) => agent.is_enabled),
    [agents]
  );
  useEffect(() => {
    if (!license.canManageAgents) {
      setClusterDefaultAgentIdInput(null);
      return;
    }
    if (
      clusterDefaultAgentIdInput !== null &&
      enabledAgents.some((agent) => agent.id === clusterDefaultAgentIdInput)
    ) {
      return;
    }
    if (enabledAgents.length > 0) {
      setClusterDefaultAgentIdInput(enabledAgents[0].id);
    }
  }, [
    license.canManageAgents,
    clusterDefaultAgentIdInput,
    enabledAgents,
    setClusterDefaultAgentIdInput,
  ]);
  const [currentPage, setCurrentPage] = useState(1);

  const filteredClusters = useMemo(() => {
    let list = clusters.slice();
    if (clusterFilterStatus !== "all") {
      list = list.filter(
        (cluster) => cluster.connection_status === clusterFilterStatus
      );
    }
    const keyword = clusterKeyword.trim().toLowerCase();
    if (keyword) {
      list = list.filter((cluster) => {
        const name = (cluster.name ?? "").toLowerCase();
        const displayId = getClusterDisplayId(
          clusterDisplayIds,
          cluster.id,
          cluster
        ).toLowerCase();
        const message = (cluster.connection_message ?? "").toLowerCase();
        return (
          name.includes(keyword) ||
          displayId.includes(keyword) ||
          message.includes(keyword)
        );
      });
    }
    return list;
  }, [clusters, clusterFilterStatus, clusterKeyword, clusterDisplayIds]);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(filteredClusters.length / clusterPageSize)),
    [filteredClusters.length, clusterPageSize]
  );

  const updatePage = useCallback(
    (page: number, options?: { replace?: boolean }) => {
      const boundedPage = Math.max(page, 1);
      setCurrentPage(boundedPage);
      void options;
    },
    []
  );

  useEffect(() => {
    const maxPage = Math.max(
      1,
      Math.ceil(filteredClusters.length / clusterPageSize) || 1
    );
    if (currentPage > maxPage) {
      updatePage(maxPage, { replace: true });
    }
  }, [filteredClusters.length, clusterPageSize, currentPage, updatePage]);

  useEffect(() => {
    updatePage(1);
  }, [clusterFilterStatus, clusterKeyword, updatePage]);

  const effectivePage = useMemo(
    () => Math.min(Math.max(currentPage, 1), totalPages),
    [currentPage, totalPages]
  );

  useEffect(() => {
    if (currentPage !== effectivePage) {
      updatePage(effectivePage, { replace: true });
    }
  }, [currentPage, effectivePage, updatePage]);

  const pagedClusters = useMemo(() => {
    const start = (effectivePage - 1) * clusterPageSize;
    return filteredClusters.slice(start, start + clusterPageSize);
  }, [filteredClusters, effectivePage, clusterPageSize]);

  const handlePageChange = useCallback(
    (page: number) => {
      const target = Math.min(Math.max(page, 1), totalPages);
      updatePage(target);
    },
    [totalPages, updatePage]
  );

  const handlePageSizeChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const nextSize = Number(event.target.value);
      if (!CLUSTER_PAGE_SIZE_OPTIONS.includes(nextSize)) {
        return;
      }
      setClusterPageSize(nextSize);
      setPageJumpInput("");
      updatePage(1);
    },
    [updatePage]
  );

  const handlePageJumpInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const digitsOnly = event.target.value.replace(/[^\d]/g, "");
      setPageJumpInput(digitsOnly);
    },
    []
  );

  const handlePageJump = useCallback(() => {
    if (!pageJumpInput) {
      return;
    }
    const parsed = Number(pageJumpInput);
    if (!Number.isInteger(parsed)) {
      return;
    }
    const bounded = Math.min(Math.max(parsed, 1), totalPages);
    updatePage(bounded);
    setPageJumpInput("");
  }, [pageJumpInput, totalPages, updatePage]);

  const handlePageJumpInputKeyDown = useCallback(
    (event: { key: string; preventDefault: () => void }) => {
      if (event.key === "Enter") {
        event.preventDefault();
        handlePageJump();
      }
    },
    [handlePageJump]
  );

  const columnsForPage = useMemo(() => {
    const count = pagedClusters.length;
    if (count <= 1) {
      return 1;
    }
    if (count === 2) {
      return 2;
    }
    if (count <= 4) {
      return count;
    }
    return Math.min(count, 5);
  }, [pagedClusters.length]);

  const listStyle = useMemo<CSSProperties>(() => {
    const gap = 14;
    const cardWidth = 280;
    const maxWidth =
      columnsForPage * cardWidth + Math.max(columnsForPage - 1, 0) * gap;
    return {
      width: `min(100%, ${Math.max(maxWidth, cardWidth)}px)`,
      maxWidth: `${Math.max(maxWidth, cardWidth)}px`,
      gridTemplateColumns:
        columnsForPage === 1
          ? "minmax(280px, 360px)"
          : `repeat(${columnsForPage}, minmax(240px, 1fr))`,
      margin: 0,
    };
  }, [columnsForPage]);

  const [selectedClusterIds, setSelectedClusterIds] = useState<number[]>([]);

  useEffect(() => {
    setSelectedClusterIds((prev) =>
      prev.filter((id) => clusters.some((cluster) => cluster.id === id))
    );
  }, [clusters]);
  useEffect(() => {
    if (!canRemoveClusters) {
      setSelectedClusterIds([]);
    }
  }, [canRemoveClusters]);

  const filteredClusterIdSet = useMemo(
    () => new Set(filteredClusters.map((cluster) => cluster.id)),
    [filteredClusters]
  );
  const selectedFilteredCount = useMemo(
    () => selectedClusterIds.filter((id) => filteredClusterIdSet.has(id)).length,
    [filteredClusterIdSet, selectedClusterIds]
  );
  const allSelected =
    filteredClusters.length > 0 &&
    filteredClusters.every((cluster) =>
      selectedClusterIds.includes(cluster.id)
    );

  const handleToggleCluster = useCallback(
    (clusterId: number) => {
      if (!canRemoveClusters) {
        return;
      }
      setSelectedClusterIds((prev) =>
        prev.includes(clusterId)
          ? prev.filter((id) => id !== clusterId)
          : [...prev, clusterId]
      );
    },
    [canRemoveClusters]
  );

  const handleToggleAllClusters = useCallback(() => {
    setSelectedClusterIds((prev) => {
      if (!canRemoveClusters || filteredClusters.length === 0) {
        return prev;
      }
      const next = new Set(prev);
      const allFilteredSelected = filteredClusters.every((cluster) =>
        next.has(cluster.id)
      );
      if (allFilteredSelected) {
        filteredClusters.forEach((cluster) => next.delete(cluster.id));
        return Array.from(next);
      }
      filteredClusters.forEach((cluster) => next.add(cluster.id));
      return Array.from(next);
    });
  }, [filteredClusters, canRemoveClusters]);

  const handleDeleteSelectedClusters = useCallback(() => {
    if (!canRemoveClusters) {
      return;
    }
    const targetIds = selectedClusterIds.filter((id) =>
      filteredClusterIdSet.has(id)
    );
    if (targetIds.length === 0) {
      return;
    }
    void onDeleteClustersBulk(targetIds);
  }, [
    filteredClusterIdSet,
    onDeleteClustersBulk,
    selectedClusterIds,
    canRemoveClusters,
  ]);

  return (
    <>
      <header className="app-header">
        <div className="branding">
          {appConfig.branding.logoUrl ? (
            <img
              src={appConfig.branding.logoUrl}
              alt="logo"
              className="branding-logo"
            />
          ) : null}
          <div>
            <h1>Kubernetes 巡检中心</h1>
          </div>
        </div>
        <div className="header-actions">
          {enableServerClusterUpload ? (
            <div className="cluster-upload">
              <label>添加集群</label>
              {!license.loading && !license.valid && (
                <div className="feedback error">
                  {license.reason ?? "当前 License 无效，无法添加集群。"}
                </div>
              )}
              <input
                type="text"
                placeholder="自定义集群名称"
                value={clusterNameInput}
                disabled={!license.canManageClusters}
                onChange={(event) => setClusterNameInput(event.target.value)}
              />
              <input
                type="text"
                placeholder="Prometheus 地址"
                value={clusterPromInput}
                disabled={!license.canManageClusters}
                onChange={(event) => setClusterPromInput(event.target.value)}
              />
              <button
                className="secondary"
                onClick={() => void onUpload()}
                disabled={clusterUploading || !license.canManageClusters}
              >
                {clusterUploading ? "上传中..." : "上传集群"}
              </button>
            </div>
          ) : (
            <AgentQuickCreate
              clusters={clusters}
              agents={agents}
              canCreateAgents={canCreateAgents}
              createDisabledReason={createAgentDisabledReason}
              submitting={agentSubmitting}
              notice={agentNotice}
              error={agentError}
              generatedCommand={generatedAgentCommand}
              onCreate={onCreateAgent}
              onClearCommand={onClearAgentCommand}
            />
          )}
        </div>
      </header>

      {!license.loading && !license.valid && (
        <div className="feedback warning">
          {license.reason ?? "当前 License 未生效或未安装。"}
          请在「设置」中导入 License。
        </div>
      )}

      <section className="card cluster-panel">
        <div className="card-header">
          <h2>集群列表</h2>
          {clusters.length > 0 && (
            <div className="card-actions">
              <div className="cluster-filters">
                <select
                  value={clusterFilterStatus}
                  onChange={(event) =>
                    setClusterFilterStatus(
                      event.target.value as ClusterConnectionStatus | "all"
                    )
                  }
                >
                  <option value="all">全部状态</option>
                  <option value="connected">连接正常</option>
                  <option value="failed">连接失败</option>
                  <option value="pending">待注册</option>
                </select>
                <input
                  type="text"
                  value={clusterKeyword}
                  onChange={(event) => setClusterKeyword(event.target.value)}
                  placeholder="关键字筛选"
                />
              </div>
              {canRemoveClusters && (
                <>
                  <span className="selection-hint">
                    已选 {selectedFilteredCount} / {filteredClusters.length}
                  </span>
                  <button
                    type="button"
                    className="secondary"
                    onClick={handleToggleAllClusters}
                    disabled={!canRemoveClusters}
                  >
                    {allSelected ? "取消全选" : "全选"}
                  </button>
                  <button
                    type="button"
                    className="secondary danger"
                    onClick={handleDeleteSelectedClusters}
                    disabled={selectedClusterIds.length === 0 || !canRemoveClusters}
                  >
                    删除
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        {clusters.length === 0 ? (
          <p className="placeholder">
            暂无集群，请在 Agent 端完成注册后刷新本页面。
          </p>
        ) : filteredClusters.length === 0 ? (
          <p className="placeholder">未找到匹配的集群。</p>
        ) : (
          <>
            <div className="cluster-list" style={listStyle}>
              {pagedClusters.map((cluster) => {
                const statusMeta = getClusterStatusMeta(
                  cluster.connection_status
                );
                const displayId = getClusterDisplayId(
                  clusterDisplayIds,
                  cluster.id,
                  cluster
                );
                const isTesting = Boolean(testingClusterIds[cluster.id]);
                const isSelected = selectedClusterIds.includes(cluster.id);
                const detailPath = `/clusters/${displayId}`;
                const versionLabel =
                  cluster.kubernetes_version &&
                  cluster.kubernetes_version.trim().length > 0
                    ? cluster.kubernetes_version.trim()
                    : null;
                const nodeCountLabel =
                  typeof cluster.node_count === "number"
                    ? String(cluster.node_count)
                    : null;
                const healthMessage =
                  cluster.agent_health_message?.trim() || null;
                const summaryText =
                  versionLabel || nodeCountLabel
                    ? `版本 ${versionLabel ?? "未知"} · 节点数 ${nodeCountLabel ?? "未知"}`
                    : healthMessage
                      ? "版本 未知 · 节点数 未知"
                      : cluster.connection_message || "未校验";
                const descriptionText =
                  (cluster.description && cluster.description.trim()) ||
                  (cluster.default_agent_description &&
                    cluster.default_agent_description.trim()) ||
                  null;
                return (
                  <div
                    key={cluster.id}
                    className={`cluster-card${isSelected ? " selected" : ""}`}
                  >
                    <Link
                      to={detailPath}
                      className="cluster-card-overlay"
                      aria-label={`查看集群 ${cluster.name}`}
                    />
                    <div className="cluster-card-content">
                    <div className="cluster-card-top">
                      <div className="cluster-name-row">
                        {canRemoveClusters && (
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={(event) => {
                              event.stopPropagation();
                              handleToggleCluster(cluster.id);
                            }}
                            onClick={(event) => event.stopPropagation()}
                            disabled={!canRemoveClusters}
                          />
                        )}
                        <span className="cluster-id-badge">{displayId}</span>
                        <div className="cluster-name">{cluster.name}</div>
                      </div>
                      <div className="cluster-actions">
                        {canEditClusters && (
                          <button
                            className="link-button small"
                            onClick={(event) => {
                              event.stopPropagation();
                              onEditCluster(cluster);
                            }}
                          >
                            编辑
                          </button>
                        )}
                        {canRemoveClusters && (
                          <button
                            className="link-button small danger"
                            onClick={async (event) => {
                              event.stopPropagation();
                              await onDeleteCluster(cluster);
                            }}
                          >
                            删除
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="cluster-status-line">
                      {enableServerConnectionTest && canTestClusterAgents && (
                        <button
                          type="button"
                          className="secondary cluster-test-button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void onTestClusterConnection(cluster.id, {
                              quiet: true,
                            });
                          }}
                          disabled={isTesting || !canTestClusters}
                        >
                          {isTesting ? "诊断中..." : "连接测试"}
                        </button>
                      )}
                      <span className={`status-chip ${statusMeta?.className}`}>
                        {statusMeta?.label}
                      </span>
                    </div>
                    {healthMessage && (
                      <div className="cluster-health-message">
                        {healthMessage}
                      </div>
                    )}
                    <div
                      className="cluster-status-message"
                      title={summaryText}
                    >
                      {summaryText}
                    </div>
                    {descriptionText && (
                      <div className="cluster-agent-description">
                        <span className="cluster-agent-description-label">
                          描述：
                        </span>
                        <span className="cluster-agent-description-text">
                          {descriptionText}
                        </span>
                      </div>
                    )}
                    {cluster.last_checked_at && (
                      <div className="cluster-status-time">
                        最近校验: {formatDate(cluster.last_checked_at)}
                      </div>
                    )}
                    <div className="cluster-meta">
                      <span>
                        Prometheus: {cluster.prometheus_url || "未配置"}
                      </span>
                    </div>
                    <div className="cluster-meta">
                      <span>创建时间: {formatDate(cluster.created_at)}</span>
                      <span>更新时间: {formatDate(cluster.updated_at)}</span>
                    </div>
                    </div>
                  </div>
                );
              })}
            </div>
            {clusters.length > 0 && (
              <div className="pagination">
                <div className="pagination-size">
                  <label htmlFor="cluster-page-size">每页</label>
                  <select
                    id="cluster-page-size"
                    value={clusterPageSize}
                    onChange={handlePageSizeChange}
                  >
                    {CLUSTER_PAGE_SIZE_OPTIONS.map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  className="pagination-nav"
                  onClick={() => handlePageChange(effectivePage - 1)}
                  disabled={effectivePage === 1}
                >
                  上一页
                </button>
                <div className="pagination-pages">
                  {Array.from({ length: totalPages }, (_, index) => {
                    const page = index + 1;
                    return (
                      <button
                        type="button"
                        key={page}
                        className={`page-button${
                          effectivePage === page ? " active" : ""
                        }`}
                        onClick={() => handlePageChange(page)}
                      >
                        {page}
                      </button>
                    );
                  })}
                </div>
                <button
                  type="button"
                  className="pagination-nav"
                  onClick={() => handlePageChange(effectivePage + 1)}
                  disabled={effectivePage === totalPages}
                >
                  下一页
                </button>
                <div className="page-jump">
                  <span>跳转至</span>
                  <input
                    className="page-jump-input"
                    value={pageJumpInput}
                    onChange={handlePageJumpInputChange}
                    onKeyDown={handlePageJumpInputKeyDown}
                    inputMode="numeric"
                    pattern="[0-9]*"
                    aria-label="跳转页码"
                  />
                  <span> / {totalPages}</span>
                  <button
                    type="button"
                    className="pagination-nav"
                    onClick={handlePageJump}
                    disabled={!pageJumpInput}
                  >
                    跳转
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </section>

    </>
  );
};

interface KubeconfigModalProps {
  open: boolean;
  text: string;
  fileName: string | null;
  hasManualContent: boolean;
  title?: string;
  description?: string;
  confirmLabel?: string;
  fileButtonLabel?: string;
  fileInputId?: string;
  onClose: () => void;
  onFileSelected: (file: File) => void;
  onTextChange: (value: string) => void;
  onClear: () => void;
}

const KubeconfigModal = ({
  open,
  text,
  fileName,
  hasManualContent,
  title,
  description,
  confirmLabel,
  fileButtonLabel,
  fileInputId,
  onClose,
  onFileSelected,
  onTextChange,
  onClear,
}: KubeconfigModalProps) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const generatedId = useId();
  const resolvedFileInputId = fileInputId ?? `${generatedId}-file`;

  const modalTitle = title ?? "导入 kubeconfig";
  const modalDescription =
    description ?? "上传文件或粘贴 YAML 内容，提交集群时将一并上传。";
  const modalConfirmLabel = confirmLabel ?? "完成";
  const modalFileButtonLabel = fileButtonLabel ?? "上传文件";

  if (!open) {
    return null;
  }

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) {
      return;
    }
    onFileSelected(file);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleTextareaChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    onTextChange(event.currentTarget.value);
  };

  const handleClear = () => {
    onClear();
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal kubeconfig-modal">
        <div className="kubeconfig-modal-header">
          <h3>{modalTitle}</h3>
          <p>{modalDescription}</p>
        </div>
        <div className="kubeconfig-modal-upload">
          <label
            htmlFor={resolvedFileInputId}
            className="kubeconfig-file-trigger"
          >
            {modalFileButtonLabel}
          </label>
          <input
            id={resolvedFileInputId}
            ref={fileInputRef}
            type="file"
            accept=".yaml,.yml,.json"
            onChange={handleFileChange}
            hidden
          />
          <div className="kubeconfig-file-summary">
            {fileName ? (
              hasManualContent ? (
                <>
                  已基于 <strong>{fileName}</strong> 进行编辑
                </>
              ) : (
                <>
                  已选择文件: <strong>{fileName}</strong>
                </>
              )
            ) : (
              "支持 .yaml/.yml/.json 文件"
            )}
          </div>
          <button
            type="button"
            className="link-button small"
            onClick={handleClear}
          >
            清空内容
          </button>
        </div>
        <label className="kubeconfig-textarea-label">
          kubeconfig 内容
          <textarea
            className="kubeconfig-textarea"
            value={text}
            onChange={handleTextareaChange}
            placeholder="在此粘贴或编辑 kubeconfig YAML 内容"
            rows={14}
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            取消
          </button>
          <button type="button" className="primary" onClick={onClose}>
            {modalConfirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

interface HistoryViewProps {
  runs: InspectionRunListItem[];
  onRefreshRuns: () => Promise<void>;
  onDeleteRun: (run: InspectionRunListItem) => Promise<void>;
  onDeleteRunsBulk: (runIds: number[]) => Promise<void>;
  onCancelRun: (run: InspectionRunListItem) => Promise<void>;
  clusterDisplayIds: Record<number, string>;
  runDisplayIds: Record<number, string>;
  license: LicenseCapabilities;
  canCreateHistory: boolean;
  canUpdateHistory: boolean;
  canDeleteHistory: boolean;
}

const HistoryView = ({
  runs,
  onRefreshRuns,
  onDeleteRun,
  onDeleteRunsBulk,
  onCancelRun,
  clusterDisplayIds,
  runDisplayIds,
  license,
  canCreateHistory,
  canUpdateHistory,
  canDeleteHistory,
}: HistoryViewProps) => {
  const navigate = useNavigate();

  const [historyStatusFilter, setHistoryStatusFilter] = useState<
    InspectionRunStatus | "all"
  >("all");
  const [historyKeyword, setHistoryKeyword] = useState("");

  const [pageSize, setPageSize] = useState<number>(RUN_PAGE_SIZE_OPTIONS[0]);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("");
  const canRunInspections = license.canRunInspections;
  const canDownloadReports = license.canDownloadReports;
  const canManageHistory =
    canCreateHistory || canUpdateHistory || canDeleteHistory;

  const filteredRuns = useMemo(() => {
    const normalizedKeyword = historyKeyword.trim().toLowerCase();
    return runs.filter((run) => {
      if (historyStatusFilter !== "all" && run.status !== historyStatusFilter) {
        return false;
      }
      if (normalizedKeyword) {
        const keywordSource = [
          runDisplayIds[run.id] ?? `#${run.id}`,
          clusterDisplayIds[run.cluster_id] ?? `#${run.cluster_id}`,
          run.cluster_name,
          run.operator,
          run.agent_name,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!keywordSource.includes(normalizedKeyword)) {
          return false;
        }
      }
      return true;
    });
  }, [
    runs,
    historyStatusFilter,
    historyKeyword,
    clusterDisplayIds,
    runDisplayIds,
  ]);

  useEffect(() => {
    setPage(1);
    setPageInput("");
  }, [pageSize]);

  useEffect(() => {
    setPage(1);
    setPageInput("");
  }, [historyStatusFilter, historyKeyword]);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(filteredRuns.length / Math.max(pageSize, 1))),
    [filteredRuns.length, pageSize]
  );

  useEffect(() => {
    setPage((prev) => Math.min(Math.max(prev, 1), totalPages));
  }, [totalPages]);

  const [selectedRunIds, setSelectedRunIds] = useState<number[]>([]);

  useEffect(() => {
    setSelectedRunIds((prev) =>
      prev.filter((id) => filteredRuns.some((run) => run.id === id))
    );
  }, [filteredRuns]);
  useEffect(() => {
    if (!canRunInspections || !canDeleteHistory) {
      setSelectedRunIds([]);
    }
  }, [canRunInspections, canDeleteHistory]);

  const pagedRuns = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredRuns.slice(start, start + pageSize);
  }, [filteredRuns, page, pageSize]);

  const visibleSelectedCount = useMemo(
    () =>
      selectedRunIds.filter((id) =>
        pagedRuns.some((run) => run.id === id)
      ).length,
    [selectedRunIds, pagedRuns]
  );

  const allSelected =
    pagedRuns.length > 0 &&
    pagedRuns.every((run) => selectedRunIds.includes(run.id));

  const handleToggleRun = useCallback(
    (runId: number) => {
      if (!canRunInspections || !canDeleteHistory) {
        return;
      }
      setSelectedRunIds((prev) =>
        prev.includes(runId)
          ? prev.filter((id) => id !== runId)
          : [...prev, runId]
      );
    },
    [canRunInspections, canDeleteHistory]
  );

  const handleToggleAllRuns = useCallback(() => {
    setSelectedRunIds((prev) => {
      if (
        !canRunInspections ||
        !canDeleteHistory ||
        pagedRuns.length === 0
      ) {
        return prev;
      }
      const visibleIds = pagedRuns.map((run) => run.id);
      const allVisibleSelected = visibleIds.every((id) => prev.includes(id));
      if (allVisibleSelected) {
        return prev.filter((id) => !visibleIds.includes(id));
      }
      const merged = new Set(prev);
      visibleIds.forEach((id) => merged.add(id));
      return Array.from(merged);
    });
  }, [pagedRuns, canRunInspections, canDeleteHistory]);

  const handlePageChange = useCallback(
    (offset: number) => {
      setPage((prev) => {
        const next = prev + offset;
        if (next < 1) {
          return 1;
        }
        if (next > totalPages) {
          return totalPages;
        }
        return next;
      });
    },
    [totalPages]
  );

  const handlePageSizeChange = useCallback((value: number) => {
    setPageSize(value);
  }, []);

  const handlePageJump = useCallback(() => {
    const trimmed = pageInput.trim();
    if (!trimmed) {
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isNaN(parsed) && Number.isInteger(parsed)) {
      const target = Math.min(Math.max(parsed, 1), totalPages);
      setPage(target);
    }
    setPageInput("");
  }, [pageInput, totalPages]);

  const handleDeleteSelectedRuns = useCallback(() => {
    if (!canRunInspections || !canDeleteHistory) {
      return;
    }
    if (selectedRunIds.length === 0) {
      return;
    }
    void onDeleteRunsBulk(selectedRunIds);
  }, [onDeleteRunsBulk, selectedRunIds, canRunInspections, canDeleteHistory]);

  const handleHistoryStatusFilterChange = (
    event: ChangeEvent<HTMLSelectElement>
  ) => {
    setHistoryStatusFilter(event.target.value as InspectionRunStatus | "all");
  };

  const handleKeywordFilterChange = (
    event: ChangeEvent<HTMLInputElement>
  ) => {
    setHistoryKeyword(event.target.value);
  };

  const handleKeywordFilterClear = () => {
    setHistoryKeyword("");
  };

  return (
    <section className="card history history-page">
      <div className="card-header history-header">
        <h2>历史巡检</h2>
        <div className="history-filter-row">
          <div className="history-chip history-chip-select">
            <span className="history-chip-label">状态筛选</span>
            <select
              value={historyStatusFilter}
              onChange={handleHistoryStatusFilterChange}
            >
              {HISTORY_STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="history-chip history-chip-search">
            <span className="history-chip-label">关键字</span>
            <input
              type="text"
              value={historyKeyword}
              onChange={handleKeywordFilterChange}
              placeholder="按巡检编号 / 集群 / 巡检人搜索"
            />
            {historyKeyword && (
              <button
                type="button"
                className="history-search-clear"
                onClick={handleKeywordFilterClear}
                aria-label="清空关键字"
              >
                ×
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="history-toolbar">
        {canDeleteHistory && (
          <div className="history-selection">
            <label className="table-checkbox">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={handleToggleAllRuns}
                disabled={!canRunInspections}
              />
              <span>当前页全选</span>
            </label>
            <span className="selection-hint">
              已选 {visibleSelectedCount} / {filteredRuns.length}
            </span>
            <button
              type="button"
              className="secondary danger"
              onClick={handleDeleteSelectedRuns}
              disabled={selectedRunIds.length === 0 || !canRunInspections}
            >
              删除所选
            </button>
          </div>
        )}
        <div className="history-pagination-controls">
          <label>
            每页
            <select
              value={pageSize}
              onChange={(event) =>
                handlePageSizeChange(Number(event.target.value))
              }
            >
              {RUN_PAGE_SIZE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <div className="history-pagination-buttons">
            <button
              type="button"
              className="secondary"
              onClick={() => handlePageChange(-1)}
              disabled={page <= 1}
            >
              上一页
            </button>
            <span>
              第 {page} / {totalPages} 页
            </span>
            <button
              type="button"
              className="secondary"
              onClick={() => handlePageChange(1)}
              disabled={page >= totalPages}
            >
              下一页
            </button>
          </div>
          <label className="history-page-jump">
            跳转
            <input
              type="number"
              min={1}
              value={pageInput}
              onChange={(event) => setPageInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handlePageJump();
                }
              }}
            />
          </label>
          <button type="button" className="secondary" onClick={handlePageJump}>
            确定
          </button>
        </div>
      </div>
      <div className="table-wrapper">
        {filteredRuns.length === 0 ? (
          <div className="placeholder">暂无巡检记录</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>巡检编号</th>
                <th>集群</th>
                <th>巡检人</th>
                <th>状态</th>
                <th>Agent 状态</th>
                <th>开始时间</th>
                <th>结束时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {pagedRuns.map((run) => {
                const runSlug = runDisplayIds[run.id] ?? `#${run.id}`;
                const clusterSlug =
                  clusterDisplayIds[run.cluster_id] ?? `#${run.cluster_id}`;
                const archivedInfo = resolveArchivedClusterName(
                  run.cluster_name
                );
                const fallbackClusterDisplayId = createDeterministicClusterSlug(
                  {
                    id: run.cluster_id,
                    name: archivedInfo.baseName,
                  } as ClusterConfig
                );
                const clusterDisplayId =
                  clusterDisplayIds[run.cluster_id] ??
                  fallbackClusterDisplayId ??
                  `#${run.cluster_id}`;
                const clusterLabel = archivedInfo.archived
                  ? `${clusterDisplayId}（已删除）`
                  : clusterDisplayId;
                const isSelected = selectedRunIds.includes(run.id);
                const canDelete = run.status !== "running";
                return (
                  <tr key={run.id}>
                    <td>
                      {canDeleteHistory ? (
                        <label className="table-checkbox">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => handleToggleRun(run.id)}
                            disabled={!canRunInspections}
                          />
                          <span>{runSlug}</span>
                        </label>
                      ) : (
                        <span>{runSlug}</span>
                      )}
                    </td>
                    <td>{clusterLabel}</td>
                    <td>{run.operator || "-"}</td>
                    <td>
                      <span className={statusClass(run.status)}>
                        {run.status_label ?? run.status}
                      </span>
                    </td>
                    <td>
                      {run.executor === "agent" && run.agent_status ? (
                        <span className={agentStatusClassName(run.agent_status)}>
                          {run.agent_status_label ??
                            describeAgentStatus(run.agent_status)}
                        </span>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td>{formatDate(run.created_at)}</td>
                    <td>{formatDate(run.completed_at)}</td>
                    <td className="actions">
                      <button
                        type="button"
                        className="link-button"
                        onClick={() =>
                          navigate(`/clusters/${clusterSlug}/runs/${runSlug}`, {
                            state: { backTarget: "/history" },
                          })
                        }
                      >
                        查看详情
                      </button>
                      {run.report_path && canDownloadReports && (
                        <>
                          <a
                            className="link-button"
                            href={getReportDownloadUrl(run.id, "pdf")}
                            target="_blank"
                            rel="noreferrer"
                          >
                            下载 PDF
                          </a>
                          <a
                            className="link-button"
                            href={getReportDownloadUrl(run.id, "md")}
                            target="_blank"
                            rel="noreferrer"
                          >
                            下载 MD
                          </a>
                        </>
                      )}
                      {run.status === "running" && canUpdateHistory && (
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => void onCancelRun(run)}
                          disabled={!canRunInspections}
                        >
                          取消
                        </button>
                      )}
                      {canDeleteHistory && (
                        <button
                          type="button"
                          className="link-button danger"
                          onClick={() => void onDeleteRun(run)}
                          disabled={!canDelete || !canRunInspections}
                        >
                          删除
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
};

const AuditView = () => {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionFilter, setActionFilter] = useState("all");
  const [entityFilter, setEntityFilter] = useState("all");
  const [keyword, setKeyword] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [pageSize, setPageSize] = useState<number>(
    AUDIT_PAGE_SIZE_OPTIONS[0]
  );
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("");
  const [yamlEntry, setYamlEntry] = useState<AuditLog | null>(null);

  useAutoClearError(error, setError);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(total / Math.max(pageSize, 1))),
    [total, pageSize]
  );

  useEffect(() => {
    setPage((prev) => Math.min(Math.max(prev, 1), totalPages));
  }, [totalPages]);

  useEffect(() => {
    setPage(1);
    setPageInput("");
  }, [actionFilter, entityFilter, keyword, startTime, endTime, pageSize]);

  const toIsoString = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) {
      return undefined;
    }
    return parsed.toISOString();
  };

  const refreshLogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const entityTypeParam =
        entityFilter === "all"
          ? undefined
          : entityFilter === "cluster"
            ? "cluster"
            : entityFilter;
      const response = await getAuditLogs({
        page,
        page_size: pageSize,
        action: actionFilter === "all" ? undefined : actionFilter,
        entity_type: entityTypeParam,
        keyword: keyword.trim() ? keyword.trim() : undefined,
        start: toIsoString(startTime),
        end: toIsoString(endTime),
      });
      setLogs(response.items ?? []);
      setTotal(response.total ?? 0);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "获取审计日志失败";
      setError(message);
      setLogs([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, actionFilter, entityFilter, keyword, startTime, endTime]);

  useEffect(() => {
    void refreshLogs();
  }, [refreshLogs]);

  const handlePageChange = useCallback(
    (offset: number) => {
      setPage((prev) => {
        const next = prev + offset;
        if (next < 1) {
          return 1;
        }
        if (next > totalPages) {
          return totalPages;
        }
        return next;
      });
    },
    [totalPages]
  );

  const handlePageJump = useCallback(() => {
    const trimmed = pageInput.trim();
    if (!trimmed) {
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isNaN(parsed) && Number.isInteger(parsed)) {
      const target = Math.min(Math.max(parsed, 1), totalPages);
      setPage(target);
    }
    setPageInput("");
  }, [pageInput, totalPages]);

  const clearKeyword = () => setKeyword("");

  const toYamlScalar = (value: unknown) => {
    if (value === null || value === undefined || value === "") {
      return "null";
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    return JSON.stringify(String(value));
  };

  const buildAuditYaml = (entry: AuditLog) => {
    const lines = [
      `id: ${toYamlScalar(entry.id)}`,
      `time: ${toYamlScalar(formatDate(entry.created_at))}`,
      `user: ${toYamlScalar(entry.username ?? "")}`,
      `action: ${toYamlScalar(resolveAuditActionLabel(entry.action))}`,
      `entity_type: ${toYamlScalar(resolveAuditEntityLabel(entry.entity_type))}`,
      `entity_id: ${toYamlScalar(entry.entity_id ?? "")}`,
      `status: ${toYamlScalar(entry.status ?? "")}`,
      `ip_address: ${toYamlScalar(entry.ip_address ?? "")}`,
      `user_agent: ${toYamlScalar(entry.user_agent ?? "")}`,
      `description: ${toYamlScalar(entry.description ?? "")}`,
    ];
    return `${lines.join("\n")}\n`;
  };

  const renderEntityLabel = (entry: AuditLog) => {
    return resolveAuditEntityLabel(entry.entity_type);
  };

  return (
    <section className="card history history-page audit-page">
      <div className="card-header history-header">
        <h2>审计日志</h2>
        <div className="history-filter-row">
          <div className="history-chip history-chip-select">
            <span className="history-chip-label">操作类型</span>
            <select
              value={actionFilter}
              onChange={(event) => setActionFilter(event.target.value)}
            >
              {AUDIT_ACTION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="history-chip history-chip-select">
            <span className="history-chip-label">对象类型</span>
            <select
              value={entityFilter}
              onChange={(event) => setEntityFilter(event.target.value)}
            >
              {AUDIT_ENTITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="history-chip history-chip-date">
            <span className="history-chip-label">开始</span>
            <input
              type="datetime-local"
              value={startTime}
              onChange={(event) => setStartTime(event.target.value)}
            />
          </div>
          <div className="history-chip history-chip-date">
            <span className="history-chip-label">结束</span>
            <input
              type="datetime-local"
              value={endTime}
              onChange={(event) => setEndTime(event.target.value)}
            />
          </div>
          <div className="history-chip history-chip-search">
            <span className="history-chip-label">关键字</span>
            <input
              type="text"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="按用户 / 对象 / 描述搜索"
            />
            {keyword && (
              <button
                type="button"
                className="history-search-clear"
                onClick={clearKeyword}
                aria-label="清空关键字"
              >
                ×
              </button>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div
          className={`feedback ${
            isLicenseRelatedMessage(error) ? "warning" : "error"
          }`}
        >
          {error}
        </div>
      )}

      <div className="history-toolbar">
        <div className="history-selection">
          <span className="selection-hint">共 {total} 条</span>
          {loading && <span className="selection-hint">加载中...</span>}
        </div>
        <div className="history-pagination-controls">
          <label>
            每页
            <select
              value={pageSize}
              onChange={(event) =>
                setPageSize(Number(event.target.value))
              }
            >
              {AUDIT_PAGE_SIZE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <div className="history-pagination-buttons">
            <button
              type="button"
              className="secondary"
              onClick={() => handlePageChange(-1)}
              disabled={page <= 1}
            >
              上一页
            </button>
            <span>
              第 {page} / {totalPages} 页
            </span>
            <button
              type="button"
              className="secondary"
              onClick={() => handlePageChange(1)}
              disabled={page >= totalPages}
            >
              下一页
            </button>
          </div>
          <label className="history-page-jump">
            跳转
            <input
              type="number"
              min={1}
              value={pageInput}
              onChange={(event) => setPageInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handlePageJump();
                }
              }}
            />
          </label>
          <button type="button" className="secondary" onClick={handlePageJump}>
            确定
          </button>
        </div>
      </div>

      <div className="table-wrapper">
        {loading ? (
          <div className="placeholder">加载中...</div>
        ) : logs.length === 0 ? (
          <div className="placeholder">暂无审计记录</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>用户</th>
                <th>操作类型</th>
                <th>对象</th>
                <th>描述</th>
                <th>查看 YAML</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((entry) => (
                <tr key={entry.id}>
                  <td>{formatDate(entry.created_at)}</td>
                  <td>{entry.username || "-"}</td>
                  <td>{resolveAuditActionLabel(entry.action)}</td>
                  <td>{renderEntityLabel(entry)}</td>
                  <td>{entry.description || "-"}</td>
                  <td>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => setYamlEntry(entry)}
                    >
                      查看
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {yamlEntry && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal audit-yaml-modal">
            <div className="modal-header">
              <h3>审计记录 YAML</h3>
              <button
                type="button"
                className="text-button"
                onClick={() => setYamlEntry(null)}
              >
                关闭
              </button>
            </div>
            <pre className="audit-yaml-content">
              {buildAuditYaml(yamlEntry)}
            </pre>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => setYamlEntry(null)}
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};

interface ClusterDetailViewProps {
  clusters: ClusterConfig[];
  items: InspectionItem[];
  runs: InspectionRunListItem[];
  prometheusVersionOptions: string[];
  selectedIds: number[];
  setSelectedIds: (updater: (prev: number[]) => number[]) => void;
  operator: string;
  setOperator: (value: string) => void;
  inspectionLoading: boolean;
  onStartInspection: (
    clusterId: number,
    prometheusVersion: string
  ) => Promise<void>;
  onDeleteRun: (run: InspectionRunListItem) => Promise<void>;
  onDeleteRunsBulk: (runIds: number[]) => Promise<void>;
  onCancelRun: (run: InspectionRunListItem) => Promise<void>;
  onPauseRun: (run: InspectionRunListItem) => Promise<void>;
  onResumeRun: (run: InspectionRunListItem) => Promise<void>;
  onEditCluster: (cluster: ClusterConfig) => void;
  onDeleteCluster: (cluster: ClusterConfig) => Promise<void>;
  clusterDisplayIds: Record<number, string>;
  runDisplayIds: Record<number, string>;
  onTestClusterConnection: (
    clusterId: number,
    options?: { quiet?: boolean }
  ) => Promise<void>;
  testingClusterIds: Record<number, boolean>;
  license: LicenseCapabilities;
  canUpdateClusters: boolean;
  canDeleteClusters: boolean;
  canTestClusterAgents: boolean;
  canCreateHistory: boolean;
  canUpdateHistory: boolean;
  canDeleteHistory: boolean;
}

const ClusterDetailView = ({
  clusters,
  items,
  runs,
  prometheusVersionOptions,
  selectedIds,
  setSelectedIds,
  operator,
  setOperator,
  inspectionLoading,
  onStartInspection,
  onDeleteRun,
  onDeleteRunsBulk,
  onCancelRun,
  onPauseRun,
  onResumeRun,
  onEditCluster,
  onDeleteCluster,
  clusterDisplayIds,
  runDisplayIds,
  onTestClusterConnection,
  testingClusterIds,
  license,
  canUpdateClusters,
  canDeleteClusters,
  canTestClusterAgents,
  canCreateHistory,
  canUpdateHistory,
  canDeleteHistory,
}: ClusterDetailViewProps) => {
  const enableServerConnectionTest = true;
  const { clusterKey } = useParams<{ clusterKey?: string }>();
  const navigate = useNavigate();
  const operatorInputId = useId();
  const prometheusVersionInputId = useId();
  const [selectedRunIds, setSelectedRunIds] = useState<number[]>([]);
  const [clusterRunPageSize, setClusterRunPageSize] = useState<number>(
    RUN_PAGE_SIZE_OPTIONS[0]
  );
  const [clusterRunPage, setClusterRunPage] = useState(1);
  const [clusterRunPageInput, setClusterRunPageInput] = useState("");
  const [itemPageSize, setItemPageSize] = useState<number>(
    CLUSTER_ITEM_PAGE_SIZE_OPTIONS[0]
  );
  const [itemPage, setItemPage] = useState(1);
  const [itemPageInput, setItemPageInput] = useState("");
  const [itemKeyword, setItemKeyword] = useState("");
  const [prometheusVersion, setPrometheusVersion] = useState(
    DEFAULT_PROMETHEUS_VERSION
  );
  const canManageClusters = license.canManageClusters;
  const canTestClusters = canManageClusters && canTestClusterAgents;
  const canEditClusters = canManageClusters && canUpdateClusters;
  const canRemoveClusters = canManageClusters && canDeleteClusters;
  const canRunInspections = license.canRunInspections;
  const canDownloadReports = license.canDownloadReports;
  const canManageHistory =
    canCreateHistory || canUpdateHistory || canDeleteHistory;

  const resolvedClusterId = useMemo(
    () =>
      resolveClusterIdFromRouteKey(clusterKey, clusterDisplayIds, clusters),
    [clusterKey, clusterDisplayIds, clusters]
  );

  const cluster = useMemo(() => {
    if (resolvedClusterId === null) {
      return null;
    }
    return clusters.find((item) => item.id === resolvedClusterId) ?? null;
  }, [clusters, resolvedClusterId]);

  const handleBackToPreviousPage = useCallback(() => {
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate("/");
    }
  }, [navigate]);


  const clusterRuns = useMemo(() => {
    if (!cluster) {
      return [];
    }
    return runs
      .filter((run) => run.cluster_id === cluster.id)
      .slice()
      .sort((a, b) => {
        const timeA = a.created_at ? new Date(a.created_at).getTime() : 0;
        const timeB = b.created_at ? new Date(b.created_at).getTime() : 0;
        if (timeA === timeB) {
          return b.id - a.id;
        }
        return timeB - timeA;
      });
  }, [cluster, runs]);

  useEffect(() => {
    setSelectedIds(() => []);
    setSelectedRunIds([]);
  }, [resolvedClusterId, setSelectedIds]);

  useEffect(() => {
    setPrometheusVersion(DEFAULT_PROMETHEUS_VERSION);
  }, [resolvedClusterId]);

  useEffect(() => {
    if (!prometheusVersionOptions.includes(prometheusVersion)) {
      setPrometheusVersion(DEFAULT_PROMETHEUS_VERSION);
    }
  }, [prometheusVersionOptions, prometheusVersion]);

  useEffect(() => {
    setSelectedIds(() => []);
  }, [prometheusVersion, setSelectedIds]);

  useEffect(() => {
    setSelectedRunIds((prev) =>
      prev.filter((id) => clusterRuns.some((run) => run.id === id))
    );
  }, [clusterRuns]);
  useEffect(() => {
    if (!canRunInspections) {
      setSelectedIds(() => []);
      setSelectedRunIds([]);
      return;
    }
    if (!canDeleteHistory) {
      setSelectedRunIds([]);
    }
  }, [canRunInspections, canDeleteHistory, setSelectedIds, setSelectedRunIds]);

  const totalClusterRunPages = useMemo(
    () =>
      Math.max(
        1,
        Math.ceil(clusterRuns.length / Math.max(clusterRunPageSize, 1))
      ),
    [clusterRuns.length, clusterRunPageSize]
  );

  useEffect(() => {
    setClusterRunPage(1);
    setClusterRunPageInput("");
  }, [clusterRunPageSize, resolvedClusterId]);

  useEffect(() => {
    setClusterRunPage((prev) =>
      Math.min(Math.max(prev, 1), totalClusterRunPages)
    );
  }, [totalClusterRunPages]);

  const pagedClusterRuns = useMemo(() => {
    const start = (clusterRunPage - 1) * clusterRunPageSize;
    return clusterRuns.slice(start, start + clusterRunPageSize);
  }, [clusterRuns, clusterRunPage, clusterRunPageSize]);

  const inspectionKeyword = itemKeyword.trim().toLowerCase();
  const selectedPrometheusVersion = normalizePrometheusVersion(
    prometheusVersion,
    prometheusVersionOptions
  );
  const matchesInspectionKeyword = useCallback(
    (item: InspectionItem) => {
      if (!inspectionKeyword) {
        return true;
      }
      const name = (item.name ?? "").toLowerCase();
      const desc = (item.description ?? "").toLowerCase();
      return name.includes(inspectionKeyword) || desc.includes(inspectionKeyword);
    },
    [inspectionKeyword]
  );
  const filteredPromqlItems = useMemo(
    () =>
      items.filter(
        (item) =>
          isPromqlType(item.check_type) &&
          normalizePrometheusVersion(
            item.prometheus_version,
            prometheusVersionOptions
          ) ===
            selectedPrometheusVersion &&
          matchesInspectionKeyword(item)
      ),
    [items, matchesInspectionKeyword, selectedPrometheusVersion]
  );
  const filteredCommonItems = useMemo(
    () =>
      items.filter(
        (item) =>
          !isPromqlType(item.check_type) &&
          !isRancherLocalType(item.check_type) &&
          matchesInspectionKeyword(item)
      ),
    [items, matchesInspectionKeyword]
  );
  const filteredInspectionItems = useMemo(
    () => [...filteredPromqlItems, ...filteredCommonItems],
    [filteredPromqlItems, filteredCommonItems]
  );
  const rancherItemIdSet = useMemo(
    () =>
      new Set(
        items
          .filter((item) => isRancherLocalType(item.check_type))
          .map((item) => item.id)
      ),
    [items]
  );

  const totalInspectionPages = useMemo(
    () =>
      Math.max(
        1,
        Math.ceil(filteredInspectionItems.length / Math.max(itemPageSize, 1))
      ),
    [filteredInspectionItems.length, itemPageSize]
  );

  useEffect(() => {
    setItemPage(1);
    setItemPageInput("");
  }, [itemPageSize, filteredInspectionItems.length, itemKeyword]);

  useEffect(() => {
    setItemPage((prev) => Math.min(Math.max(prev, 1), totalInspectionPages));
  }, [totalInspectionPages]);

  useEffect(() => {
    if (rancherItemIdSet.size === 0) {
      return;
    }
    setSelectedIds((prev) => prev.filter((id) => !rancherItemIdSet.has(id)));
  }, [rancherItemIdSet, setSelectedIds]);

  const pagedInspectionItems = useMemo(() => {
    if (filteredInspectionItems.length === 0) {
      return [];
    }
    const start = (itemPage - 1) * itemPageSize;
    return filteredInspectionItems.slice(start, start + itemPageSize);
  }, [filteredInspectionItems, itemPage, itemPageSize]);
  const pagedPromqlItems = useMemo(
    () => pagedInspectionItems.filter((item) => isPromqlType(item.check_type)),
    [pagedInspectionItems]
  );
  const pagedCommonItems = useMemo(
    () =>
      pagedInspectionItems.filter(
        (item) =>
          !isPromqlType(item.check_type) &&
          !isRancherLocalType(item.check_type)
      ),
    [pagedInspectionItems]
  );
  const versionHint = useMemo(() => {
    if (filteredPromqlItems.length === 0 && filteredCommonItems.length > 0) {
      return `当前 Prometheus 版本 ${selectedPrometheusVersion} 暂无 PromQL 巡检项，以下为通用巡检项。`;
    }
    return "Prometheus 版本仅影响 PromQL 巡检项，命令行/其他类型始终可用。";
  }, [
    filteredCommonItems.length,
    filteredPromqlItems.length,
    selectedPrometheusVersion,
  ]);
  const promqlCountLabel = `PromQL 巡检项（${selectedPrometheusVersion}）${filteredPromqlItems.length} 条`;
  const commonCountLabel = `通用巡检项 ${filteredCommonItems.length} 条`;

  const statusMeta = useMemo(() => {
    if (!cluster) {
      return clusterStatusMeta.unknown;
    }
    return getClusterStatusMeta(cluster.connection_status);
  }, [cluster]);
  const clusterSlug = useMemo(
    () =>
      cluster
        ? getClusterDisplayId(clusterDisplayIds, cluster.id, cluster)
        : null,
    [cluster, clusterDisplayIds]
  );
  const healthMessage =
    cluster?.agent_health_message?.trim() || null;
  const handleViewNodes = useCallback(() => {
    if (!clusterSlug) {
      return;
    }
    navigate(`/clusters/${clusterSlug}/nodes`);
  }, [clusterSlug, navigate]);
  const isTesting = enableServerConnectionTest
    ? Boolean(cluster && testingClusterIds[cluster.id])
    : false;
  const filteredInspectionItemIdSet = useMemo(
    () => new Set(filteredInspectionItems.map((item) => item.id)),
    [filteredInspectionItems]
  );
  const selectedFilteredItemsCount = useMemo(
    () => selectedIds.filter((id) => filteredInspectionItemIdSet.has(id)).length,
    [filteredInspectionItemIdSet, selectedIds]
  );
  const allItemsSelected =
    filteredInspectionItems.length > 0 &&
    filteredInspectionItems.every((item) => selectedIds.includes(item.id));

  const handleToggleItem = useCallback(
    (itemId: number) => {
      if (!canRunInspections) {
        return;
      }
      setSelectedIds((prev) =>
        prev.includes(itemId)
          ? prev.filter((id) => id !== itemId)
          : [...prev, itemId]
      );
    },
    [setSelectedIds, canRunInspections]
  );

  const handleToggleAllItems = useCallback(() => {
    setSelectedIds((prev) => {
      if (!canRunInspections || filteredInspectionItems.length === 0) {
        return prev;
      }
      const next = new Set(prev);
      const allFilteredSelected = filteredInspectionItems.every((item) =>
        next.has(item.id)
      );
      if (allFilteredSelected) {
        filteredInspectionItems.forEach((item) => next.delete(item.id));
        return Array.from(next);
      }
      filteredInspectionItems.forEach((item) => next.add(item.id));
      return Array.from(next);
    });
  }, [filteredInspectionItems, setSelectedIds, canRunInspections]);

  const handleToggleRunSelection = useCallback(
    (runId: number) => {
      if (!canRunInspections || !canDeleteHistory) {
        return;
      }
      setSelectedRunIds((prev) =>
        prev.includes(runId)
          ? prev.filter((id) => id !== runId)
          : [...prev, runId]
      );
    },
    [canRunInspections, canDeleteHistory]
  );

  const handleToggleAllRuns = useCallback(() => {
    setSelectedRunIds((prev) => {
      if (
        !canRunInspections ||
        !canDeleteHistory ||
        pagedClusterRuns.length === 0
      ) {
        return prev;
      }
      const visibleIds = pagedClusterRuns.map((run) => run.id);
      const allVisibleSelected = visibleIds.every((id) =>
        prev.includes(id)
      );
      if (allVisibleSelected) {
        return prev.filter((id) => !visibleIds.includes(id));
      }
      const merged = new Set(prev);
      visibleIds.forEach((id) => merged.add(id));
      return Array.from(merged);
    });
  }, [pagedClusterRuns, canRunInspections, canDeleteHistory]);

  const handleDeleteSelectedRuns = useCallback(() => {
    if (!canRunInspections || !canDeleteHistory) {
      return;
    }
    if (selectedRunIds.length === 0) {
      return;
    }
    const targetIds = selectedRunIds.filter((id) =>
      clusterRuns.some((run) => run.id === id)
    );
    if (targetIds.length === 0) {
      return;
    }
    void onDeleteRunsBulk(targetIds);
  }, [
    clusterRuns,
    onDeleteRunsBulk,
    selectedRunIds,
    canRunInspections,
    canDeleteHistory,
  ]);

  const handleStart = useCallback(() => {
    if (!cluster) {
      return;
    }
    if (!canRunInspections) {
      return;
    }
    void onStartInspection(
      cluster.id,
      normalizePrometheusVersion(prometheusVersion, prometheusVersionOptions)
    );
  }, [
    cluster,
    onStartInspection,
    prometheusVersion,
    prometheusVersionOptions,
    canRunInspections,
  ]);

  const handleClusterRunPageChange = useCallback(
    (offset: number) => {
      setClusterRunPage((prev) => {
        const next = prev + offset;
        if (next < 1) {
          return 1;
        }
        if (next > totalClusterRunPages) {
          return totalClusterRunPages;
        }
        return next;
      });
    },
    [totalClusterRunPages]
  );

  const handleClusterRunPageJump = useCallback(() => {
    const trimmed = clusterRunPageInput.trim();
    if (!trimmed) {
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isNaN(parsed) && Number.isInteger(parsed)) {
      const target = Math.min(Math.max(parsed, 1), totalClusterRunPages);
      setClusterRunPage(target);
    }
    setClusterRunPageInput("");
  }, [clusterRunPageInput, totalClusterRunPages]);

  const handleInspectionPageChange = useCallback(
    (offset: number) => {
      setItemPage((prev) => {
        const next = prev + offset;
        if (next < 1) {
          return 1;
        }
        if (next > totalInspectionPages) {
          return totalInspectionPages;
        }
        return next;
      });
    },
    [totalInspectionPages]
  );

  const handleInspectionPageJump = useCallback(() => {
    const trimmed = itemPageInput.trim();
    if (!trimmed) {
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isNaN(parsed) && Number.isInteger(parsed)) {
      const target = Math.min(Math.max(parsed, 1), totalInspectionPages);
      setItemPage(target);
    }
    setItemPageInput("");
  }, [itemPageInput, totalInspectionPages]);
  let detailContent: ReactNode;

  if (!clusterKey || resolvedClusterId === null) {
    detailContent = (
      <div className="detail-empty">
        <p>未找到对应的集群标识。</p>
        <Link
          to="/"
          className="back-button"
          onClick={handleBackToPreviousPage}
        >
          返回上一页
        </Link>
      </div>
    );
  } else if (!cluster) {
    detailContent = (
      <div className="detail-empty">
        <p>该集群暂不可用或已被删除。</p>
        <Link
          to="/"
          className="back-button"
          onClick={handleBackToPreviousPage}
        >
          返回上一页
        </Link>
      </div>
    );
  } else {
    detailContent = (
      <>
        <div className="detail-header">
          <Link
            to="/"
            className="back-button"
            onClick={handleBackToPreviousPage}
          >
            返回上一页
          </Link>
        <div className="detail-header-actions">
          <button
            type="button"
            className="secondary"
            onClick={handleViewNodes}
          >
            节点
          </button>
          {enableServerConnectionTest && canTestClusterAgents && (
            <button
              type="button"
              className="secondary"
              onClick={() => void onTestClusterConnection(cluster.id)}
              disabled={isTesting || !canTestClusters}
            >
              {isTesting ? "测试中..." : "连接测试"}
            </button>
          )}
          {canEditClusters && (
            <button
              type="button"
              className="secondary"
              onClick={() => onEditCluster(cluster)}
            >
              编辑集群
            </button>
          )}
          {canRemoveClusters && (
            <button
              type="button"
              className="secondary danger"
              onClick={() => void onDeleteCluster(cluster)}
            >
              删除集群
            </button>
          )}
        </div>
      </div>

      <section className="detail-grid">
        <div className="detail-card">
          <div className="detail-card-header">
            <h2>{cluster.name}</h2>
            <span className="cluster-id-badge">{clusterSlug}</span>
          </div>
          <div className="cluster-summary">
            <div>
              <strong>连接状态：</strong>
              <span className={`status-chip ${statusMeta.className}`}>
                {statusMeta.label}
              </span>
            </div>
            {healthMessage && (
              <div className="cluster-health-message">
                {healthMessage}
              </div>
            )}
            {cluster.description && cluster.description.trim().length > 0 && (
              <div>
                <strong>描述：</strong>
                {cluster.description}
              </div>
            )}
            <div>
              <strong>最近校验：</strong>
              {cluster.last_checked_at
                ? formatDate(cluster.last_checked_at)
                : "未校验"}
            </div>
            <div>
              <strong>Prometheus：</strong>
              {cluster.prometheus_url || "未配置"}
            </div>
            <div>
              <strong>Kubernetes 版本：</strong>
              {cluster.kubernetes_version || "未知"}
            </div>
            <div>
              <strong>节点数量：</strong>
              {typeof cluster.node_count === "number"
                ? cluster.node_count
                : "未知"}
            </div>
            <div>
              <strong>创建时间：</strong>
              {formatDate(cluster.created_at)}
            </div>
            <div>
              <strong>更新时间：</strong>
              {formatDate(cluster.updated_at)}
            </div>
          </div>
        </div>

        <div className="detail-card">
          <h2>执行巡检</h2>
          <label htmlFor={operatorInputId} className="operator-inline">
            巡检人
            <input
              id={operatorInputId}
              placeholder="输入巡检人姓名（可选）"
              value={operator}
              onChange={(event) => setOperator(event.target.value)}
              disabled={!canRunInspections}
            />
          </label>
          <label
            htmlFor={prometheusVersionInputId}
            className="operator-inline"
          >
            Prometheus 版本
            <select
              id={prometheusVersionInputId}
              value={prometheusVersion}
              onChange={(event) => setPrometheusVersion(event.target.value)}
              disabled={!canRunInspections}
            >
              {prometheusVersionOptions.map((version) => (
                <option key={version} value={version}>
                  {version}
                </option>
              ))}
            </select>
          </label>
          <div className="inspection-items-toolbar">
            <span className="selection-hint">
              已选择 {selectedFilteredItemsCount} / {filteredInspectionItems.length} 个巡检项
            </span>
            <div className="inspection-items-toolbar-actions">
              <input
                type="text"
                className="inspection-items-filter"
                value={itemKeyword}
                onChange={(event) => setItemKeyword(event.target.value)}
                placeholder="关键字筛选"
                disabled={!canRunInspections}
              />
              {canCreateHistory && (
                <button
                  type="button"
                  className="secondary"
                  onClick={handleToggleAllItems}
                  disabled={!canRunInspections}
                >
                  {allItemsSelected ? "清除选择" : "全选"}
                </button>
              )}
              {canCreateHistory && (
                <button
                  type="button"
                  className="primary"
                  onClick={handleStart}
                  disabled={
                    inspectionLoading ||
                    selectedIds.length === 0 ||
                    !canRunInspections
                  }
                >
                  {inspectionLoading ? "巡检中..." : "开始巡检"}
                </button>
              )}
            </div>
          </div>
          <div className="inspection-version-hint">
            <span className="inspection-version-hint-text">{versionHint}</span>
            <span className="inspection-version-counts">
              {promqlCountLabel} · {commonCountLabel}
            </span>
          </div>
          {items.length === 0 ? (
            <ul className="item-list">
              <li className="placeholder">暂无巡检项，请在设置中添加。</li>
            </ul>
          ) : filteredInspectionItems.length === 0 ? (
            <ul className="item-list">
              <li className="placeholder">未找到匹配的巡检项。</li>
            </ul>
          ) : (
            <>
              {pagedPromqlItems.length > 0 && (
                <div className="inspection-item-group">
                  <div className="inspection-item-group-title">
                    <span className="inspection-group-title-text">PromQL 巡检项</span>
                    <span className="group-count">
                      {filteredPromqlItems.length} 条
                    </span>
                  </div>
                  <ul className="item-list">
                    {pagedPromqlItems.map((item) => (
                      <li key={item.id}>
                        <label>
                          <input
                            type="checkbox"
                            checked={selectedIds.includes(item.id)}
                            onChange={() => handleToggleItem(item.id)}
                            disabled={!canRunInspections}
                          />
                          <div>
                            <div className="item-title-row">
                              <div className="item-name">{item.name}</div>
                              <span className="item-tag promql">
                                PromQL · {normalizePrometheusVersion(
                                  item.prometheus_version,
                                  prometheusVersionOptions
                                )}
                              </span>
                            </div>
                            <div className="item-desc">
                              {item.description || "未提供描述"}
                            </div>
                          </div>
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {pagedCommonItems.length > 0 && (
                <div className="inspection-item-group">
                  <div className="inspection-item-group-title">
                    <span className="inspection-group-title-text">通用巡检项</span>
                    <span className="group-count">
                      {filteredCommonItems.length} 条
                    </span>
                  </div>
                  <ul className="item-list">
                    {pagedCommonItems.map((item) => (
                      <li key={item.id}>
                        <label>
                          <input
                            type="checkbox"
                            checked={selectedIds.includes(item.id)}
                            onChange={() => handleToggleItem(item.id)}
                            disabled={!canRunInspections}
                          />
                          <div>
                            <div className="item-title-row">
                              <div className="item-name">{item.name}</div>
                              <span className="item-tag neutral">通用</span>
                            </div>
                            <div className="item-desc">
                              {item.description || "未提供描述"}
                            </div>
                          </div>
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="history-pagination-controls inspection-items-pagination">
                <label className="page-size-control">
                  每页
                  <select
                    value={itemPageSize}
                    onChange={(event) =>
                      setItemPageSize(Number(event.target.value))
                    }
                  >
                    {CLUSTER_ITEM_PAGE_SIZE_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="history-pagination-buttons">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => handleInspectionPageChange(-1)}
                    disabled={itemPage <= 1}
                  >
                    上一页
                  </button>
                  <span>
                    第 {itemPage} / {totalInspectionPages} 页
                  </span>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => handleInspectionPageChange(1)}
                    disabled={itemPage >= totalInspectionPages}
                  >
                    下一页
                  </button>
                </div>
                <label className="history-page-jump">
                  跳转
                  <input
                    type="number"
                    min={1}
                    value={itemPageInput}
                    onChange={(event) => setItemPageInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        handleInspectionPageJump();
                      }
                    }}
                  />
                </label>
                <button
                  type="button"
                  className="secondary"
                  onClick={handleInspectionPageJump}
                >
                  确定
                </button>
              </div>
            </>
          )}
          {!license.canRunInspections && (
            <div className="feedback warning">
              {license.reason ?? "当前 License 不支持发起巡检。"}
            </div>
          )}
          {inspectionLoading && (
            <div className="feedback info">正在创建巡检任务...</div>
          )}
        </div>
      </section>

      <section className="card history">
        <div className="card-header">
          <h2>{cluster.name} · 巡检记录</h2>
          <div className="card-actions">
            {canDeleteHistory && (
              <>
                <label className="table-checkbox">
                  <input
                    type="checkbox"
                    checked={
                      pagedClusterRuns.length > 0 &&
                      pagedClusterRuns.every((run) =>
                        selectedRunIds.includes(run.id)
                      )
                    }
                    onChange={handleToggleAllRuns}
                    disabled={!canRunInspections}
                  />
                  <span>全选</span>
                </label>
                <span className="selection-hint">
                  已选 {selectedRunIds.filter((id) =>
                    clusterRuns.some((run) => run.id === id)
                  ).length}{" "}
                  / {clusterRuns.length}
                </span>
                <button
                  type="button"
                  className="secondary danger"
                  onClick={handleDeleteSelectedRuns}
                  disabled={selectedRunIds.length === 0 || !canRunInspections}
                >
                  删除所选
                </button>
              </>
            )}
          </div>
        </div>
        <div className="table-wrapper">
          {clusterRuns.length === 0 ? (
            <div className="placeholder">暂无巡检记录</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>巡检编号</th>
                  <th>巡检人</th>
                  <th>状态</th>
                  <th>Agent 状态</th>
                  <th>开始时间</th>
                  <th>结束时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {pagedClusterRuns.map((run) => {
                  const isSelected = selectedRunIds.includes(run.id);
                  const runSlug = runDisplayIds[run.id] ?? `#${run.id}`;
                  const canDelete = run.status !== "running";
                  return (
                    <tr key={run.id}>
                      <td>
                        {canDeleteHistory ? (
                          <label className="table-checkbox">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => handleToggleRunSelection(run.id)}
                              disabled={!canRunInspections}
                            />
                            <span>{runSlug}</span>
                          </label>
                        ) : (
                          <span>{runSlug}</span>
                        )}
                      </td>
                      <td>{run.operator || "-"}</td>
                      <td>
                        {renderRunStatusBadge(
                          run.status,
                          run.status_label ?? run.status,
                          run.progress
                        )}
                      </td>
                      <td>
                        {run.executor === "agent" && run.agent_status ? (
                          <span
                            className={agentStatusClassName(run.agent_status)}
                          >
                            {run.agent_status_label ??
                              describeAgentStatus(run.agent_status)}
                          </span>
                        ) : (
                          "-"
                        )}
                      </td>
                      <td>{formatDate(run.created_at)}</td>
                      <td>{formatDate(run.completed_at)}</td>
                      <td className="actions">
                        <button
                          type="button"
                          className="link-button"
                          onClick={() =>
                            navigate(
                              `/clusters/${clusterSlug}/runs/${runSlug}`
                            )
                          }
                        >
                          查看详情
                        </button>
                        {run.report_path && canDownloadReports && (
                          <>
                            <a
                              className="link-button"
                              href={getReportDownloadUrl(run.id, "pdf")}
                              target="_blank"
                              rel="noreferrer"
                            >
                              下载 PDF
                            </a>
                            <a
                              className="link-button"
                              href={getReportDownloadUrl(run.id, "md")}
                              target="_blank"
                              rel="noreferrer"
                            >
                              下载 MD
                            </a>
                          </>
                        )}
                        {run.status === "running" && canUpdateHistory && (
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => void onPauseRun(run)}
                            disabled={!canRunInspections}
                          >
                            暂停
                          </button>
                        )}
                        {run.status === "paused" && canUpdateHistory && (
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => void onResumeRun(run)}
                            disabled={!canRunInspections}
                          >
                            继续
                          </button>
                        )}
                        {(run.status === "running" ||
                          run.status === "paused") &&
                          canUpdateHistory && (
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => void onCancelRun(run)}
                            disabled={!canRunInspections}
                          >
                            取消
                          </button>
                        )}
                        {canDeleteHistory && (
                          <button
                            type="button"
                            className="link-button danger"
                            onClick={() => void onDeleteRun(run)}
                            disabled={!canDelete || !canRunInspections}
                          >
                            删除
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        {clusterRuns.length > 0 && (
          <div className="history-pagination-controls cluster-runs-pagination">
            <label className="page-size-control">
              每页
              <select
                value={clusterRunPageSize}
                onChange={(event) =>
                  setClusterRunPageSize(Number(event.target.value))
                }
              >
                {RUN_PAGE_SIZE_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <div className="history-pagination-buttons">
              <button
                type="button"
                className="secondary"
                onClick={() => handleClusterRunPageChange(-1)}
                disabled={clusterRunPage <= 1}
              >
                上一页
              </button>
              <span>
                第 {clusterRunPage} / {totalClusterRunPages} 页
              </span>
              <button
                type="button"
                className="secondary"
                onClick={() => handleClusterRunPageChange(1)}
                disabled={clusterRunPage >= totalClusterRunPages}
              >
                下一页
              </button>
            </div>
            <label className="history-page-jump">
              跳转
              <input
                type="number"
                min={1}
                value={clusterRunPageInput}
                onChange={(event) => setClusterRunPageInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    handleClusterRunPageJump();
                  }
                }}
              />
            </label>
            <button
              type="button"
              className="secondary"
              onClick={handleClusterRunPageJump}
            >
              确定
            </button>
          </div>
        )}
      </section>
      </>
    );
  }

  return detailContent;
};

interface SettingsOverviewPanelProps {
  onOpenInspection: () => void;
  onOpenLicense: () => void;
  license: LicenseCapabilities;
  canOpenInspection: boolean;
  canOpenLicense: boolean;
}

const splitBrandingText = (value: string): [string, string] => {
  const trimmed = value.trim();
  if (!trimmed) {
    return ["", ""];
  }
  if (!/\s/.test(trimmed)) {
    if (trimmed.length <= 4) {
      return [trimmed, ""];
    }
    const midpoint = Math.ceil(trimmed.length / 2);
    return [trimmed.slice(0, midpoint), trimmed.slice(midpoint)];
  }
  const [firstWord, ...restWords] = trimmed.split(/\s+/);
  return [firstWord, restWords.join(" ")];
};

const SettingsOverviewPanel = ({
  onOpenInspection,
  onOpenLicense,
  license,
  canOpenInspection,
  canOpenLicense,
}: SettingsOverviewPanelProps) => {
  const brandingText =
    appConfig.branding.logoText?.trim() || "Kubernetes 巡检中心";
  const [brandingPrimary, brandingSecondary] = splitBrandingText(brandingText);
  const featureList = Array.from(
    new Set(
      (license.features ?? [])
        .map((feature) => feature.trim())
        .filter((feature) => feature.length > 0)
    )
  );
  const licenseStatus = license.status;
  const licenseStatusLabel = license.valid ? "已激活" : "未激活";
  const licenseStatusClass = license.valid ? "success" : "danger";
  const licenseHint =
    license.reason?.trim() ??
    (license.valid ? "License 已全部启用" : "请上传有效 License 文件");
  const statusRows: Array<{ label: string; value: string }> = [
    { label: "授权对象", value: licenseStatus?.licensee?.trim() || "未填写" },
    { label: "产品", value: licenseStatus?.product?.trim() || "未填写" },
    { label: "生效时间", value: formatDate(licenseStatus?.not_before) },
    { label: "到期时间", value: formatDate(licenseStatus?.expires_at) },
  ];
  if (licenseStatus?.issued_at) {
    statusRows.splice(2, 0, {
      label: "签发时间",
      value: formatDate(licenseStatus.issued_at),
    });
  }

  return (
    <div className="settings-overview">
      <div className="settings-overview-card">
        <div className="settings-overview-headline">
          {appConfig.branding.logoUrl ? (
            <img
              src={appConfig.branding.logoUrl}
              alt="品牌 Logo"
              className="settings-branding-logo"
            />
          ) : (
            <div
              className="settings-branding-name"
              aria-label={brandingText}
              role="img"
            >
              <span>{brandingPrimary}</span>
              {brandingSecondary && <span>{brandingSecondary}</span>}
            </div>
          )}
          <div className="settings-branding-copy">
            <h3>{brandingText}</h3>
          </div>
        </div>
        <div className="settings-overview-status">
          <span className={`status-pill ${licenseStatusClass}`}>
            {licenseStatusLabel}
          </span>
          {licenseHint && (
            <span className="settings-overview-hint">{licenseHint}</span>
          )}
        </div>
        <div className="settings-overview-list">
          <strong>已启用特性</strong>
          {featureList.length === 0 ? (
            <span className="settings-overview-hint">暂无启用功能</span>
          ) : (
            <div className="chip-group settings-overview-badges">
              {featureList.map((feature) => (
                <span key={feature} className="chip">
                  {feature}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="settings-overview-actions">
          <button
            type="button"
            className="primary"
            onClick={onOpenInspection}
            disabled={!canOpenInspection}
          >
            管理巡检项
          </button>
          <button
            type="button"
            className="secondary"
            onClick={onOpenLicense}
            disabled={!canOpenLicense}
          >
            查看 License
          </button>
        </div>
      </div>
      <div className="settings-overview-card">
        <div className="settings-overview-card-head">
          <h4>License 信息</h4>
          {licenseStatus?.expires_at && (
            <span className="settings-overview-hint">
              有效期至 {formatDate(licenseStatus.expires_at)}
            </span>
          )}
        </div>
        <div className="settings-overview-table">
          <table>
            <tbody>
              {statusRows.map((row) => (
                <tr key={row.label}>
                  <th>{row.label}</th>
                  <td>{row.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

interface InspectionSettingsPanelProps {
  items: InspectionItem[];
  prometheusVersionOptions: string[];
  submitting: boolean;
  notice: string | null;
  error: string | null;
  license: LicenseCapabilities;
  canManage: boolean;
  onClose: () => void;
  onSave: (payload: {
    id?: number;
    name: string;
    description?: string;
    check_type: string;
    prometheus_version?: string;
    config: Record<string, unknown>;
  }) => Promise<void>;
  onDelete: (item: InspectionItem) => void;
  onDeleteMany: (ids: number[]) => void;
  onExport: (format: "json" | "yaml") => Promise<void> | void;
  onImport: (file: File) => Promise<void>;
}

const InspectionSettingsPanel = ({
  items,
  prometheusVersionOptions,
  submitting,
  notice,
  error,
  license,
  canManage,
  onClose,
  onSave,
  onDelete,
  onDeleteMany,
  onExport,
  onImport,
}: InspectionSettingsPanelProps) => {
  const readOnly = !license.canRunInspections || !canManage;
  const readOnlyMessage = !license.canRunInspections
    ? license.reason ?? "当前 License 不支持巡检项管理。"
    : "当前账号无巡检项管理权限。";
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [editingItem, setEditingItem] = useState<InspectionItem | null>(null);
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formTypeMode, setFormTypeMode] = useState<
    "command" | "promql" | "other"
  >("other");
  const [prometheusVersion, setPrometheusVersion] = useState(
    DEFAULT_PROMETHEUS_VERSION
  );
  const [customCheckType, setCustomCheckType] = useState("custom");
  const [commandText, setCommandText] = useState("");
  const [commandSuggestion, setCommandSuggestion] = useState("");
  const [promqlExpression, setPromqlExpression] = useState("");
  const [promqlComparison, setPromqlComparison] = useState(">=");
  const [promqlSeverity, setPromqlSeverity] = useState<
    "warning" | "critical"
  >("warning");
  const [promqlThreshold, setPromqlThreshold] = useState("");
  const [promqlDescribe, setPromqlDescribe] = useState("");
  const [configText, setConfigText] = useState("{}");
  const [formError, setFormError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [itemFilterType, setItemFilterType] = useState<
    "all" | "command" | "promql" | "other"
  >("all");
  const [itemFilterVersion, setItemFilterVersion] = useState<string>("all");
  const [pageSize, setPageSize] = useState(20);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("");

  useEffect(() => {
    if (!editingItem) {
      setFormName("");
      setFormDescription("");
      setFormTypeMode("other");
      setPrometheusVersion(DEFAULT_PROMETHEUS_VERSION);
      setCustomCheckType("custom");
      setCommandText("");
      setPromqlExpression("");
      setPromqlComparison(">=");
      setPromqlSeverity("warning");
      setPromqlThreshold("");
      setPromqlDescribe("");
      setConfigText("{}");
      setFormError(null);
    }
  }, [editingItem]);

  const startEdit = (item: InspectionItem) => {
    setEditingItem(item);
    setFormName(item.name ?? "");
    setFormDescription(item.description ?? "");
    const rawType = (item.check_type ?? "custom").trim();
    if (isPromqlType(rawType)) {
      setPrometheusVersion(
        normalizePrometheusVersion(
          item.prometheus_version,
          prometheusVersionOptions
        )
      );
    } else {
      setPrometheusVersion(DEFAULT_PROMETHEUS_VERSION);
    }
    const config =
      item.config && typeof item.config === "object" ? item.config : {};
    setConfigText(JSON.stringify(config, null, 2));
    if (rawType === "command") {
      setFormTypeMode("command");
      setCustomCheckType("custom");
      const commandValue = config.command;
      if (Array.isArray(commandValue)) {
        setCommandText(commandValue.map(String).join(" "));
      } else if (commandValue) {
        setCommandText(String(commandValue));
      } else {
        setCommandText("");
      }
      setCommandSuggestion(
        String(
          config.suggestion_on_fail ?? config.suggestion_on_success ?? ""
        )
      );
    } else if (rawType === "promql") {
      setFormTypeMode("promql");
      setCustomCheckType("custom");
      setPromqlExpression(String(config.expression ?? ""));
      const comparisonRaw = String(config.comparison ?? ">=");
      setPromqlComparison(comparisonRaw === "=" ? "==" : comparisonRaw);
      const hasCriticalThreshold =
        config.critical_threshold !== null &&
        config.critical_threshold !== undefined;
      const hasCriticalSuggestion = Boolean(
        String(config.suggestion_on_critical ?? "").trim()
      );
      const resolvedSeverity =
        hasCriticalThreshold || hasCriticalSuggestion ? "critical" : "warning";
      setPromqlSeverity(resolvedSeverity);
      setPromqlDescribe(
        String(
          resolvedSeverity === "critical"
            ? config.suggestion_on_critical ?? config.suggestion_on_warn ?? ""
            : config.suggestion_on_warn ?? ""
        )
      );
      const threshold =
        resolvedSeverity === "critical"
          ? config.critical_threshold ?? config.fail_threshold ?? ""
          : config.warn_threshold ?? "";
      setPromqlThreshold(
        threshold === null || threshold === undefined ? "" : String(threshold)
      );
    } else {
      setFormTypeMode("other");
      setCustomCheckType(rawType || "custom");
      setCommandText("");
      setPromqlExpression("");
      setPromqlComparison(">=");
      setPromqlSeverity("warning");
      setPromqlThreshold("");
      setPromqlDescribe("");
    }
    setFormError(null);
  };

  const resetForm = () => {
    setEditingItem(null);
    setFormName("");
    setFormDescription("");
    setFormTypeMode("other");
    setPrometheusVersion(DEFAULT_PROMETHEUS_VERSION);
    setCustomCheckType("custom");
    setCommandText("");
    setCommandSuggestion("");
    setPromqlExpression("");
    setPromqlComparison(">=");
    setPromqlSeverity("warning");
    setPromqlThreshold("");
    setPromqlDescribe("");
    setConfigText("{}");
    setFormError(null);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (readOnly) {
      setFormError(
        license.reason ?? "当前 License 不支持巡检项管理。"
      );
      return;
    }
    if (!formName.trim()) {
      setFormError("巡检项名称不能为空");
      return;
    }
    const resolvedCheckType =
      formTypeMode === "command"
        ? "command"
        : formTypeMode === "promql"
          ? "promql"
          : customCheckType.trim() || "custom";
    const resolvedPrometheusVersion =
      resolvedCheckType === "promql"
        ? normalizePrometheusVersion(
            prometheusVersion,
            prometheusVersionOptions
          )
        : undefined;
    if (formTypeMode === "other" && !customCheckType.trim()) {
      setFormError("请输入自定义类型名称");
      return;
    }
    const baseConfig =
      editingItem &&
      editingItem.check_type === resolvedCheckType &&
      editingItem.config &&
      typeof editingItem.config === "object"
        ? editingItem.config
        : {};
    let parsedConfig: Record<string, unknown> = {};
    if (formTypeMode === "command") {
      if (!commandText.trim()) {
        setFormError("命令不能为空");
        return;
      }
      parsedConfig = {
        ...baseConfig,
        command: commandText.trim(),
      };
      delete parsedConfig.suggestion_on_fail;
      delete parsedConfig.suggestion_on_success;
      if (commandSuggestion.trim()) {
        parsedConfig.suggestion_on_fail = commandSuggestion.trim();
        parsedConfig.suggestion_on_success = commandSuggestion.trim();
      }
    } else if (formTypeMode === "promql") {
      if (!promqlExpression.trim()) {
        setFormError("PromQL 表达式不能为空");
        return;
      }
      const severityLabel = promqlSeverity === "critical" ? "严重" : "告警";
      const thresholdText = promqlThreshold.trim();
      let thresholdValue: number | undefined;
      if (thresholdText) {
        const parsedValue = Number(thresholdText);
        if (Number.isNaN(parsedValue)) {
          setFormError(`${severityLabel}阈值必须为数字`);
          return;
        }
        thresholdValue = parsedValue;
      }
      parsedConfig = {
        ...baseConfig,
        expression: promqlExpression.trim(),
        comparison: promqlComparison || ">=",
      };
      delete parsedConfig.warn_threshold;
      delete parsedConfig.critical_threshold;
      delete parsedConfig.fail_threshold;
      delete parsedConfig.suggestion_on_warn;
      delete parsedConfig.suggestion_on_critical;
      if (thresholdValue !== undefined) {
        if (promqlSeverity === "critical") {
          parsedConfig.critical_threshold = thresholdValue;
        } else {
          parsedConfig.warn_threshold = thresholdValue;
        }
      }
      if (promqlDescribe.trim()) {
        if (promqlSeverity === "critical") {
          parsedConfig.suggestion_on_critical = promqlDescribe.trim();
        } else {
          parsedConfig.suggestion_on_warn = promqlDescribe.trim();
        }
      }
    } else {
      if (configText.trim()) {
        try {
          parsedConfig = JSON.parse(configText);
        } catch (err) {
          setFormError("Config 必须是合法的 JSON");
          return;
        }
      }
    }
    setFormError(null);
    await onSave({
      id: editingItem?.id,
      name: formName.trim(),
      description: formDescription.trim() || undefined,
      check_type: resolvedCheckType,
      prometheus_version: resolvedPrometheusVersion,
      config: parsedConfig,
    });
    resetForm();
  };


  const toggleSelection = (id: number) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((itemId) => itemId !== id) : [...prev, id]
    );
  };

  const sortedItems = useMemo(
    () => items.slice().sort(compareInspectionItemByName),
    [items]
  );
  const filteredItems = useMemo(() => {
    const shouldFilterByVersion =
      itemFilterType === "promql" && itemFilterVersion !== "all";
    const versionFilter = shouldFilterByVersion
      ? normalizePrometheusVersion(
          itemFilterVersion,
          prometheusVersionOptions
        )
      : null;
    let nextItems = sortedItems.filter(
      (item) => !isRancherLocalType(item.check_type)
    );
    if (versionFilter) {
      nextItems = nextItems.filter(
        (item) =>
          isPromqlType(item.check_type) &&
          normalizePrometheusVersion(
            item.prometheus_version,
            prometheusVersionOptions
          ) === versionFilter
      );
    }
    if (itemFilterType === "all") {
      return nextItems;
    }
    if (itemFilterType === "command") {
      return nextItems.filter((item) => item.check_type === "command");
    }
    if (itemFilterType === "promql") {
      return nextItems.filter((item) => item.check_type === "promql");
    }
    return nextItems.filter(
      (item) => item.check_type !== "command" && item.check_type !== "promql"
    );
  }, [itemFilterType, itemFilterVersion, sortedItems]);

  const filteredItemIdSet = useMemo(
    () => new Set(filteredItems.map((item) => item.id)),
    [filteredItems]
  );
  const selectedFilteredCount = useMemo(
    () => selectedIds.filter((id) => filteredItemIdSet.has(id)).length,
    [filteredItemIdSet, selectedIds]
  );

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      if (filteredItems.length === 0) {
        return prev;
      }
      const next = new Set(prev);
      const allFilteredSelected = filteredItems.every((item) =>
        next.has(item.id)
      );
      if (allFilteredSelected) {
        filteredItems.forEach((item) => next.delete(item.id));
        return Array.from(next);
      }
      filteredItems.forEach((item) => next.add(item.id));
      return Array.from(next);
    });
  };

  const handleDeleteSelected = () => {
    const targetIds = selectedIds.filter((id) => filteredItemIdSet.has(id));
    if (targetIds.length === 0) {
      return;
    }
    onDeleteMany(targetIds);
  };

  const handleImportClick = () => {
    importInputRef.current?.click();
  };

  const handleImportChange = async (
    event: ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) {
      return;
    }
    await onImport(file);
  };

  useEffect(() => {
    setSelectedIds((prev) =>
      prev.filter((id) => items.some((item) => item.id === id))
    );
  }, [items]);
  const totalItems = filteredItems.length;
  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(totalItems / Math.max(1, pageSize))),
    [pageSize, totalItems]
  );
  const pagedItems = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredItems.slice(start, start + pageSize);
  }, [filteredItems, page, pageSize]);

  useEffect(() => {
    setPage(1);
    setPageInput("");
  }, [pageSize, totalItems]);

  useEffect(() => {
    setPage(1);
    setPageInput("");
  }, [itemFilterType, itemFilterVersion]);

  useEffect(() => {
    if (itemFilterType !== "promql" && itemFilterVersion !== "all") {
      setItemFilterVersion("all");
    }
  }, [itemFilterType, itemFilterVersion]);

  useEffect(() => {
    if (
      itemFilterVersion !== "all" &&
      !prometheusVersionOptions.includes(itemFilterVersion)
    ) {
      setItemFilterVersion("all");
    }
  }, [itemFilterVersion, prometheusVersionOptions]);

  useEffect(() => {
    setPage((prev) => Math.min(Math.max(prev, 1), totalPages));
  }, [totalPages]);

  const handlePageJump = useCallback(() => {
    const trimmed = pageInput.trim();
    if (!trimmed) {
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isNaN(parsed)) {
      setPage(Math.min(Math.max(Math.floor(parsed), 1), totalPages));
    }
    setPageInput("");
  }, [pageInput, totalPages]);

  const currentSummary = editingItem
    ? `正在编辑：${editingItem.name}`
    : "";
  const promqlSeverityLabel = promqlSeverity === "critical" ? "严重" : "告警";
  const showVersionColumn =
    itemFilterType === "all" || itemFilterType === "promql";

  return (
    <div className="inspection-settings-panel">
      <div className="settings-header">
        <div>
          <h3>巡检项管理</h3>
          {currentSummary && <p>{currentSummary}</p>}
        </div>
        <div className="settings-actions">
          <button
            type="button"
            className="secondary"
            onClick={() => onExport("json")}
            disabled={submitting}
          >
            导出 JSON
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => onExport("yaml")}
            disabled={submitting}
          >
            导出 YAML
          </button>
          {!readOnly && (
            <>
              <button
                type="button"
                className="secondary"
                onClick={handleImportClick}
                disabled={submitting}
              >
                导入
              </button>
              <input
                ref={importInputRef}
                type="file"
                accept=".json,.yaml,.yml"
                hidden
                onChange={handleImportChange}
              />
            </>
          )}
        </div>
      </div>
      {notice && <div className="feedback success">{notice}</div>}
      {error && <div className="feedback error">{error}</div>}
      {formError && <div className="feedback error">{formError}</div>}
      {readOnly && (
        <div className="feedback warning">{readOnlyMessage}</div>
      )}
      <div className="inspection-settings-body">
        <section className="inspection-section inspection-section-list">
          <div className="inspection-section-header">
            <div>
              <h4>已有巡检项</h4>
              <span className="inspection-section-hint">
                支持批量选择、导出与删除操作
              </span>
            </div>
            <span className="inspection-section-count">共 {totalItems} 条</span>
          </div>
          <div className="settings-list">
            <div className="settings-list-header">
              <div className="settings-actions">
                {!readOnly && (
                  <>
                    <label className="table-checkbox">
                      <input
                        type="checkbox"
                        checked={
                          filteredItems.length > 0 &&
                          selectedFilteredCount === filteredItems.length
                        }
                        onChange={toggleSelectAll}
                      />
                      <span>全选</span>
                    </label>
                    <span>已选 {selectedFilteredCount} / {totalItems}</span>
                    <button
                      type="button"
                      className="link-button danger"
                      onClick={handleDeleteSelected}
                      disabled={selectedFilteredCount === 0}
                    >
                      删除
                    </button>
                  </>
                )}
                {itemFilterType === "promql" && (
                  <label className="settings-filter">
                    Prometheus 版本
                    <select
                      value={itemFilterVersion}
                      onChange={(event) =>
                        setItemFilterVersion(event.target.value)
                      }
                    >
                      <option value="all">全部</option>
                      {prometheusVersionOptions.map((version) => (
                        <option key={version} value={version}>
                          {version}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="settings-filter">
                  类型
                  <select
                    value={itemFilterType}
                    onChange={(event) =>
                      setItemFilterType(
                        event.target.value as
                          | "all"
                          | "command"
                          | "promql"
                          | "other"
                      )
                    }
                  >
                    <option value="all">全部</option>
                    <option value="command">命令行</option>
                    <option value="promql">PromQL</option>
                    <option value="other">其他</option>
                  </select>
                </label>
              </div>
            </div>
            <div className="table-wrapper">
              {items.length === 0 ? (
                <div className="placeholder">暂无巡检项</div>
              ) : filteredItems.length === 0 ? (
                <div className="placeholder">未找到匹配的巡检项</div>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>名称</th>
                      {showVersionColumn && (
                        <th className="th-nowrap">Prometheus 版本</th>
                      )}
                      <th>类型</th>
                      <th>更新时间</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedItems.map((item) => (
                      <tr key={item.id}>
                        <td>
                          {readOnly ? (
                            <span>{item.name}</span>
                          ) : (
                            <label className="table-checkbox">
                              <input
                                type="checkbox"
                                checked={selectedIds.includes(item.id)}
                                onChange={() => toggleSelection(item.id)}
                              />
                              <span>{item.name}</span>
                            </label>
                          )}
                        </td>
                        {showVersionColumn && (
                          <td>
                            {isPromqlType(item.check_type)
                              ? normalizePrometheusVersion(
                                  item.prometheus_version,
                                  prometheusVersionOptions
                                )
                              : "-"}
                          </td>
                        )}
                        <td>{item.check_type}</td>
                        <td>{formatDate(item.updated_at)}</td>
                        <td className="actions">
                          {!readOnly ? (
                            <>
                              <button
                                type="button"
                                className="link-button"
                                onClick={() => startEdit(item)}
                              >
                                编辑
                              </button>
                              <button
                                type="button"
                                className="link-button danger"
                                onClick={() => onDelete(item)}
                              >
                                删除
                              </button>
                            </>
                          ) : (
                            <span>-</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            {items.length > 0 && (
              <div className="settings-pagination">
                <label className="page-size-control">
                  每页
                  <select
                    value={pageSize}
                    onChange={(event) =>
                      setPageSize(Number(event.target.value))
                    }
                  >
                    {[20, 50, 100].map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="history-pagination-buttons">
                  <button
                    type="button"
                    className="page-button"
                    disabled={page <= 1}
                    onClick={() => setPage((prev) => Math.max(prev - 1, 1))}
                  >
                    上一页
                  </button>
                  <span>
                    第 {page} / {totalPages} 页
                  </span>
                  <button
                    type="button"
                    className="page-button"
                    disabled={page >= totalPages}
                    onClick={() =>
                      setPage((prev) => Math.min(prev + 1, totalPages))
                    }
                  >
                    下一页
                  </button>
                </div>
                <div className="page-jump">
                  跳转
                  <input
                    className="page-jump-input"
                    value={pageInput}
                    onChange={(event) => setPageInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        handlePageJump();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="page-button"
                    onClick={handlePageJump}
                  >
                    确定
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>
        {!readOnly && (
          <section className="inspection-section inspection-section-form">
            <div className="inspection-section-header">
              <div>
                <h4>{editingItem ? "编辑巡检项" : "新增巡检项"}</h4>
                <span className="inspection-section-hint">
                  选择类型后填写配置，保存后立即生效
                </span>
              </div>
            </div>
            <form className="settings-form inspection-form" onSubmit={handleSubmit}>
              <label>
                名称
                <input
                  type="text"
                  value={formName}
                  onChange={(event) => setFormName(event.target.value)}
                  disabled={submitting}
                  placeholder="例如：etcd-health"
                />
              </label>
              {formTypeMode === "promql" && (
                <label>
                  Prometheus 版本
                  <select
                    value={prometheusVersion}
                    onChange={(event) => setPrometheusVersion(event.target.value)}
                    disabled={submitting}
                  >
                    {prometheusVersionOptions.map((version) => (
                      <option key={version} value={version}>
                        {version}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                类型
                <select
                  value={formTypeMode}
                  onChange={(event) =>
                    setFormTypeMode(
                      event.target.value as "command" | "promql" | "other"
                    )
                  }
                  disabled={submitting}
                >
                  <option value="command">命令行</option>
                  <option value="promql">PromQL</option>
                  <option value="other">其他</option>
                </select>
              </label>
              {formTypeMode === "other" && (
                <label>
                  自定义类型
                  <input
                    type="text"
                    value={customCheckType}
                    onChange={(event) => setCustomCheckType(event.target.value)}
                    disabled={submitting}
                    placeholder="custom"
                  />
                </label>
              )}
              <label>
                描述
                <input
                  type="text"
                  value={formDescription}
                  onChange={(event) => setFormDescription(event.target.value)}
                  disabled={submitting}
                  placeholder="可选"
                />
              </label>
              {formTypeMode === "command" && (
                <label>
                  命令
                  <input
                    type="text"
                    value={commandText}
                    onChange={(event) => setCommandText(event.target.value)}
                    disabled={submitting}
                    placeholder="例如：kubectl get nodes"
                  />
                </label>
              )}
              {formTypeMode === "command" && (
                <label>
                  告警建议
                  <textarea
                    value={commandSuggestion}
                    onChange={(event) => setCommandSuggestion(event.target.value)}
                    disabled={submitting}
                    rows={3}
                    placeholder="例如：检查证书是否临近过期"
                  />
                </label>
              )}
              {formTypeMode === "promql" && (
                <>
                  <label>
                    PromQL 表达式
                    <input
                      type="text"
                      value={promqlExpression}
                      onChange={(event) => setPromqlExpression(event.target.value)}
                      disabled={submitting}
                      placeholder="例如：sum(rate(container_cpu_usage_seconds_total[5m]))"
                    />
                  </label>
                  <div className="field-row">
                    <label>
                      严重程度
                      <select
                        value={promqlSeverity}
                        onChange={(event) =>
                          setPromqlSeverity(
                            event.target.value as "warning" | "critical"
                          )
                        }
                        disabled={submitting}
                      >
                        <option value="warning">告警</option>
                        <option value="critical">Critical（严重）</option>
                      </select>
                    </label>
                    <label>
                      比较符
                      <select
                        value={promqlComparison}
                        onChange={(event) =>
                          setPromqlComparison(event.target.value)
                        }
                        disabled={submitting}
                      >
                        {[
                          ">",
                          "<",
                          "=",
                          ">=",
                          "<=",
                          "!=",
                        ].map((symbol) => (
                          <option key={symbol} value={symbol === "=" ? "==" : symbol}>
                            {symbol}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {promqlSeverityLabel}阈值
                      <input
                        type="number"
                        value={promqlThreshold}
                        onChange={(event) => setPromqlThreshold(event.target.value)}
                        disabled={submitting}
                        placeholder="例如：0.8"
                      />
                    </label>
                  </div>
                  <label>
                    {promqlSeverityLabel}建议
                    <textarea
                      value={promqlDescribe}
                      onChange={(event) => setPromqlDescribe(event.target.value)}
                      disabled={submitting}
                      rows={3}
                      placeholder="达到阈值时写入巡检建议，例如：检查集群负载或扩容"
                    />
                  </label>
                </>
              )}
            {formTypeMode === "other" && (
              <label>
                配置 (JSON)
                <textarea
                  value={configText}
                  onChange={(event) => setConfigText(event.target.value)}
                  rows={6}
                  disabled={submitting}
                />
              </label>
            )}
            <div className="settings-actions">
              <button
                type="button"
                className="secondary"
                onClick={resetForm}
                disabled={submitting}
              >
                重置
              </button>
              <button
                type="submit"
                className="primary"
                disabled={submitting}
              >
                {editingItem ? "保存修改" : "新增"}
              </button>
            </div>
            </form>
          </section>
        )}
      </div>
    </div>
  );
};

interface PrometheusVersionSettingsPanelProps {
  items: InspectionItem[];
  versions: string[];
  defaultVersion: string;
  license: LicenseCapabilities;
  canManage: boolean;
  onAddVersion: (value: string) => { ok: boolean; message?: string };
  onDeleteVersion: (value: string) => { ok: boolean; message?: string };
}

const PrometheusVersionSettingsPanel = ({
  items,
  versions,
  defaultVersion,
  license,
  canManage,
  onAddVersion,
  onDeleteVersion,
}: PrometheusVersionSettingsPanelProps) => {
  const readOnly = !license.canRunInspections || !canManage;
  const [versionInput, setVersionInput] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showDeleteControls, setShowDeleteControls] = useState(false);

  const usageMap = useMemo(() => {
    const counts = new Map<string, number>();
    items.forEach((item) => {
      if (!isPromqlType(item.check_type)) {
        return;
      }
      const raw = String(item.prometheus_version ?? defaultVersion).trim();
      const resolved = raw || defaultVersion;
      counts.set(resolved, (counts.get(resolved) ?? 0) + 1);
    });
    return counts;
  }, [items, defaultVersion]);

  const readOnlyMessage = !license.canRunInspections
    ? license.reason ?? "当前 License 不支持版本管理"
    : "当前账号无 Prometheus 版本管理权限";

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (readOnly) {
      setError(readOnlyMessage);
      setNotice(null);
      return;
    }
    const result = onAddVersion(versionInput);
    if (!result.ok) {
      setError(result.message ?? "版本添加失败");
      setNotice(null);
      return;
    }
    setNotice(`已添加版本 ${versionInput.trim()}`);
    setError(null);
    setVersionInput("");
  };

  const handleDelete = (value: string) => {
    if (readOnly) {
      setError(readOnlyMessage);
      setNotice(null);
      return;
    }
    const result = onDeleteVersion(value);
    if (!result.ok) {
      setError(result.message ?? "版本删除失败");
      setNotice(null);
      return;
    }
    setNotice(`已删除版本 ${value}`);
    setError(null);
  };

  useEffect(() => {
    if (!notice || typeof window === "undefined") {
      return;
    }
    const timer = window.setTimeout(() => {
      setNotice(null);
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  return (
    <div className="inspection-settings-panel">
      <div className="settings-header">
        <div>
          <h3>Prometheus 版本管理</h3>
          <p>用于 PromQL 巡检项的版本筛选与显示</p>
        </div>
      </div>
      {readOnly && (
        <div className="feedback warning">
          {readOnlyMessage}
        </div>
      )}
      {notice && <div className="feedback success">{notice}</div>}
      {error && <div className="feedback error">{error}</div>}
      <div className="inspection-settings-body">
        <section className="inspection-section inspection-section-version">
          <div className="inspection-section-header">
            <div>
              <h4>版本配置</h4>
              <span className="inspection-section-hint">
                默认版本用于未填写 Prometheus 版本的 PromQL 巡检项
              </span>
            </div>
            {!readOnly && (
              <div className="inspection-section-actions">
                <button
                  type="button"
                  className="secondary version-manager-toggle"
                  onClick={() => setShowDeleteControls((prev) => !prev)}
                >
                  {showDeleteControls ? "完成" : "编辑删除"}
                </button>
              </div>
            )}
          </div>
          <div className="version-manager">
            <div className="version-manager-row">
              <span className="version-manager-label">当前默认版本</span>
              <span className="chip">{defaultVersion}</span>
              <span className="chip muted">默认</span>
            </div>
            <div className="version-manager-row">
              <span className="version-manager-label">已配置版本</span>
              <div className="chip-group version-manager-list">
                {versions.map((version) => {
                  const isDefault = version === defaultVersion;
                  const usageCount = usageMap.get(version) ?? 0;
                  const canDelete = !isDefault && usageCount === 0;
                  const showUsage = usageCount > 0;
                  return (
                    <span key={version} className="version-chip">
                      <span className={`chip${isDefault ? " muted" : ""}`}>
                        {version}
                      </span>
                      <span className="version-chip-meta">
                        {isDefault && (
                          <span className="version-tag default">默认</span>
                        )}
                        {showUsage && (
                          <span className="version-tag used">
                            使用中
                          </span>
                        )}
                      </span>
                      {showDeleteControls && canDelete && !readOnly && (
                        <button
                          type="button"
                          className="version-remove"
                          onClick={() => handleDelete(version)}
                          aria-label={`删除版本 ${version}`}
                          title="删除版本"
                        >
                          ×
                        </button>
                      )}
                    </span>
                  );
                })}
              </div>
            </div>
            {!readOnly && (
              <form className="version-manager-form" onSubmit={handleSubmit}>
                <label>
                  新增版本
                  <input
                    type="text"
                    value={versionInput}
                    onChange={(event) => {
                      setVersionInput(event.target.value);
                      if (error) {
                        setError(null);
                      }
                    }}
                    placeholder="例如：3.2"
                  />
                </label>
                <button type="submit" className="secondary">
                  添加版本
                </button>
              </form>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};

interface ScheduleSettingsPanelProps {
  schedules: InspectionSchedule[];
  clusters: ClusterConfig[];
  clusterDisplayIds: Record<number, string>;
  items: InspectionItem[];
  prometheusVersionOptions: string[];
  submitting: boolean;
  notice: string | null;
  error: string | null;
  license: LicenseCapabilities;
  canManage: boolean;
  onSave: (payload: {
    id?: number;
    name?: string;
    cron: string;
    clusterIds: number[];
    itemIds: number[];
    isEnabled: boolean;
  }) => Promise<void>;
  onDelete: (schedule: InspectionSchedule) => void;
  onDeleteMany: (scheduleIds: number[]) => void;
  onToggleEnabled: (schedule: InspectionSchedule, enabled: boolean) => void;
}

const ScheduleSettingsPanel = ({
  schedules,
  clusters,
  clusterDisplayIds,
  items,
  prometheusVersionOptions,
  submitting,
  notice,
  error,
  license,
  canManage,
  onSave,
  onDelete,
  onDeleteMany,
  onToggleEnabled,
}: ScheduleSettingsPanelProps) => {
  const readOnly = !license.canRunInspections || !canManage;
  const readOnlyMessage = !license.canRunInspections
    ? license.reason ?? "当前 License 不支持定时巡检。"
    : "当前账号无定时巡检管理权限。";
  const [editingSchedule, setEditingSchedule] =
    useState<InspectionSchedule | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formName, setFormName] = useState("");
  const [cronMinute, setCronMinute] = useState(DEFAULT_SCHEDULE_CRON[0]);
  const [cronHour, setCronHour] = useState(DEFAULT_SCHEDULE_CRON[1]);
  const [cronDay, setCronDay] = useState(DEFAULT_SCHEDULE_CRON[2]);
  const [cronMonth, setCronMonth] = useState(DEFAULT_SCHEDULE_CRON[3]);
  const [cronWeek, setCronWeek] = useState(DEFAULT_SCHEDULE_CRON[4]);
  const [formEnabled, setFormEnabled] = useState(true);
  const [selectedClusterIds, setSelectedClusterIds] = useState<number[]>([]);
  const [selectedItemIds, setSelectedItemIds] = useState<number[]>([]);
  const [clusterKeyword, setClusterKeyword] = useState("");
  const [itemKeyword, setItemKeyword] = useState("");
  const [itemVersionFilter, setItemVersionFilter] = useState("all");
  const [formError, setFormError] = useState<string | null>(null);
  const scheduleFormErrorRef = useRef<HTMLDivElement | null>(null);
  const [scheduleKeyword, setScheduleKeyword] = useState("");
  const [scheduleStatusFilter, setScheduleStatusFilter] = useState<
    "all" | "enabled" | "disabled"
  >("all");
  const [schedulePageSize, setSchedulePageSize] = useState(10);
  const [schedulePage, setSchedulePage] = useState(1);
  const [schedulePageInput, setSchedulePageInput] = useState("");
  const [selectedScheduleIds, setSelectedScheduleIds] = useState<number[]>([]);

  const scheduleClusterMap = useMemo(() => {
    const map = new Map<number, ClusterConfig>();
    clusters.forEach((cluster) => map.set(cluster.id, cluster));
    return map;
  }, [clusters]);
  const availableClusters = useMemo(
    () => clusters.filter((cluster) => cluster.connection_status === "connected"),
    [clusters]
  );
  const availableClusterIdSet = useMemo(
    () => new Set(availableClusters.map((cluster) => cluster.id)),
    [availableClusters]
  );
  const selectedAvailableClusterIds = useMemo(
    () => selectedClusterIds.filter((id) => availableClusterIdSet.has(id)),
    [availableClusterIdSet, selectedClusterIds]
  );
  const scheduleItemMap = useMemo(() => {
    const map = new Map<number, InspectionItem>();
    items.forEach((item) => map.set(item.id, item));
    return map;
  }, [items]);

  const resetForm = useCallback(() => {
    setEditingSchedule(null);
    setFormName("");
    setCronMinute(DEFAULT_SCHEDULE_CRON[0]);
    setCronHour(DEFAULT_SCHEDULE_CRON[1]);
    setCronDay(DEFAULT_SCHEDULE_CRON[2]);
    setCronMonth(DEFAULT_SCHEDULE_CRON[3]);
    setCronWeek(DEFAULT_SCHEDULE_CRON[4]);
    setFormEnabled(true);
    setSelectedClusterIds([]);
    setSelectedItemIds([]);
    setClusterKeyword("");
    setItemKeyword("");
    setItemVersionFilter("all");
    setFormError(null);
  }, []);

  useEffect(() => {
    if (!editingSchedule) {
      resetForm();
      return;
    }
    const parts = editingSchedule.cron.trim().split(/\s+/);
    const resolvedParts =
      parts.length === 5 ? parts : [...DEFAULT_SCHEDULE_CRON];
    setFormName(editingSchedule.name ?? "");
    setCronMinute(resolvedParts[0]);
    setCronHour(resolvedParts[1]);
    setCronDay(resolvedParts[2]);
    setCronMonth(resolvedParts[3]);
    setCronWeek(resolvedParts[4]);
    setFormEnabled(editingSchedule.is_enabled);
    setSelectedClusterIds(editingSchedule.cluster_ids ?? []);
    setSelectedItemIds(editingSchedule.item_ids ?? []);
    setFormError(null);
  }, [editingSchedule, resetForm]);

  useEffect(() => {
    setSelectedClusterIds((prev) =>
      prev.filter((id) => availableClusterIdSet.has(id))
    );
  }, [availableClusterIdSet, editingSchedule]);

  useEffect(() => {
    setSelectedItemIds((prev) =>
      prev.filter((id) => scheduleItemMap.has(id))
    );
  }, [scheduleItemMap]);
  useEffect(() => {
    setSelectedItemIds((prev) =>
      prev.filter((id) => {
        const item = scheduleItemMap.get(id);
        return item ? !isRancherLocalType(item.check_type) : false;
      })
    );
  }, [scheduleItemMap]);
  useEffect(() => {
    if (
      itemVersionFilter !== "all" &&
      !prometheusVersionOptions.includes(itemVersionFilter)
    ) {
      setItemVersionFilter("all");
    }
  }, [itemVersionFilter, prometheusVersionOptions]);

  useEffect(() => {
    setSchedulePage(1);
    setSchedulePageInput("");
  }, [schedulePageSize, scheduleKeyword, scheduleStatusFilter]);

  useEffect(() => {
    if (formError && scheduleFormErrorRef.current) {
      scheduleFormErrorRef.current.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }
  }, [formError]);

  useEffect(() => {
    setSelectedScheduleIds((prev) =>
      prev.filter((id) => schedules.some((schedule) => schedule.id === id))
    );
  }, [schedules]);

  useEffect(() => {
    if (readOnly) {
      setSelectedScheduleIds([]);
    }
  }, [readOnly]);

  const handleOpenCreate = () => {
    setEditingSchedule(null);
    setFormOpen(true);
  };

  const handleOpenEdit = (schedule: InspectionSchedule) => {
    setEditingSchedule(schedule);
    setFormOpen(true);
  };

  const handleCloseForm = () => {
    setFormOpen(false);
    resetForm();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (readOnly) {
      setFormError(readOnlyMessage);
      return;
    }
    const parts = [
      cronMinute.trim(),
      cronHour.trim(),
      cronDay.trim(),
      cronMonth.trim(),
      cronWeek.trim(),
    ];
    if (parts.some((part) => !part)) {
      setFormError("请完整填写分/时/日/月/周");
      return;
    }
    if (selectedAvailableClusterIds.length === 0) {
      setFormError("请至少选择一个集群");
      return;
    }
    if (selectedItemIds.length === 0) {
      setFormError("请至少选择一个巡检项");
      return;
    }
    setFormError(null);
    try {
      await onSave({
        id: editingSchedule?.id,
        name: formName.trim(),
        cron: parts.join(" "),
        clusterIds: selectedAvailableClusterIds,
        itemIds: selectedItemIds,
        isEnabled: formEnabled,
      });
      handleCloseForm();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "保存定时巡检失败";
      setFormError(message);
    }
  };

  const filteredClusters = useMemo(() => {
    const keyword = clusterKeyword.trim().toLowerCase();
    const list = availableClusters.slice().sort((a, b) => {
      const nameA = (a.name ?? "").toLowerCase();
      const nameB = (b.name ?? "").toLowerCase();
      if (nameA === nameB) {
        return a.id - b.id;
      }
      return nameA.localeCompare(nameB);
    });
    if (!keyword) {
      return list;
    }
    return list.filter((cluster) =>
      (cluster.name ?? "").toLowerCase().includes(keyword)
    );
  }, [availableClusters, clusterKeyword]);

  const filteredClusterIdSet = useMemo(
    () => new Set(filteredClusters.map((cluster) => cluster.id)),
    [filteredClusters]
  );
  const selectedFilteredClusterCount = useMemo(
    () =>
      selectedAvailableClusterIds.filter((id) => filteredClusterIdSet.has(id))
        .length,
    [selectedAvailableClusterIds, filteredClusterIdSet]
  );
  const allFilteredClustersSelected =
    filteredClusters.length > 0 &&
    selectedFilteredClusterCount === filteredClusters.length;

  const toggleCluster = useCallback((clusterId: number) => {
    setSelectedClusterIds((prev) =>
      prev.includes(clusterId)
        ? prev.filter((id) => id !== clusterId)
        : [...prev, clusterId]
    );
  }, []);

  const toggleAllClusters = useCallback(() => {
    setSelectedClusterIds((prev) => {
      if (filteredClusters.length === 0) {
        return prev;
      }
      const next = new Set(prev);
      const allSelected = filteredClusters.every((cluster) =>
        next.has(cluster.id)
      );
      if (allSelected) {
        filteredClusters.forEach((cluster) => next.delete(cluster.id));
        return Array.from(next);
      }
      filteredClusters.forEach((cluster) => next.add(cluster.id));
      return Array.from(next);
    });
  }, [filteredClusters]);

  const filteredItems = useMemo(() => {
    const keyword = itemKeyword.trim().toLowerCase();
    const resolvedVersion =
      itemVersionFilter === "all"
        ? null
        : normalizePrometheusVersion(
            itemVersionFilter,
            prometheusVersionOptions
          );
      return items.filter((item) => {
        const name = (item.name ?? "").toLowerCase();
        const desc = (item.description ?? "").toLowerCase();
        const keywordMatch =
          !keyword || name.includes(keyword) || desc.includes(keyword);
        if (!keywordMatch) {
          return false;
        }
        if (isRancherLocalType(item.check_type)) {
          return false;
        }
        if (!isPromqlType(item.check_type)) {
          return true;
        }
        if (!resolvedVersion) {
          return true;
        }
      return (
        normalizePrometheusVersion(
          item.prometheus_version,
          prometheusVersionOptions
        ) === resolvedVersion
      );
    });
    }, [itemKeyword, itemVersionFilter, items, prometheusVersionOptions]);

  const filteredItemIdSet = useMemo(
    () => new Set(filteredItems.map((item) => item.id)),
    [filteredItems]
  );
  const selectedFilteredItemCount = useMemo(
    () => selectedItemIds.filter((id) => filteredItemIdSet.has(id)).length,
    [selectedItemIds, filteredItemIdSet]
  );
  const allFilteredItemsSelected =
    filteredItems.length > 0 &&
    selectedFilteredItemCount === filteredItems.length;

  const toggleItem = useCallback((itemId: number) => {
    setSelectedItemIds((prev) =>
      prev.includes(itemId)
        ? prev.filter((id) => id !== itemId)
        : [...prev, itemId]
    );
  }, []);

  const toggleAllItems = useCallback(() => {
    setSelectedItemIds((prev) => {
      if (filteredItems.length === 0) {
        return prev;
      }
      const next = new Set(prev);
      const allSelected = filteredItems.every((item) => next.has(item.id));
      if (allSelected) {
        filteredItems.forEach((item) => next.delete(item.id));
        return Array.from(next);
      }
      filteredItems.forEach((item) => next.add(item.id));
      return Array.from(next);
    });
  }, [filteredItems]);

  const filteredPromqlItems = useMemo(
    () => filteredItems.filter((item) => isPromqlType(item.check_type)),
    [filteredItems]
  );
  const filteredCommonItems = useMemo(
    () =>
      filteredItems.filter(
        (item) =>
          !isPromqlType(item.check_type) &&
          !isRancherLocalType(item.check_type)
      ),
    [filteredItems]
  );

  const sortedSchedules = useMemo(() => {
    return schedules.slice().sort((a, b) => {
      const timeA = a.updated_at ? new Date(a.updated_at).getTime() : 0;
      const timeB = b.updated_at ? new Date(b.updated_at).getTime() : 0;
      if (timeA === timeB) {
        return b.id - a.id;
      }
      return timeB - timeA;
    });
  }, [schedules]);

  const getScheduleClusterName = useCallback(
    (schedule: InspectionSchedule, clusterId: number) => {
      const cluster = scheduleClusterMap.get(clusterId);
      if (cluster?.name) {
        return cluster.name;
      }
      const fallbackMap = schedule.cluster_name_map ?? {};
      const fallbackName =
        fallbackMap[String(clusterId)] ?? fallbackMap[clusterId];
      if (fallbackName) {
        return fallbackName;
      }
      const displayId = clusterDisplayIds[clusterId];
      return displayId || `集群${clusterId}`;
    },
    [scheduleClusterMap, clusterDisplayIds]
  );

  const getScheduleClusterLabel = useCallback(
    (schedule: InspectionSchedule, clusterId: number) => {
      const baseName = getScheduleClusterName(schedule, clusterId);
      const cluster = scheduleClusterMap.get(clusterId);
      if (cluster && cluster.connection_status === "connected") {
        return baseName;
      }
      return `${baseName}（已删除/不可用）`;
    },
    [getScheduleClusterName, scheduleClusterMap]
  );

  const filteredSchedules = useMemo(() => {
    const keyword = scheduleKeyword.trim().toLowerCase();
    return sortedSchedules.filter((schedule) => {
      if (scheduleStatusFilter === "enabled" && !schedule.is_enabled) {
        return false;
      }
      if (scheduleStatusFilter === "disabled" && schedule.is_enabled) {
        return false;
      }
      if (!keyword) {
        return true;
      }
      const name = schedule.name?.trim() || `定时巡检 #${schedule.id}`;
      const clusterNames = schedule.cluster_ids
        .map((id) => getScheduleClusterName(schedule, id))
        .join(" ");
      const itemNames = schedule.item_ids
        .map((id) => scheduleItemMap.get(id)?.name ?? `#${id}`)
        .join(" ");
      const haystack = `${name} ${schedule.cron} ${clusterNames} ${itemNames}`.toLowerCase();
      return haystack.includes(keyword);
    });
  }, [
    scheduleKeyword,
    scheduleStatusFilter,
    sortedSchedules,
    scheduleItemMap,
    getScheduleClusterName,
  ]);

  const scheduleTotalPages = useMemo(
    () =>
      Math.max(
        1,
        Math.ceil(filteredSchedules.length / Math.max(schedulePageSize, 1))
      ),
    [filteredSchedules.length, schedulePageSize]
  );

  useEffect(() => {
    setSchedulePage((prev) =>
      Math.min(Math.max(prev, 1), scheduleTotalPages)
    );
  }, [scheduleTotalPages]);

  const pagedSchedules = useMemo(() => {
    const start = (schedulePage - 1) * schedulePageSize;
    return filteredSchedules.slice(start, start + schedulePageSize);
  }, [filteredSchedules, schedulePage, schedulePageSize]);

  const visibleSelectedScheduleCount = useMemo(
    () =>
      selectedScheduleIds.filter((id) =>
        filteredSchedules.some((schedule) => schedule.id === id)
      ).length,
    [selectedScheduleIds, filteredSchedules]
  );

  const allSchedulesSelected =
    filteredSchedules.length > 0 &&
    filteredSchedules.every((schedule) =>
      selectedScheduleIds.includes(schedule.id)
    );

  const handleToggleSchedule = useCallback(
    (scheduleId: number) => {
      if (readOnly) {
        return;
      }
      setSelectedScheduleIds((prev) =>
        prev.includes(scheduleId)
          ? prev.filter((id) => id !== scheduleId)
          : [...prev, scheduleId]
      );
    },
    [readOnly]
  );

  const handleToggleAllSchedules = useCallback(() => {
    setSelectedScheduleIds((prev) => {
      if (readOnly || filteredSchedules.length === 0) {
        return prev;
      }
      const visibleIds = filteredSchedules.map((schedule) => schedule.id);
      const allVisibleSelected = visibleIds.every((id) =>
        prev.includes(id)
      );
      if (allVisibleSelected) {
        return prev.filter((id) => !visibleIds.includes(id));
      }
      const merged = new Set(prev);
      visibleIds.forEach((id) => merged.add(id));
      return Array.from(merged);
    });
  }, [filteredSchedules, readOnly]);

  const handleDeleteSelectedSchedules = useCallback(() => {
    if (readOnly) {
      return;
    }
    if (selectedScheduleIds.length === 0) {
      return;
    }
    onDeleteMany(selectedScheduleIds);
  }, [readOnly, selectedScheduleIds, onDeleteMany]);

  const handleSchedulePageChange = useCallback(
    (offset: number) => {
      setSchedulePage((prev) => {
        const next = prev + offset;
        if (next < 1) {
          return 1;
        }
        if (next > scheduleTotalPages) {
          return scheduleTotalPages;
        }
        return next;
      });
    },
    [scheduleTotalPages]
  );

  const handleSchedulePageJump = useCallback(() => {
    const trimmed = schedulePageInput.trim();
    if (!trimmed) {
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isNaN(parsed) && Number.isInteger(parsed)) {
      const target = Math.min(Math.max(parsed, 1), scheduleTotalPages);
      setSchedulePage(target);
    }
    setSchedulePageInput("");
  }, [schedulePageInput, scheduleTotalPages]);

  const summarizeNames = useCallback((names: string[]) => {
      if (names.length === 0) {
        return "-";
      }
      if (names.length <= 2) {
        return names.join("、");
      }
      return `${names.slice(0, 2).join("、")} 等${names.length}个`;
  }, []);

  const getPrometheusSummary = useCallback(
    (schedule: InspectionSchedule) => {
      const versions = new Set<string>();
      schedule.item_ids.forEach((itemId) => {
        const item = scheduleItemMap.get(itemId);
        if (!item || !isPromqlType(item.check_type)) {
          return;
        }
        versions.add(
          normalizePrometheusVersion(
            item.prometheus_version,
            prometheusVersionOptions
          )
        );
      });
      if (versions.size === 0) {
        return "-";
      }
      return Array.from(versions).sort().join(", ");
    },
    [scheduleItemMap, prometheusVersionOptions]
  );

  return (
    <div className="inspection-settings-panel">
      <div className="card-header history-header">
        <div>
          <h2>定时巡检</h2>
          <p className="card-caption">基于 Cron 表达式定时触发巡检任务</p>
        </div>
        <div className="card-actions">
          {!readOnly && (
            <button
              type="button"
              className="primary"
              onClick={handleOpenCreate}
              disabled={submitting}
            >
              创建定时任务
            </button>
          )}
        </div>
      </div>
      {notice && <div className="feedback success">{notice}</div>}
      {error && <div className="feedback error">{error}</div>}
      {readOnly && (
        <div className="feedback warning">
          {readOnlyMessage}
        </div>
      )}
      <div className="inspection-settings-body">
        <section className="inspection-section inspection-section-list">
          <div className="inspection-section-header">
            <div>
              <h4>定时任务列表</h4>
              <span className="inspection-section-hint">
                支持启用/停用与编辑任务
              </span>
            </div>
            <span className="inspection-section-count">
              共 {filteredSchedules.length} 条
            </span>
          </div>
          <div className="settings-list">
            <div className="history-toolbar">
              {!readOnly && (
                <div className="history-selection">
                  <label className="table-checkbox">
                    <input
                      type="checkbox"
                      checked={allSchedulesSelected}
                      onChange={handleToggleAllSchedules}
                    />
                    <span>当前页全选</span>
                  </label>
                  <span className="selection-hint">
                    已选 {visibleSelectedScheduleCount} / {filteredSchedules.length}
                  </span>
                  <button
                    type="button"
                    className="secondary danger"
                    onClick={handleDeleteSelectedSchedules}
                    disabled={selectedScheduleIds.length === 0}
                  >
                    删除所选
                  </button>
                </div>
              )}
              <div className="history-filter-row">
                <div className="history-chip history-chip-select">
                  <span className="history-chip-label">状态筛选</span>
                  <select
                    value={scheduleStatusFilter}
                    onChange={(event) =>
                      setScheduleStatusFilter(
                        event.target.value as "all" | "enabled" | "disabled"
                      )
                    }
                  >
                    <option value="all">全部</option>
                    <option value="enabled">启用</option>
                    <option value="disabled">停用</option>
                  </select>
                </div>
                <div className="history-chip history-chip-search">
                  <span className="history-chip-label">关键字</span>
                  <input
                    type="text"
                    value={scheduleKeyword}
                    onChange={(event) => setScheduleKeyword(event.target.value)}
                    placeholder="按名称 / Cron / 集群 / 巡检项搜索"
                  />
                  {scheduleKeyword && (
                    <button
                      type="button"
                      className="history-search-clear"
                      onClick={() => setScheduleKeyword("")}
                      aria-label="清空关键字"
                    >
                      ×
                    </button>
                  )}
                </div>
              </div>
            </div>
            <div className="table-wrapper">
              {filteredSchedules.length === 0 ? (
                <div className="placeholder">暂无定时巡检任务</div>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th></th>
                      <th>名称</th>
                      <th>Cron</th>
                      <th>集群</th>
                      <th>巡检项</th>
                      <th>状态</th>
                      <th>最近执行</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedSchedules.map((schedule) => {
                      const label =
                        schedule.name?.trim() ||
                        `定时巡检 #${schedule.id}`;
                      const clusterSummary = summarizeNames(
                        schedule.cluster_ids.map((id) =>
                          getScheduleClusterLabel(schedule, id)
                        )
                      );
                      const versionSummary = getPrometheusSummary(schedule);
                      return (
                        <tr key={schedule.id}>
                          <td>
                            {!readOnly && (
                              <label className="table-checkbox">
                                <input
                                  type="checkbox"
                                  checked={selectedScheduleIds.includes(schedule.id)}
                                  onChange={() => handleToggleSchedule(schedule.id)}
                                />
                              </label>
                            )}
                          </td>
                          <td>{label}</td>
                          <td className="th-nowrap">{schedule.cron}</td>
                          <td>
                            <div className="schedule-cell">
                              <span>{clusterSummary}</span>
                              <span className="schedule-muted">
                                {schedule.cluster_ids.length} 个集群
                              </span>
                            </div>
                          </td>
                          <td>
                            <div className="schedule-cell">
                              <span>
                                {schedule.item_ids.length} 项
                              </span>
                              <span className="schedule-muted">
                                PromQL 版本：{versionSummary}
                              </span>
                            </div>
                          </td>
                          <td>
                            <span
                              className={`chip${
                                schedule.is_enabled ? "" : " muted"
                              }`}
                            >
                              {schedule.is_enabled ? "启用" : "停用"}
                            </span>
                          </td>
                          <td>
                            {schedule.last_run_at
                              ? formatDate(schedule.last_run_at)
                              : "-"}
                          </td>
                          <td className="actions">
                            {!readOnly ? (
                              <>
                                <button
                                  type="button"
                                  className="link-button"
                                  onClick={() => handleOpenEdit(schedule)}
                                >
                                  编辑
                                </button>
                                <button
                                  type="button"
                                  className="link-button"
                                  onClick={() =>
                                    onToggleEnabled(
                                      schedule,
                                      !schedule.is_enabled
                                    )
                                  }
                                >
                                  {schedule.is_enabled ? "停用" : "启用"}
                                </button>
                                <button
                                  type="button"
                                  className="link-button danger"
                                  onClick={() => onDelete(schedule)}
                                >
                                  删除
                                </button>
                              </>
                            ) : (
                              <span>-</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
            {filteredSchedules.length > 0 && (
              <div className="history-pagination-controls schedule-pagination">
                <label className="page-size-control">
                  每页
                  <select
                    value={schedulePageSize}
                    onChange={(event) =>
                      setSchedulePageSize(Number(event.target.value))
                    }
                    className="page-size-select"
                  >
                    {[10, 20, 50].map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="history-pagination-buttons">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => handleSchedulePageChange(-1)}
                    disabled={schedulePage <= 1}
                  >
                    上一页
                  </button>
                  <span>
                    第 {schedulePage} / {scheduleTotalPages} 页
                  </span>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => handleSchedulePageChange(1)}
                    disabled={schedulePage >= scheduleTotalPages}
                  >
                    下一页
                  </button>
                </div>
                <label className="history-page-jump">
                  跳转
                  <input
                    type="number"
                    min={1}
                    value={schedulePageInput}
                    onChange={(event) =>
                      setSchedulePageInput(event.target.value)
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        handleSchedulePageJump();
                      }
                    }}
                  />
                </label>
                <button
                  type="button"
                  className="secondary"
                  onClick={handleSchedulePageJump}
                >
                  确定
                </button>
              </div>
            )}
          </div>
        </section>
      </div>
      {formOpen && (
        <div className="modal-backdrop" aria-modal="true">
          <div className="modal large schedule-modal" role="dialog">
            <div className="settings-header">
              <div>
                <h3>{editingSchedule ? "编辑定时任务" : "新增定时任务"}</h3>
                <p>时间格式为 分 时 日 月 周，按服务器时间执行</p>
              </div>
              <div className="settings-actions">
                <button
                  type="button"
                  className="link-button"
                  onClick={handleCloseForm}
                >
                  关闭
                </button>
              </div>
            </div>
            {formError && (
              <div
                ref={scheduleFormErrorRef}
                className="feedback error"
              >
                {formError}
              </div>
            )}
            <form className="settings-form" onSubmit={handleSubmit}>
              <label>
                任务名称
                <input
                  type="text"
                  className="schedule-input"
                  value={formName}
                  onChange={(event) => setFormName(event.target.value)}
                  placeholder="例如：每日健康巡检"
                  disabled={submitting || readOnly}
                />
              </label>
              <div className="schedule-cron-row">
                <div className="schedule-cron-grid">
                  <label>
                    分
                    <input
                      type="text"
                      className="schedule-cron-input"
                      value={cronMinute}
                      onChange={(event) => setCronMinute(event.target.value)}
                      placeholder="0-59"
                      disabled={submitting || readOnly}
                    />
                  </label>
                  <label>
                    时
                    <input
                      type="text"
                      className="schedule-cron-input"
                      value={cronHour}
                      onChange={(event) => setCronHour(event.target.value)}
                      placeholder="0-23"
                      disabled={submitting || readOnly}
                    />
                  </label>
                  <label>
                    日
                    <input
                      type="text"
                      className="schedule-cron-input"
                      value={cronDay}
                      onChange={(event) => setCronDay(event.target.value)}
                      placeholder="1-31/*"
                      disabled={submitting || readOnly}
                    />
                  </label>
                  <label>
                    月
                    <input
                      type="text"
                      className="schedule-cron-input"
                      value={cronMonth}
                      onChange={(event) => setCronMonth(event.target.value)}
                      placeholder="1-12/*"
                      disabled={submitting || readOnly}
                    />
                  </label>
                  <label>
                    周
                    <input
                      type="text"
                      className="schedule-cron-input"
                      value={cronWeek}
                      onChange={(event) => setCronWeek(event.target.value)}
                      placeholder="0-6/*"
                      disabled={submitting || readOnly}
                    />
                  </label>
                </div>
                <label className="table-checkbox schedule-enabled">
                  <span>启用</span>
                  <input
                    type="checkbox"
                    checked={formEnabled}
                    onChange={(event) => setFormEnabled(event.target.checked)}
                    disabled={submitting || readOnly}
                  />
                </label>
              </div>
              <div className="inspection-item-group schedule-section schedule-section-cluster">
                <div className="inspection-item-group-title">
                  <span className="inspection-group-title-text">选择集群</span>
                  <span className="group-count">
                    已选 {selectedAvailableClusterIds.length} / {filteredClusters.length}
                  </span>
                </div>
                <div className="inspection-items-toolbar">
                  <div className="inspection-items-toolbar-actions">
                    <input
                      type="text"
                      className="inspection-items-filter"
                      value={clusterKeyword}
                      onChange={(event) =>
                        setClusterKeyword(event.target.value)
                      }
                      placeholder="搜索集群"
                      disabled={submitting || readOnly}
                    />
                    <button
                      type="button"
                      className="secondary"
                      onClick={toggleAllClusters}
                      disabled={submitting || readOnly}
                    >
                      {allFilteredClustersSelected ? "清除选择" : "全选"}
                    </button>
                  </div>
                </div>
                <details className="schedule-dropdown schedule-cluster-dropdown">
                  <summary>
                    <span>展开集群列表</span>
                    <span className="schedule-dropdown-summary">
                      已选 {selectedAvailableClusterIds.length}
                    </span>
                  </summary>
                  <div className="schedule-dropdown-body">
                    {availableClusters.length === 0 ? (
                      <div className="placeholder">暂无可用集群</div>
                    ) : filteredClusters.length === 0 ? (
                      <div className="placeholder">未找到匹配的集群</div>
                    ) : (
                      <ul className="item-list scrollable schedule-cluster-list">
                        {filteredClusters.map((cluster) => {
                          const displayId = getClusterDisplayId(
                            clusterDisplayIds,
                            cluster.id,
                            cluster
                          );
                          return (
                            <li key={cluster.id}>
                              <label className="schedule-cluster-option">
                                <div className="schedule-option-info">
                                  <div className="item-title-row">
                                    <div className="item-name">{cluster.name}</div>
                                    <span className="item-tag neutral">
                                      {displayId}
                                    </span>
                                  </div>
                                </div>
                                <input
                                  type="checkbox"
                                  checked={selectedClusterIds.includes(cluster.id)}
                                  onChange={() => toggleCluster(cluster.id)}
                                  disabled={submitting || readOnly}
                                />
                              </label>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    <div className="schedule-dropdown-hint">勾选即可多选</div>
                  </div>
                </details>
              </div>
              <div className="inspection-item-group schedule-section schedule-section-items">
                <div className="inspection-item-group-title">
                  <span className="inspection-group-title-text">选择巡检项</span>
                  <span className="group-count">
                    已选 {selectedItemIds.length} / {filteredItems.length}
                  </span>
                </div>
                <div className="inspection-items-toolbar">
                  <span className="selection-hint">
                    已选 {selectedFilteredItemCount} / {filteredItems.length}
                  </span>
                  <div className="inspection-items-toolbar-actions">
                    <input
                      type="text"
                      className="inspection-items-filter"
                      value={itemKeyword}
                      onChange={(event) => setItemKeyword(event.target.value)}
                      placeholder="关键字筛选"
                      disabled={submitting || readOnly}
                    />
                    <select
                      className="inspection-items-filter"
                      value={itemVersionFilter}
                      onChange={(event) =>
                        setItemVersionFilter(event.target.value)
                      }
                      disabled={submitting || readOnly}
                    >
                      <option value="all">PromQL 全部版本</option>
                      {prometheusVersionOptions.map((version) => (
                        <option key={version} value={version}>
                          {version}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="secondary"
                      onClick={toggleAllItems}
                      disabled={submitting || readOnly}
                    >
                      {allFilteredItemsSelected ? "清除选择" : "全选"}
                    </button>
                  </div>
                </div>
                {items.length === 0 ? (
                  <div className="placeholder">暂无巡检项</div>
                ) : filteredItems.length === 0 ? (
                  <div className="placeholder">未找到匹配的巡检项</div>
                ) : (
                  <div
                    className="inspection-item-columns"
                  >
                    <div className="inspection-item-column">
                      <details className="schedule-dropdown">
                        <summary>
                          <span>PromQL 巡检项</span>
                          <span className="schedule-dropdown-summary">
                            {filteredPromqlItems.length} 条
                          </span>
                        </summary>
                        <div className="schedule-dropdown-body">
                          {filteredPromqlItems.length === 0 ? (
                            <div className="placeholder">
                              暂无 PromQL 巡检项
                            </div>
                          ) : (
                            <ul className="item-list scrollable">
                              {filteredPromqlItems.map((item) => (
                                <li key={item.id}>
                                  <label>
                                    <input
                                      type="checkbox"
                                      checked={selectedItemIds.includes(item.id)}
                                      onChange={() => toggleItem(item.id)}
                                      disabled={submitting || readOnly}
                                    />
                                    <div>
                                      <div className="item-title-row">
                                        <div className="item-name">{item.name}</div>
                                        <span className="item-tag promql">
                                          PromQL ·{" "}
                                          {normalizePrometheusVersion(
                                            item.prometheus_version,
                                            prometheusVersionOptions
                                          )}
                                        </span>
                                      </div>
                                      <div className="item-desc">
                                        {item.description || "未提供描述"}
                                      </div>
                                    </div>
                                  </label>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </details>
                    </div>
                    <div className="inspection-item-column">
                      <details className="schedule-dropdown">
                        <summary>
                          <span>通用巡检项</span>
                          <span className="schedule-dropdown-summary">
                            {filteredCommonItems.length} 条
                          </span>
                        </summary>
                        <div className="schedule-dropdown-body">
                          {filteredCommonItems.length === 0 ? (
                            <div className="placeholder">
                              暂无通用巡检项
                            </div>
                          ) : (
                            <ul className="item-list scrollable">
                              {filteredCommonItems.map((item) => (
                                <li key={item.id}>
                                  <label>
                                    <input
                                      type="checkbox"
                                      checked={selectedItemIds.includes(item.id)}
                                      onChange={() => toggleItem(item.id)}
                                      disabled={submitting || readOnly}
                                    />
                                    <div>
                                      <div className="item-title-row">
                                        <div className="item-name">{item.name}</div>
                                        <span className="item-tag neutral">通用</span>
                                      </div>
                                      <div className="item-desc">
                                        {item.description || "未提供描述"}
                                      </div>
                                    </div>
                                  </label>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </details>
                    </div>
                  </div>
                )}
              </div>
              <div className="settings-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={resetForm}
                  disabled={submitting || readOnly}
                >
                  重置
                </button>
                <button
                  type="submit"
                  className="primary"
                  disabled={submitting || readOnly}
                >
                  {editingSchedule ? "保存修改" : "新增"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

interface SchedulePageProps {
  schedules: InspectionSchedule[];
  clusters: ClusterConfig[];
  clusterDisplayIds: Record<number, string>;
  items: InspectionItem[];
  prometheusVersionOptions: string[];
  submitting: boolean;
  notice: string | null;
  error: string | null;
  license: LicenseCapabilities;
  canManage: boolean;
  onSave: (payload: {
    id?: number;
    name?: string;
    cron: string;
    clusterIds: number[];
    itemIds: number[];
    isEnabled: boolean;
  }) => Promise<void>;
  onDelete: (schedule: InspectionSchedule) => void;
  onDeleteMany: (scheduleIds: number[]) => void;
  onToggleEnabled: (schedule: InspectionSchedule, enabled: boolean) => void;
}

const SchedulePage = ({
  schedules,
  clusters,
  clusterDisplayIds,
  items,
  prometheusVersionOptions,
  submitting,
  notice,
  error,
  license,
  canManage,
  onSave,
  onDelete,
  onDeleteMany,
  onToggleEnabled,
}: SchedulePageProps) => (
  <section className="card history history-page schedule-page">
    <ScheduleSettingsPanel
      schedules={schedules}
      clusters={clusters}
      clusterDisplayIds={clusterDisplayIds}
      items={items}
      prometheusVersionOptions={prometheusVersionOptions}
      submitting={submitting}
      notice={notice}
      error={error}
      license={license}
      canManage={canManage}
      onSave={onSave}
      onDelete={onDelete}
      onDeleteMany={onDeleteMany}
      onToggleEnabled={onToggleEnabled}
    />
  </section>
);

const NoPermissionPanel = ({
  title,
  description,
}: {
  title: string;
  description?: string;
}) => (
  <section className="card permission-panel">
    <div className="permission-panel-content">
      <h3>{title}</h3>
      <p>{description ?? "当前账号没有该功能的访问权限。"}</p>
    </div>
  </section>
);

interface RoleSettingsPanelProps {
  roles: AuthRole[];
  loading: boolean;
  submitting: boolean;
  notice: string | null;
  error: string | null;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  onCreate: (payload: {
    name: string;
    display_name?: string;
    description?: string;
    permissions: string[];
  }) => Promise<void>;
  onUpdate: (
    roleId: number,
    payload: {
      display_name?: string;
      description?: string;
      permissions?: string[];
    }
  ) => Promise<void>;
  onDelete: (role: AuthRole) => void;
  onRefresh: () => Promise<AuthRole[] | null>;
}

const RoleSettingsPanel = ({
  roles,
  loading,
  submitting,
  notice,
  error,
  canCreate,
  canUpdate,
  canDelete,
  onCreate,
  onUpdate,
  onDelete,
  onRefresh,
}: RoleSettingsPanelProps) => {
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<AuthRole | null>(null);
  const sortedRoles = useMemo(
    () => roles.slice().sort((a, b) => a.id - b.id),
    [roles]
  );

  const openCreate = () => {
    setEditingRole(null);
    setEditorOpen(true);
  };

  const openEdit = (role: AuthRole) => {
    setEditingRole(role);
    setEditorOpen(true);
  };

  const handleCloseEditor = () => {
    setEditorOpen(false);
    setEditingRole(null);
  };

  const handleSubmit = async (payload: {
    name: string;
    display_name?: string;
    description?: string;
    permissions: string[];
  }) => {
    if (editingRole) {
      await onUpdate(editingRole.id, {
        display_name: payload.display_name,
        description: payload.description,
        permissions: payload.permissions,
      });
    } else {
      await onCreate(payload);
    }
    setEditorOpen(false);
    setEditingRole(null);
  };

  return (
    <div className="inspection-settings-panel role-settings-panel">
      <div className="settings-header">
        <div>
          <h3>角色管理</h3>
          <p>管理系统角色与权限范围</p>
        </div>
        <div className="settings-actions">
          <button
            type="button"
            className="link-button"
            onClick={() => void onRefresh()}
            disabled={loading || submitting}
          >
            刷新
          </button>
          {canCreate && (
            <button
              type="button"
              className="primary"
              onClick={openCreate}
              disabled={loading || submitting}
            >
              创建角色
            </button>
          )}
        </div>
      </div>
      {notice && <div className="feedback success">{notice}</div>}
      {error && <div className="feedback error">{error}</div>}
      <div className="settings-list">
        <div className="settings-list-header">
          <div className="settings-list-count">
            共 {sortedRoles.length} 个角色
          </div>
        </div>
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>说明</th>
                <th>权限</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {sortedRoles.length === 0 && (
                <tr>
                  <td colSpan={4}>{loading ? "加载中..." : "暂无角色"}</td>
                </tr>
              )}
              {sortedRoles.map((role) => {
                const permissionLabel = role.permissions.includes("*")
                  ? "全部权限"
                  : `${role.permissions.length} 项`;
                return (
                  <tr key={role.id}>
                    <td>
                      <div className="role-name">
                        <span>{role.display_name || role.name}</span>
                        {role.is_system && (
                          <span className="role-badge">系统</span>
                        )}
                      </div>
                      <div className="role-subname">{role.name}</div>
                    </td>
                    <td>{role.description || "-"}</td>
                    <td>{permissionLabel}</td>
                    <td>
                      <div className="table-actions">
                        {canUpdate && (
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => openEdit(role)}
                            disabled={role.is_system}
                          >
                            编辑
                          </button>
                        )}
                        {canDelete && (
                          <button
                            type="button"
                            className="link-button danger"
                            onClick={() => onDelete(role)}
                            disabled={role.is_system}
                          >
                            删除
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {editorOpen && (
        <RoleEditorModal
          role={editingRole}
          submitting={submitting}
          onClose={handleCloseEditor}
          onSubmit={handleSubmit}
        />
      )}
    </div>
  );
};

interface RoleEditorModalProps {
  role: AuthRole | null;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (payload: {
    name: string;
    display_name?: string;
    description?: string;
    permissions: string[];
  }) => Promise<void>;
}

const RoleEditorModal = ({
  role,
  submitting,
  onClose,
  onSubmit,
}: RoleEditorModalProps) => {
  const isEdit = Boolean(role);
  const isSystemRole = role?.is_system ?? false;
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!role) {
      setName("");
      setDisplayName("");
      setDescription("");
      setSelectedPermissions([]);
      setLocalError(null);
      return;
    }
    setName(role.name);
    setDisplayName(role.display_name || role.name);
    setDescription(role.description || "");
    setSelectedPermissions(role.permissions || []);
    setLocalError(null);
  }, [role]);

  const handleTogglePermission = (key: string) => {
    setSelectedPermissions((prev) =>
      prev.includes(key)
        ? prev.filter((value) => value !== key)
        : [...prev, key]
    );
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedDisplay = displayName.trim();
    if (!trimmedName) {
      setLocalError("角色标识不能为空");
      return;
    }
    if (!trimmedDisplay) {
      setLocalError("角色名称不能为空");
      return;
    }
    setLocalError(null);
    try {
      await onSubmit({
        name: trimmedName,
        display_name: trimmedDisplay,
        description: description.trim() || undefined,
        permissions: selectedPermissions,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "保存角色失败";
      setLocalError(message);
    }
  };

  return (
    <div className="modal-backdrop" aria-modal="true">
      <div className="modal role-editor-modal" role="dialog" aria-label="角色设置">
        <div className="modal-header">
          <h3>{isEdit ? "编辑角色" : "创建角色"}</h3>
        </div>
        {(localError || isSystemRole) && (
          <div className="feedback error">
            {localError ?? "系统角色不可编辑。"}
          </div>
        )}
        <form className="settings-form" onSubmit={handleSubmit}>
          <label>
            角色标识
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：custom_role"
              disabled={submitting || isEdit || isSystemRole}
            />
          </label>
          <label>
            角色名称
            <input
              type="text"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="例如：运维管理员"
              disabled={submitting || isSystemRole}
            />
          </label>
          <label>
            角色说明
            <textarea
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="角色的用途说明"
              disabled={submitting || isSystemRole}
            />
          </label>
          <div className="role-permission-block">
            <div className="role-permission-title">权限配置</div>
            <div className="role-permission-grid">
              {ROLE_PERMISSION_BLOCKS.map((block, blockIndex) => (
                <div
                  key={`${block.title ?? "block"}-${blockIndex}`}
                  className="role-permission-group"
                >
                  {block.title && <h4>{block.title}</h4>}
                  <div className="role-permission-dropdowns">
                    {block.rows.map((row) => {
                      const selectedItems = row.options.filter((item) =>
                        selectedPermissions.includes(item.key)
                      );
                      return (
                        <div key={row.label} className="role-permission-row">
                          <div className="role-permission-row-head">
                            <span className="role-permission-row-label">
                              {row.label}
                            </span>
                            <details
                              className="role-permission-dropdown"
                              data-disabled={submitting || isSystemRole}
                            >
                              <summary>选择</summary>
                              <div className="role-permission-options">
                                {row.options.map((item) => (
                                  <label key={item.key}>
                                    <input
                                      type="checkbox"
                                      checked={selectedPermissions.includes(item.key)}
                                      onChange={() => handleTogglePermission(item.key)}
                                      disabled={submitting || isSystemRole}
                                    />
                                    <span>{item.label}</span>
                                  </label>
                                ))}
                              </div>
                            </details>
                          </div>
                          <div className="role-permission-selected">
                            {selectedItems.length === 0 ? (
                              <span className="role-permission-empty">未选择</span>
                            ) : (
                              selectedItems.map((item) => (
                                <span
                                  key={item.key}
                                  className="role-permission-tag"
                                >
                                  {item.label}
                                </span>
                              ))
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="modal-actions">
            <button
              type="button"
              className="secondary"
              onClick={onClose}
              disabled={submitting}
            >
              取消
            </button>
            <button
              type="submit"
              className="primary"
              disabled={submitting || isSystemRole}
            >
              {submitting ? "保存中..." : "保存"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

interface UserSettingsPanelProps {
  users: AuthUser[];
  roles: AuthRole[];
  loading: boolean;
  submitting: boolean;
  notice: string | null;
  error: string | null;
  license: LicenseCapabilities;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  onCreate: (payload: {
    username: string;
    display_name?: string;
    password: string;
    roles: string[];
  }) => Promise<void>;
  onUpdate: (
    userId: number,
    payload: {
      display_name?: string;
      password?: string;
      roles?: string[];
      is_active?: boolean;
    }
  ) => Promise<void>;
  onDelete: (user: AuthUser) => void;
  onRefresh: () => Promise<AuthUser[] | null>;
}

const UserSettingsPanel = ({
  users,
  roles,
  loading,
  submitting,
  notice,
  error,
  license,
  canCreate,
  canUpdate,
  canDelete,
  onCreate,
  onUpdate,
  onDelete,
  onRefresh,
}: UserSettingsPanelProps) => {
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<AuthUser | null>(null);
  const [formUsername, setFormUsername] = useState("");
  const [formDisplayName, setFormDisplayName] = useState("");
  const [formPassword, setFormPassword] = useState("");
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const readOnly = !license.valid;
  const readOnlyMessage =
    license.reason ?? "当前 License 未生效或未安装。";

  const sortedUsers = useMemo(
    () => users.slice().sort((a, b) => a.id - b.id),
    [users]
  );
  const roleLabelMap = useMemo(() => {
    const map = new Map<string, string>();
    roles.forEach((role) => {
      map.set(role.name, role.display_name || role.name);
    });
    return map;
  }, [roles]);
  const isAdminUser = useCallback(
    (user: AuthUser | null) => user?.username === "admin",
    []
  );

  const openCreate = () => {
    setEditingUser(null);
    setFormUsername("");
    setFormDisplayName("");
    setFormPassword("");
    setSelectedRoles([]);
    setLocalError(null);
    setEditorOpen(true);
  };

  const openEdit = (user: AuthUser) => {
    const roleNames =
      user.roles && user.roles.length > 0
        ? user.roles
        : user.role
          ? [user.role]
          : [];
    setEditingUser(user);
    setFormUsername(user.username);
    setFormDisplayName(user.display_name || "");
    setFormPassword("");
    setSelectedRoles(roleNames);
    setLocalError(null);
    setEditorOpen(true);
  };

  const handleCloseEditor = () => {
    setEditorOpen(false);
    setEditingUser(null);
    setLocalError(null);
  };

  const toggleRole = (name: string) => {
    setSelectedRoles((prev) =>
      prev.includes(name)
        ? prev.filter((value) => value !== name)
        : [...prev, name]
    );
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedUsername = formUsername.trim();
    const trimmedPassword = formPassword.trim();
    const editingAdmin = isAdminUser(editingUser);
    if (readOnly) {
      setLocalError(readOnlyMessage);
      return;
    }
    if (!trimmedUsername) {
      setLocalError("用户名不能为空");
      return;
    }
    if (!editingUser && !trimmedPassword) {
      setLocalError("密码不能为空");
      return;
    }
    if (!editingAdmin && selectedRoles.length === 0) {
      setLocalError("请至少选择一个角色");
      return;
    }
    setLocalError(null);
    if (editingUser) {
      const payload: {
        display_name?: string;
        password?: string;
        roles?: string[];
      } = {
        display_name: formDisplayName.trim() || undefined,
        password: trimmedPassword || undefined,
      };
      if (!editingAdmin) {
        payload.roles = selectedRoles;
      }
      await onUpdate(editingUser.id, payload);
    } else {
      await onCreate({
        username: trimmedUsername,
        display_name: formDisplayName.trim() || undefined,
        password: trimmedPassword,
        roles: selectedRoles,
      });
    }
    setEditorOpen(false);
  };

  const renderUserRoles = (user: AuthUser) => {
    const roleNames =
      user.roles && user.roles.length > 0
        ? user.roles
        : user.role
          ? [user.role]
          : [];
    if (roleNames.length === 0) {
      return "-";
    }
    return roleNames
      .map((name) => roleLabelMap.get(name) || name)
      .join("、");
  };

  return (
    <div className="inspection-settings-panel role-settings-panel">
      <div className="settings-header">
        <div>
          <h3>用户管理</h3>
          <p>管理账号与角色授权范围</p>
        </div>
        <div className="settings-actions">
          <button
            type="button"
            className="link-button"
            onClick={() => void onRefresh()}
            disabled={loading || submitting}
          >
            刷新
          </button>
          {canCreate && (
            <button
              type="button"
              className="primary"
              onClick={openCreate}
              disabled={loading || submitting || readOnly}
            >
              创建用户
            </button>
          )}
        </div>
      </div>
      {notice && <div className="feedback success">{notice}</div>}
      {error && <div className="feedback error">{error}</div>}
      {readOnly && (
        <div className="feedback warning">{readOnlyMessage}</div>
      )}
      <div className="user-role-summary">
        <div className="user-role-summary-title">系统角色</div>
        <div className="user-role-summary-list">
          {roles.length === 0 && (
            <div className="placeholder">暂无角色</div>
          )}
          {roles.map((role) => {
            const permissionLabel = role.permissions.includes("*")
              ? "全部权限"
              : `${role.permissions.length} 项`;
            return (
              <div key={role.id} className="user-role-summary-card">
                <div className="user-role-summary-name">
                  {role.display_name || role.name}
                </div>
                <div className="user-role-summary-meta">{role.name}</div>
                <div className="user-role-summary-desc">
                  {role.description || permissionLabel}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="settings-list">
        <div className="settings-list-header">
          <div className="settings-list-count">共 {sortedUsers.length} 个用户</div>
        </div>
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>用户名</th>
                <th>显示名称</th>
                <th>角色</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {sortedUsers.length === 0 && (
                <tr>
                  <td colSpan={5}>{loading ? "加载中..." : "暂无用户"}</td>
                </tr>
              )}
              {sortedUsers.map((user) => (
                <tr key={user.id}>
                  <td>{user.username}</td>
                  <td>{user.display_name || "-"}</td>
                  <td>{renderUserRoles(user)}</td>
                  <td>{user.is_active === false ? "停用" : "启用"}</td>
                  <td>
                    <div className="table-actions">
                      {canUpdate && (
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => openEdit(user)}
                          disabled={submitting || readOnly}
                        >
                          编辑
                        </button>
                      )}
                      {canDelete && (
                        <button
                          type="button"
                          className="link-button danger"
                          onClick={() => onDelete(user)}
                          disabled={submitting || readOnly || isAdminUser(user)}
                        >
                          删除
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {editorOpen && (
        <div className="modal-backdrop" aria-modal="true">
          <div
            className="modal user-editor-modal"
            role="dialog"
            aria-label={editingUser ? "编辑用户" : "创建用户"}
          >
            <div className="modal-header">
              <h3>{editingUser ? "编辑用户" : "创建用户"}</h3>
            </div>
            {localError && <div className="feedback error">{localError}</div>}
            <form className="settings-form" onSubmit={handleSubmit}>
              <label>
                用户名
                <input
                  type="text"
                  value={formUsername}
                  onChange={(event) => setFormUsername(event.target.value)}
                  placeholder="例如：admin2"
                  disabled={submitting || readOnly || Boolean(editingUser)}
                />
              </label>
              <label>
                显示名称
                <input
                  type="text"
                  value={formDisplayName}
                  onChange={(event) => setFormDisplayName(event.target.value)}
                  placeholder="例如：运维管理员"
                  disabled={submitting || readOnly}
                />
              </label>
              <label>
                登录密码
                <input
                  type="password"
                  value={formPassword}
                  onChange={(event) => setFormPassword(event.target.value)}
                  placeholder={editingUser ? "留空则不修改" : "至少 6 位"}
                  disabled={submitting || readOnly}
                />
              </label>
              <div className="user-role-block">
                <div className="user-role-title">
                  角色授权
                  {editingUser && isAdminUser(editingUser) && (
                    <span className="user-role-hint">管理员不可修改</span>
                  )}
                </div>
                <div className="user-role-list">
                  {roles.length === 0 && (
                    <div className="placeholder">暂无可用角色</div>
                  )}
                  {roles.map((role) => (
                    <label key={role.id} className="user-role-option">
                      <span className="user-role-text">
                        <span className="user-role-name">
                          {role.display_name || role.name}
                        </span>
                        <span className="user-role-code">({role.name})</span>
                      </span>
                      <input
                        type="checkbox"
                        checked={selectedRoles.includes(role.name)}
                        onChange={() => toggleRole(role.name)}
                        disabled={
                          submitting ||
                          readOnly ||
                          (editingUser !== null && isAdminUser(editingUser))
                        }
                      />
                    </label>
                  ))}
                </div>
                <div className="user-role-selected">
                  {selectedRoles.length === 0 ? (
                    <span className="user-role-empty">未选择</span>
                  ) : (
                    selectedRoles.map((name) => (
                      <span key={name} className="user-role-tag">
                        {roleLabelMap.get(name) || name}
                      </span>
                    ))
                  )}
                </div>
              </div>
              <div className="modal-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={handleCloseEditor}
                  disabled={submitting}
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="primary"
                  disabled={submitting || readOnly}
                >
                  {submitting ? "创建中..." : "创建"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

interface LicenseSettingsPanelProps {
  status: LicenseCapabilities;
  uploading: boolean;
  textUploading: boolean;
  canUpload: boolean;
  onUpload: (file: File) => Promise<LicenseStatus | null>;
  onUploadText: (value: string) => Promise<LicenseStatus | null>;
  onRefresh: () => Promise<LicenseStatus | null>;
}

const LicenseSettingsPanel = ({
  status,
  uploading,
  textUploading,
  canUpload,
  onUpload,
  onUploadText,
  onRefresh,
}: LicenseSettingsPanelProps) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [textValue, setTextValue] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [localNotice, setLocalNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const handleFileChange = async (
    event: ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) {
      return;
    }
    if (!canUpload) {
      setLocalError("当前账号无 License 上传权限");
      return;
    }
    try {
      setLocalError(null);
      await onUpload(file);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "上传 License 失败";
      setLocalError(message);
    }
  };

  const handleSubmitText = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = textValue.trim();
    if (!content) {
      setLocalError("License 内容不能为空");
      return;
    }
    if (!canUpload) {
      setLocalError("当前账号无 License 上传权限");
      return;
    }
    try {
      setLocalError(null);
      await onUploadText(content);
      setTextValue("");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "导入 License 失败";
      setLocalError(message);
    }
  };

  const handleRefresh = async () => {
    try {
      setRefreshing(true);
      setLocalError(null);
      setLocalNotice(null);
      await onRefresh();
      setLocalNotice("已刷新 License 状态");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "刷新 License 状态失败";
      setLocalError(message);
    } finally {
      setRefreshing(false);
    }
  };

  const licenseStatus = status.status;

  useEffect(() => {
    if (!localNotice || typeof window === "undefined") {
      return;
    }
    const timer = window.setTimeout(() => {
      setLocalNotice(null);
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [localNotice]);

  return (
    <div className="settings-content settings-content-stack license-panel">
      <div className="settings-header">
        <div>
          <h3>License 管理</h3>
          <p>统一管理巡检项、Agent 节点以及 License 授权。</p>
        </div>
        <div className="settings-actions">
          <button
            type="button"
            className="secondary"
            onClick={handleRefresh}
            disabled={refreshing}
          >
            {refreshing ? "刷新中..." : "刷新状态"}
          </button>
        </div>
      </div>
      {localNotice && <div className="feedback success">{localNotice}</div>}
      {status.reason && !status.valid && (
        <div className="feedback warning">{status.reason}</div>
      )}
      {!canUpload && (
        <div className="feedback warning">当前账号无 License 上传权限</div>
      )}
      {localError && <div className="feedback error">{localError}</div>}
      <section className="settings-list">
        <table>
          <tbody>
            <tr>
              <th>状态</th>
              <td>{status.valid ? "已激活" : "未激活"}</td>
            </tr>
            <tr>
              <th>授权对象</th>
              <td>{licenseStatus?.licensee ?? "-"}</td>
            </tr>
            <tr>
              <th>产品</th>
              <td>{licenseStatus?.product ?? "-"}</td>
            </tr>
            <tr>
              <th>有效期</th>
              <td>
                {licenseStatus?.not_before ?? "-"} ~{" "}
                {licenseStatus?.expires_at ?? "-"}
              </td>
            </tr>
            <tr>
              <th>特性</th>
              <td>
                {status.features.length === 0 ? (
                  "-"
                ) : (
                  <div className="chip-group">
                    {status.features.map((feature) => (
                      <span key={feature} className="chip">
                        {feature}
                      </span>
                    ))}
                  </div>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </section>
      {canUpload && (
        <div className="license-detail-grid">
          <section className="settings-form license-form">
            <h4>License 文件</h4>
            <input
              ref={fileInputRef}
              type="file"
              accept=".lic,.txt,.json"
              onChange={handleFileChange}
              disabled={uploading}
            />
            <p className="settings-overview-hint">
              支持 .lic / .txt / .json 文件，上传后立即生效。
            </p>
          </section>
          <section className="settings-form license-form">
            <h4>License 文本</h4>
            <form onSubmit={handleSubmitText}>
              <textarea
                rows={6}
                value={textValue}
                onChange={(event) => setTextValue(event.target.value)}
                placeholder="-----BEGIN LICENSE-----"
                disabled={textUploading}
              />
              <div className="settings-actions">
                <button
                  type="submit"
                  className="primary"
                  disabled={textUploading}
                >
                  {textUploading ? "导入中..." : "导入文本"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
};

interface RunDetailViewProps {
  clusters: ClusterConfig[];
  items: InspectionItem[];
  runs: InspectionRunListItem[];
  prometheusVersionOptions: string[];
  onDeleteRun: (runId: number, redirectPath?: string) => Promise<void>;
  onCancelRun: (runId: number, redirectPath?: string) => Promise<void>;
  onPauseRun: (runId: number) => Promise<void>;
  onResumeRun: (runId: number) => Promise<void>;
  clusterDisplayIds: Record<number, string>;
  runDisplayIds: Record<number, string>;
  license: LicenseCapabilities;
  canUpdateHistory: boolean;
  canDeleteHistory: boolean;
}

const RunDetailView = ({
  clusters,
  items,
  runs,
  prometheusVersionOptions,
  onDeleteRun,
  onCancelRun,
  onPauseRun,
  onResumeRun,
  clusterDisplayIds,
  runDisplayIds,
  license,
  canUpdateHistory,
  canDeleteHistory,
}: RunDetailViewProps) => {
  const { clusterKey, runKey } = useParams<{
    clusterKey?: string;
    runKey?: string;
  }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [run, setRun] = useState<InspectionRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const showOverviewEntryLoading = Boolean(
    (location.state as { fromOverviewDetail?: boolean } | null)?.fromOverviewDetail
  );
  const [statusFilter, setStatusFilter] = useState<
    InspectionResultStatus | "all"
  >("all");
  const [keyword, setKeyword] = useState("");
  const [refreshIndex, setRefreshIndex] = useState(0);
  const [resultPageSize, setResultPageSize] = useState<number>(
    RESULT_PAGE_SIZE_OPTIONS[0]
  );
  const [resultPage, setResultPage] = useState(1);
  const [resultPageInput, setResultPageInput] = useState("");
  const canRunInspections = license.canRunInspections;
  const canDownloadReports = license.canDownloadReports;
  const canManageHistoryActions = canUpdateHistory;
  const canRemoveHistory = canDeleteHistory;

  const resolvedClusterId = useMemo(
    () =>
      resolveClusterIdFromRouteKey(clusterKey, clusterDisplayIds, clusters),
    [clusterKey, clusterDisplayIds, clusters]
  );
  const resolvedRunId = useMemo(
    () => decodeRunKeyToId(runKey, runDisplayIds),
    [runKey, runDisplayIds]
  );
  const fallbackRun = useMemo(
    () =>
      typeof resolvedRunId === "number"
        ? runs.find((item) => item.id === resolvedRunId) ?? null
        : null,
    [runs, resolvedRunId]
  );
  const shouldPollRun = useMemo(() => {
    const target = run ?? fallbackRun;
    if (!target) {
      return false;
    }
    return (
      target.status === "running" ||
      target.status === "paused" ||
      target.status === "queued" ||
      (!target.report_path && target.progress >= 100)
    );
  }, [fallbackRun, run]);

  useEffect(() => {
    if (resolvedRunId === null) {
      setRun(null);
      setError("巡检编号无效，请返回重新选择。");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getInspectionRun(resolvedRunId)
      .then((data) => {
        if (!cancelled) {
          setRun(data);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          const message =
            err instanceof Error ? err.message : "获取巡检详情失败";
          setError(message);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [resolvedRunId, refreshIndex]);

  useEffect(() => {
    if (!shouldPollRun || resolvedRunId === null || typeof window === "undefined") {
      return;
    }
    let cancelled = false;
    let timerId: number | null = null;

    const poll = async () => {
      try {
        const data = await getInspectionRun(resolvedRunId);
        if (cancelled) {
          return;
        }
        setRun(data);
        setError(null);
        const shouldContinue =
          data.status === "running" ||
          data.status === "paused" ||
          data.status === "queued" ||
          (!data.report_path && data.progress >= 100);
        if (shouldContinue && !cancelled) {
          timerId = window.setTimeout(() => {
            if (!cancelled) {
              void poll();
            }
          }, 800);
        }
      } catch (err) {
        if (cancelled) {
          return;
        }
        const message =
          err instanceof Error ? err.message : "获取巡检详情失败";
        setError(message);
        timerId = window.setTimeout(() => {
          if (!cancelled) {
            void poll();
          }
        }, 1200);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
    };
  }, [resolvedRunId, shouldPollRun]);

  const effectiveClusterId =
    run?.cluster_id ?? fallbackRun?.cluster_id ?? resolvedClusterId;
  const cluster = useMemo(() => {
    if (!effectiveClusterId) {
      return null;
    }
    return clusters.find((item) => item.id === effectiveClusterId) ?? null;
  }, [clusters, effectiveClusterId]);

  const clusterSlug = cluster
    ? getClusterDisplayId(clusterDisplayIds, cluster.id, cluster)
    : clusterKey ?? "-";
  const runSlug =
    resolvedRunId !== null
      ? runDisplayIds[resolvedRunId] ?? `#${resolvedRunId}`
      : runKey ?? "-";
  const backTargetFromState = (
    location.state as { backTarget?: string } | null
  )?.backTarget;
  const backTarget =
    backTargetFromState ?? (cluster ? `/clusters/${clusterSlug}` : "/history");
  const summaryRun = run ?? fallbackRun;
  const handleBackNavigation = useCallback(() => {
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate(backTarget);
    }
  }, [backTarget, navigate]);

  const resultStats = useMemo(() => {
    const stats = {
      passed: 0,
      warning: 0,
      critical: 0,
      failed: 0,
    };
    (run?.results ?? []).forEach((result) => {
      if (result.status === "passed") {
        stats.passed += 1;
      } else if (result.status === "warning") {
        stats.warning += 1;
      } else if (result.status === "critical") {
        stats.critical += 1;
      } else if (result.status === "failed") {
        stats.failed += 1;
      }
    });
    return stats;
  }, [run]);

  const filteredResults = useMemo(() => {
    if (!run) {
      return [];
    }
    const keywordLower = keyword.trim().toLowerCase();
    return run.results.filter((result) => {
      const statusOk =
        statusFilter === "all" ? true : result.status === statusFilter;
      if (!statusOk) {
        return false;
      }
      if (!keywordLower) {
        return true;
      }
      const combined = `${result.item_name ?? ""} ${result.detail ?? ""} ${
        result.suggestion ?? ""
      }`.toLowerCase();
      return combined.includes(keywordLower);
    });
  }, [keyword, run, statusFilter]);

  const resultTotalPages = useMemo(
    () =>
      Math.max(
        1,
        Math.ceil(filteredResults.length / Math.max(resultPageSize, 1))
      ),
    [filteredResults.length, resultPageSize]
  );

  useEffect(() => {
    setResultPage(1);
    setResultPageInput("");
  }, [resultPageSize, statusFilter, keyword, run]);

  useEffect(() => {
    setResultPage((prev) => Math.min(Math.max(prev, 1), resultTotalPages));
  }, [resultTotalPages]);

  const pagedResults = useMemo(() => {
    const start = (resultPage - 1) * resultPageSize;
    return filteredResults.slice(start, start + resultPageSize);
  }, [filteredResults, resultPage, resultPageSize]);

  const totalItems =
    run?.total_items ?? summaryRun?.total_items ?? items.length ?? 0;
  const processedItems =
    run?.processed_items ?? summaryRun?.processed_items ?? 0;
  const progressValue =
    run?.progress ?? summaryRun?.progress ??
    (totalItems > 0 ? Math.round((processedItems / totalItems) * 100) : 0);
  const prometheusVersionLabel = useMemo(() => {
    const versions =
      summaryRun?.prometheus_versions?.filter(
        (value) => value && value.trim()
      ) ?? [];
    if (versions.length > 0) {
      return versions.join("、");
    }
    return normalizePrometheusVersion(
      summaryRun?.prometheus_version,
      prometheusVersionOptions
    );
  }, [
    summaryRun?.prometheus_version,
    summaryRun?.prometheus_versions,
    prometheusVersionOptions,
  ]);
  const clusterIsRancherLocal = resolveClusterRancherLocal(cluster);
  const rancherVersionLabel = clusterIsRancherLocal
    ? (resolveClusterRancherVersion(cluster).trim() || "未知")
    : null;

  if (resolvedRunId === null) {
    return (
      <div className="detail-empty">
        <p>巡检编号无效，无法打开详情。</p>
        <button
          type="button"
          className="secondary"
          onClick={() => navigate("/history")}
        >
          返回历史记录
        </button>
      </div>
    );
  }
  const statusLabel =
    summaryRun?.status_label ?? summaryRun?.status ?? "未知状态";
  const statusValue = summaryRun?.status ?? "queued";
  const canDelete = statusValue !== "running";
  const agentStatusLabel =
    summaryRun?.agent_status_label ??
    (summaryRun?.agent_status
      ? describeAgentStatus(summaryRun.agent_status)
      : null);
  const reportPdfUrl = run?.report_path
    ? getReportDownloadUrl(run.id, "pdf")
    : summaryRun?.report_path
      ? getReportDownloadUrl(summaryRun.id, "pdf")
      : null;
  const reportMdUrl = run?.report_path
    ? getReportDownloadUrl(run.id, "md")
    : summaryRun?.report_path
      ? getReportDownloadUrl(summaryRun.id, "md")
      : null;

  const handleRefresh = () => {
    setRefreshIndex((prev) => prev + 1);
  };

  const handleDelete = () => {
    if (resolvedRunId === null) {
      return;
    }
    if (!canRunInspections) {
      setError(license.reason ?? "当前 License 不支持巡检功能。");
      return;
    }
    if (!canRemoveHistory) {
      setError("当前账号无巡检记录删除权限。");
      return;
    }
    void onDeleteRun(resolvedRunId, backTarget);
  };

  const handleCancel = () => {
    if (resolvedRunId === null) {
      return;
    }
    if (!canRunInspections) {
      setError(license.reason ?? "当前 License 不支持巡检功能。");
      return;
    }
    if (!canManageHistoryActions) {
      setError("当前账号无巡检记录操作权限。");
      return;
    }
    void onCancelRun(resolvedRunId);
  };

  const handlePause = () => {
    if (resolvedRunId === null) {
      return;
    }
    if (!canRunInspections) {
      setError(license.reason ?? "当前 License 不支持巡检功能。");
      return;
    }
    if (!canManageHistoryActions) {
      setError("当前账号无巡检记录操作权限。");
      return;
    }
    void onPauseRun(resolvedRunId).then(() => {
      setRefreshIndex((prev) => prev + 1);
    });
  };

  const handleResume = () => {
    if (resolvedRunId === null) {
      return;
    }
    if (!canRunInspections) {
      setError(license.reason ?? "当前 License 不支持巡检功能。");
      return;
    }
    if (!canManageHistoryActions) {
      setError("当前账号无巡检记录操作权限。");
      return;
    }
    void onResumeRun(resolvedRunId).then(() => {
      setRefreshIndex((prev) => prev + 1);
    });
  };

  const handleResultPageChange = (offset: number) => {
    setResultPage((prev) => {
      const next = prev + offset;
      if (next < 1) {
        return 1;
      }
      if (next > resultTotalPages) {
        return resultTotalPages;
      }
      return next;
    });
  };

  const handleResultPageJump = () => {
    const trimmed = resultPageInput.trim();
    if (!trimmed) {
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isNaN(parsed) && Number.isInteger(parsed)) {
      const target = Math.min(Math.max(parsed, 1), resultTotalPages);
      setResultPage(target);
    }
    setResultPageInput("");
  };

  const extractResultLines = (value?: string | null) =>
    value
      ?.split(/\r?\n+/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean) ?? [];

  const formatResultDetail = (result: InspectionResult) => {
    const detail = (result.detail ?? "").trim();
    return detail || "未提供详情";
  };
  const parseCertificateDetail = (detailText: string) => {
    if (!detailText || detailText === "-") {
      return null;
    }
    const lines = detailText
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length < 2) {
      return null;
    }
    const headerLine = lines[0];
    const hasNameColumn =
      headerLine.includes("证书名称") && headerLine.includes("过期时间");
    const hasTwoColumns =
      headerLine.includes("组件") &&
      (headerLine.includes("过期时间") || headerLine.includes("证书过期时间"));
    if (!hasNameColumn && !hasTwoColumns) {
      return null;
    }
    const rows: Array<string[]> = [];
    for (const line of lines.slice(1)) {
      const tokens = line.split(/\s+/).filter(Boolean);
      if (tokens.length < 3) {
        continue;
      }
      if (hasTwoColumns && !hasNameColumn) {
        rows.push([tokens[0], tokens.slice(1).join(" ")]);
        continue;
      }
      let dateTokens: string[] = [];
      const lastToken = tokens[tokens.length - 1] ?? "";
      if (tokens.length >= 5 && (lastToken === "GMT" || lastToken === "UTC")) {
        dateTokens = tokens.slice(-5);
      } else if (/\d{4}-\d{2}-\d{2}/.test(lastToken)) {
        dateTokens = tokens.slice(-1);
      } else {
        dateTokens = tokens.slice(-3);
      }
      const nameTokens = tokens.slice(1, tokens.length - dateTokens.length);
      if (!nameTokens.length) {
        continue;
      }
      rows.push([tokens[0], nameTokens.join(" "), dateTokens.join(" ")]);
    }
    if (!rows.length) {
      return null;
    }
    return {
      headers: hasNameColumn ? ["组件", "证书名称", "过期时间"] : ["组件", "过期时间"],
      rows,
    };
  };
  const renderResultDetail = (detailText: string) => {
    const parsed = parseCertificateDetail(detailText);
    if (!parsed) {
      return detailText;
    }
    return (
      <table className="detail-cert-table">
        <thead>
          <tr>
            {parsed.headers.map((header) => (
              <th key={header}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {parsed.rows.map((row, index) => (
            <tr key={`${row[0]}-${index}`}>
              {row.map((cell, cellIndex) => (
                <td key={`${row[0]}-${index}-${cellIndex}`}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  };

  const formatResultSuggestion = (result: InspectionResult) => {
    if (result.status === "passed") {
      return "-";
    }
    const lines = extractResultLines(result.suggestion);
    return lines.length > 0 ? lines.join(" · ") : "未提供建议";
  };

  return (
    <>
      <div className="detail-header">
        <Link
          to={backTarget}
          className="back-button"
          onClick={handleBackNavigation}
        >
          返回上一页
        </Link>
        <div className="detail-header-actions">
          {canDownloadReports && reportPdfUrl ? (
            <>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  if (canDownloadReports && reportPdfUrl) {
                    window.open(reportPdfUrl, "_blank", "noreferrer");
                  }
                }}
                disabled={!canDownloadReports}
              >
                下载 PDF
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  if (canDownloadReports && reportMdUrl) {
                    window.open(reportMdUrl, "_blank", "noreferrer");
                  }
                }}
                disabled={!canDownloadReports}
              >
                下载 MD
              </button>
            </>
          ) : canDownloadReports ? (
            <button type="button" className="secondary" disabled>
              无可下载报告
            </button>
          ) : null}
          <button
            type="button"
            className="secondary"
            onClick={handleRefresh}
            disabled={loading}
          >
            {loading ? "刷新中..." : "刷新"}
          </button>
          {summaryRun?.status === "running" && canUpdateHistory && (
            <button
              type="button"
              className="secondary"
              onClick={handlePause}
              disabled={!canRunInspections}
            >
              暂停
            </button>
          )}
          {summaryRun?.status === "paused" && canUpdateHistory && (
            <button
              type="button"
              className="secondary"
              onClick={handleResume}
              disabled={!canRunInspections}
            >
              继续
            </button>
          )}
          {(summaryRun?.status === "running" ||
            summaryRun?.status === "paused") &&
            canUpdateHistory && (
            <button
              type="button"
              className="secondary"
              onClick={handleCancel}
              disabled={!canRunInspections}
            >
              取消任务
            </button>
          )}
          {canDeleteHistory && (
            <button
              type="button"
              className="secondary danger"
              onClick={handleDelete}
              disabled={!canDelete || !canRunInspections}
            >
              删除
            </button>
          )}
        </div>
      </div>

      {error && <div className="feedback error">{error}</div>}
      {loading && showOverviewEntryLoading && (
        <div className="feedback info">正在加载巡检详情...</div>
      )}

      <section className="card run-detail-card">
        <div className="run-detail-grid">
          <div>
            <strong>巡检编号：</strong>
            {runSlug}
          </div>
          <div>
            <strong>所属集群：</strong>
            {cluster ? `${cluster.name}（${clusterSlug}）` : clusterSlug}
          </div>
          <div>
            <strong>巡检人：</strong>
            {summaryRun?.operator || "-"}
          </div>
          <div>
            <strong>Prometheus 版本：</strong>
            {prometheusVersionLabel}
          </div>
          {rancherVersionLabel && (
            <div>
              <strong>Rancher 版本：</strong>
              {rancherVersionLabel}
            </div>
          )}
          <div>
            <strong>开始时间：</strong>
            {summaryRun?.created_at ? formatDate(summaryRun.created_at) : "-"}
          </div>
          <div>
            <strong>结束时间：</strong>
            {summaryRun?.completed_at
              ? formatDate(summaryRun.completed_at)
              : "-"}
          </div>
          <div>
            <strong>任务进度：</strong>
            {processedItems} / {totalItems}（{progressValue}%）
          </div>
        </div>
        <div className="run-status-line">
          {renderRunStatusBadge(statusValue, statusLabel, progressValue)}
          {summaryRun?.summary && (
            <p className="run-summary-text">{summaryRun.summary}</p>
          )}
        </div>
      </section>

      <section className="card inspection-results-card">
        <div className="card-header">
          <h2>巡检结果</h2>
          <div className="inspection-results-toolbar">
            <div className="inspection-results-filters">
              <label>
                状态筛选
                <select
                  value={statusFilter}
                  onChange={(event) =>
                    setStatusFilter(event.target.value as
                      | InspectionResultStatus
                      | "all")
                  }
                >
                  <option value="all">全部</option>
                  <option value="passed">通过</option>
                  <option value="warning">警告</option>
                  <option value="critical">严重</option>
                  <option value="failed">失败</option>
                </select>
              </label>
              <label>
                关键字
                <input
                  type="search"
                  placeholder="按巡检项 / 详情 / 建议搜索"
                  value={keyword}
                  onChange={(event) => setKeyword(event.target.value)}
                />
              </label>
            </div>
          </div>
        </div>
        <div className="inspection-result-stats">
          <span className="status-pill success">
            通过 {resultStats.passed}
          </span>
          <span className="status-pill warning">
            警告 {resultStats.warning}
          </span>
          <span className="status-pill critical">
            严重 {resultStats.critical}
          </span>
          <span className="status-pill danger">失败 {resultStats.failed}</span>
        </div>

        <div className="table-wrapper">
          {!run ? (
            <div className="placeholder">
              {loading ? "结果加载中..." : "请稍候，正在获取巡检结果。"}
            </div>
          ) : filteredResults.length === 0 ? (
            <div className="placeholder">暂无匹配的巡检结果</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>巡检项</th>
                  <th>状态</th>
                  <th>详情</th>
                  <th>建议</th>
                </tr>
              </thead>
              <tbody>
                {pagedResults.map((result) => {
                  const meta = getInspectionResultStatusMeta(result.status);
                  const detailText = formatResultDetail(result);
                  const suggestionText = formatResultSuggestion(result);
                  const detailContent = renderResultDetail(detailText);
                  return (
                    <tr key={result.id}>
                      <td>{result.item_name}</td>
                      <td>
                        <span className={`status-pill ${meta.className}`}>
                          {meta.label}
                        </span>
                      </td>
                      <td>
                        <div
                          className={`result-text detail-text${
                            detailText === "-" ? " empty" : ""
                          }`}
                        >
                          {detailContent}
                        </div>
                      </td>
                      <td>
                        <div
                          className={`result-text suggestion-text${
                            suggestionText === "-" ? " empty" : ""
                          }`}
                        >
                          {suggestionText}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        {filteredResults.length > 0 && (
          <div className="history-pagination-controls inspection-results-pagination">
            <label className="page-size-control">
              每页
              <select
                value={resultPageSize}
                onChange={(event) =>
                  setResultPageSize(Number(event.target.value))
                }
              >
                {RESULT_PAGE_SIZE_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <div className="history-pagination-buttons">
              <button
                type="button"
                className="secondary"
                onClick={() => handleResultPageChange(-1)}
                disabled={resultPage <= 1}
              >
                上一页
              </button>
              <span>
                第 {resultPage} / {resultTotalPages} 页
              </span>
              <button
                type="button"
                className="secondary"
                onClick={() => handleResultPageChange(1)}
                disabled={resultPage >= resultTotalPages}
              >
                下一页
              </button>
            </div>
            <label className="history-page-jump">
              跳转
              <input
                type="number"
                min={1}
                value={resultPageInput}
                onChange={(event) => setResultPageInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    handleResultPageJump();
                  }
                }}
              />
            </label>
            <button
              type="button"
              className="secondary"
              onClick={handleResultPageJump}
            >
              确定
            </button>
          </div>
        )}
      </section>
    </>
  );
};

interface ClusterEditModalProps {
  cluster: ClusterConfig;
  submitting: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (payload: {
    name: string;
    prometheusUrl: string;
    file: File | null;
    rancherUrl?: string;
    rancherApiKey?: string;
  }) => Promise<void>;
}

const ClusterEditModal = ({
  cluster,
  submitting,
  error,
  onCancel,
  onSubmit,
}: ClusterEditModalProps) => {
  const [name, setName] = useState(cluster.name);
  const [prometheusUrl, setPrometheusUrl] = useState(
    cluster.prometheus_url ?? ""
  );
  const [rancherUrl, setRancherUrl] = useState(
    resolveClusterRancherUrl(cluster)
  );
  const [rancherApiKey, setRancherApiKey] = useState(
    resolveClusterRancherApiKey(cluster)
  );
  const [kubeconfigModalOpen, setKubeconfigModalOpen] = useState(false);
  const [kubeconfigText, setKubeconfigText] = useState("");
  const [kubeconfigFile, setKubeconfigFile] = useState<File | null>(null);
  const [kubeconfigFileName, setKubeconfigFileName] = useState<string | null>(
    null
  );
  const [kubeconfigEdited, setKubeconfigEdited] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const enableServerKubeconfigEdit = false;

  useEffect(() => {
    setName(cluster.name);
    setPrometheusUrl(cluster.prometheus_url ?? "");
    setRancherUrl(resolveClusterRancherUrl(cluster));
    setRancherApiKey(resolveClusterRancherApiKey(cluster));
    setKubeconfigModalOpen(false);
    setKubeconfigText("");
    setKubeconfigFile(null);
    setKubeconfigFileName(null);
    setKubeconfigEdited(false);
    setFileError(null);
  }, [cluster]);

  const nameInputId = `cluster-edit-name-${cluster.id}`;
  const promInputId = `cluster-edit-prom-${cluster.id}`;
  const rancherUrlInputId = `cluster-edit-rancher-url-${cluster.id}`;
  const rancherKeyInputId = `cluster-edit-rancher-key-${cluster.id}`;
  const modalFileInputId = `cluster-edit-file-${cluster.id}`;
  const clusterIsRancherLocal = resolveClusterRancherLocal(cluster);

  const hasManualKubeconfig = useMemo(
    () => kubeconfigEdited && kubeconfigText.trim().length > 0,
    [kubeconfigEdited, kubeconfigText]
  );

  const kubeconfigReady = useMemo(
    () =>
      hasManualKubeconfig ||
      (!!kubeconfigFile && !kubeconfigEdited),
    [hasManualKubeconfig, kubeconfigEdited, kubeconfigFile]
  );

  const kubeconfigSummary = useMemo(() => {
    if (!kubeconfigReady) {
      return null;
    }
    if (hasManualKubeconfig) {
      return kubeconfigFileName
        ? `已基于 ${kubeconfigFileName} 进行编辑`
        : "已粘贴 kubeconfig 内容";
    }
    if (kubeconfigFile) {
      return `已选择文件: ${kubeconfigFile.name}`;
    }
    return "已导入 kubeconfig 内容";
  }, [
    hasManualKubeconfig,
    kubeconfigReady,
    kubeconfigFileName,
    kubeconfigFile,
  ]);

  const handleOpenModal = () => {
    setKubeconfigModalOpen(true);
  };

  const handleCloseModal = () => {
    setKubeconfigModalOpen(false);
  };

  const handleFileSelected = (file: File) => {
    setKubeconfigFile(file);
    setKubeconfigFileName(file.name);
    setKubeconfigEdited(false);
    setFileError(null);

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setKubeconfigText(reader.result);
      } else {
        setKubeconfigText("");
      }
    };
    reader.onerror = () => {
      setFileError("读取 kubeconfig 文件失败，请重试");
      setKubeconfigFile(null);
      setKubeconfigFileName(null);
      setKubeconfigText("");
      setKubeconfigEdited(false);
    };
    reader.readAsText(file);
  };

  const handleTextChange = (value: string) => {
    setKubeconfigText(value);
    setFileError(null);
    if (value.trim().length === 0) {
      setKubeconfigEdited(false);
      setKubeconfigFile(null);
      setKubeconfigFileName(null);
    } else {
      setKubeconfigEdited(true);
    }
  };

  const handleClear = () => {
    setKubeconfigText("");
    setKubeconfigFile(null);
    setKubeconfigFileName(null);
    setKubeconfigEdited(false);
    setFileError(null);
  };

  const resolveFileToUpload = () => {
    const hasText = kubeconfigText.trim().length > 0;
    if (!kubeconfigEdited && kubeconfigFile) {
      return kubeconfigFile;
    }
    if (hasText) {
      const filename =
        (kubeconfigFileName && kubeconfigFileName.trim()) ||
        "kubeconfig.yaml";
      return new File([kubeconfigText], filename, {
        type: "application/x-yaml",
      });
    }
    return null;
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fileForSubmit = enableServerKubeconfigEdit
      ? resolveFileToUpload()
      : null;
    await onSubmit({
      name,
      prometheusUrl,
      file: fileForSubmit,
      ...(clusterIsRancherLocal
        ? {
            rancherUrl,
            rancherApiKey,
          }
        : {}),
    });
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <form className="modal" onSubmit={handleSubmit}>
        <h3>编辑集群</h3>
        <div className="modal-field">
          <label htmlFor={nameInputId}>集群名称</label>
          <input
            id={nameInputId}
            type="text"
            value={name}
            readOnly
            disabled
            required
          />
          <div className="modal-hint">
            名称来自 Agent 创建，若需调整请删除后重新注册 Agent。
          </div>
        </div>
        <div className="modal-field">
          <label htmlFor={promInputId}>Prometheus 地址</label>
          <input
            id={promInputId}
            type="text"
            value={prometheusUrl}
            onChange={(event) => setPrometheusUrl(event.target.value)}
            disabled={submitting}
          />
        </div>
        {clusterIsRancherLocal && (
          <>
            <div className="modal-field">
              <label htmlFor={rancherUrlInputId}>Rancher 地址</label>
              <input
                id={rancherUrlInputId}
                type="text"
                value={rancherUrl}
                onChange={(event) => setRancherUrl(event.target.value)}
                disabled={submitting}
              />
            </div>
            <div className="modal-field">
              <label htmlFor={rancherKeyInputId}>Rancher API 密钥</label>
              <input
                id={rancherKeyInputId}
                type="password"
                value={rancherApiKey}
                onChange={(event) => setRancherApiKey(event.target.value)}
                disabled={submitting}
              />
            </div>
          </>
        )}
        {enableServerKubeconfigEdit ? (
          <div className="modal-field">
            <span className="modal-field-label">重新上传 kubeconfig(可选)</span>
            <button
              type="button"
              className={`cluster-upload-trigger${
                kubeconfigReady ? " ready" : ""
              }`}
              onClick={handleOpenModal}
              disabled={submitting}
            >
              {kubeconfigReady ? "查看 / 更新 kubeconfig" : "导入 kubeconfig"}
            </button>
            <div className="modal-kubeconfig-summary">
              {kubeconfigSummary ?? "支持上传文件或粘贴 YAML 内容"}
            </div>
          </div>
        ) : null}
        {fileError && <div className="feedback error">{fileError}</div>}
        {error && <div className="feedback error">{error}</div>}
        <div className="modal-actions">
          <button
            type="button"
            className="secondary"
            onClick={onCancel}
            disabled={submitting}
          >
            取消
          </button>
          <button type="submit" className="primary" disabled={submitting}>
            {submitting ? "保存中..." : "保存"}
          </button>
        </div>
      </form>
      {enableServerKubeconfigEdit && (
        <KubeconfigModal
          open={kubeconfigModalOpen}
          text={kubeconfigText}
          fileName={kubeconfigFileName}
          hasManualContent={hasManualKubeconfig}
          title="更新 kubeconfig"
          description="重新上传文件或粘贴最新的 kubeconfig 内容。"
          confirmLabel="确定"
          fileButtonLabel="选择文件"
          fileInputId={modalFileInputId}
          onClose={handleCloseModal}
          onFileSelected={handleFileSelected}
          onTextChange={handleTextChange}
          onClear={handleClear}
        />
      )}
    </div>
  );
};

interface ClusterNodesViewProps {
  clusters: ClusterConfig[];
  clusterDisplayIds: Record<number, string>;
  license: LicenseCapabilities;
}

const ClusterNodesView = ({
  clusters,
  clusterDisplayIds,
  license,
}: ClusterNodesViewProps) => {
  const { clusterKey } = useParams<{ clusterKey?: string }>();
  const navigate = useNavigate();
  const [output, setOutput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retrievedAt, setRetrievedAt] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNotice, setRefreshNotice] = useState<string | null>(null);
  const requestCounterRef = useRef(0);
  const refreshPollingRef = useRef<number | null>(null);
  const refreshInFlightRef = useRef(false);
  const refreshRequestRef = useRef(0);
  const refreshNoticeTimerRef = useRef<number | null>(null);
  const canManageClusters = license.canManageClusters;

  const resolvedClusterId = useMemo(
    () =>
      resolveClusterIdFromRouteKey(clusterKey, clusterDisplayIds, clusters),
    [clusterKey, clusterDisplayIds, clusters]
  );
  const cluster = useMemo(() => {
    if (resolvedClusterId === null) {
      return null;
    }
    return clusters.find((item) => item.id === resolvedClusterId) ?? null;
  }, [clusters, resolvedClusterId]);
  const clusterSlug = cluster
    ? getClusterDisplayId(clusterDisplayIds, cluster.id, cluster)
    : clusterKey ?? "-";

  const loadNodes = useCallback(
    async (options?: { showLoading?: boolean }) => {
      if (resolvedClusterId === null) {
        setError("集群标识无效，请返回重试。");
        setOutput("");
        setRetrievedAt(null);
        return;
      }
      const requestId = ++requestCounterRef.current;
      const showLoading = options?.showLoading ?? true;
      if (showLoading) {
        setLoading(true);
      }
      setError(null);
      try {
        const data = await getClusterNodes(resolvedClusterId);
        if (requestId !== requestCounterRef.current) {
          return;
        }
        setOutput((data.output || "").trim());
        setRetrievedAt(data.retrieved_at ?? null);
      } catch (err) {
        if (requestId !== requestCounterRef.current) {
          return;
        }
        const message =
          err instanceof Error ? err.message : "获取节点信息失败";
        setError(message);
        setOutput("");
        setRetrievedAt(null);
      } finally {
        if (requestId === requestCounterRef.current) {
          setLoading(false);
        }
      }
    },
    [resolvedClusterId]
  );

  useEffect(() => {
    void loadNodes({ showLoading: true });
    return () => {
      requestCounterRef.current += 1;
      refreshRequestRef.current += 1;
      if (refreshPollingRef.current !== null) {
        window.clearInterval(refreshPollingRef.current);
        refreshPollingRef.current = null;
      }
      if (refreshNoticeTimerRef.current !== null) {
        window.clearTimeout(refreshNoticeTimerRef.current);
        refreshNoticeTimerRef.current = null;
      }
    };
  }, [loadNodes]);

  const handleBackNavigation = useCallback(() => {
    if (window.history.length > 1) {
      navigate(-1);
      return;
    }
    if (cluster) {
      navigate(`/clusters/${clusterSlug}`);
      return;
    }
    navigate("/");
  }, [cluster, clusterSlug, navigate]);

  const handleRefreshNodes = useCallback(async () => {
    if (!canManageClusters) {
      setError(license.reason ?? "当前 License 不支持集群管理。");
      return;
    }
    if (resolvedClusterId === null) {
      setError("集群标识无效，请返回重试。");
      return;
    }
    if (refreshPollingRef.current !== null) {
      window.clearInterval(refreshPollingRef.current);
      refreshPollingRef.current = null;
    }
    setRefreshing(true);
    setRefreshNotice(null);
    setError(null);
    const baselineOutput = output;
    const baselineRetrievedAt = retrievedAt;
    const refreshRequestId = ++refreshRequestRef.current;
    try {
      await refreshClusterNodes(resolvedClusterId);
      setRefreshNotice("已通知 Agent 上报节点信息，正在等待更新...");
      let attempts = 0;
      const maxAttempts = 10;
      refreshPollingRef.current = window.setInterval(() => {
        if (refreshInFlightRef.current) {
          return;
        }
        if (refreshRequestRef.current !== refreshRequestId) {
          if (refreshPollingRef.current !== null) {
            window.clearInterval(refreshPollingRef.current);
            refreshPollingRef.current = null;
          }
          return;
        }
        refreshInFlightRef.current = true;
        attempts += 1;
        getClusterNodes(resolvedClusterId)
          .then((data) => {
            if (refreshRequestRef.current !== refreshRequestId) {
              return;
            }
            const nextOutput = (data.output || "").trim();
            const nextRetrievedAt = data.retrieved_at ?? null;
            const outputChanged =
              nextOutput && nextOutput !== (baselineOutput || "");
            const timeChanged =
              nextRetrievedAt && nextRetrievedAt !== baselineRetrievedAt;
            if (outputChanged || timeChanged) {
              setOutput(nextOutput);
              setRetrievedAt(nextRetrievedAt);
              setRefreshNotice("节点信息已更新。");
              if (refreshPollingRef.current !== null) {
                window.clearInterval(refreshPollingRef.current);
                refreshPollingRef.current = null;
              }
              setRefreshing(false);
              return;
            }
            if (attempts >= maxAttempts) {
              setRefreshNotice("已通知 Agent 上报节点信息，请稍后手动刷新。");
              if (refreshPollingRef.current !== null) {
                window.clearInterval(refreshPollingRef.current);
                refreshPollingRef.current = null;
              }
              setRefreshing(false);
            }
          })
          .catch((err) => {
            if (refreshRequestRef.current !== refreshRequestId) {
              return;
            }
            const message =
              err instanceof Error ? err.message : "刷新节点信息失败";
            setError(message);
            if (refreshPollingRef.current !== null) {
              window.clearInterval(refreshPollingRef.current);
              refreshPollingRef.current = null;
            }
            setRefreshing(false);
          })
          .finally(() => {
            refreshInFlightRef.current = false;
          });
      }, 2000);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "刷新节点信息失败";
      setError(message);
      setRefreshing(false);
    } finally {
      if (!refreshPollingRef.current) {
        setRefreshing(false);
      }
    }
  }, [output, retrievedAt, resolvedClusterId, canManageClusters, license.reason]);

  const parsedNodes = useMemo(() => {
    if (!output) {
      return null;
    }
    return parseNodesOutput(output);
  }, [output]);

  useEffect(() => {
    if (!refreshNotice || refreshNotice !== "节点信息已更新。") {
      return;
    }
    if (refreshNoticeTimerRef.current !== null) {
      window.clearTimeout(refreshNoticeTimerRef.current);
    }
    refreshNoticeTimerRef.current = window.setTimeout(() => {
      setRefreshNotice(null);
      refreshNoticeTimerRef.current = null;
    }, 2500);
  }, [refreshNotice]);

  return (
      <section className="card nodes-card">
        <div className="detail-header">
          <button
            type="button"
            className="back-button"
            onClick={handleBackNavigation}
          >
            返回上一页
          </button>
        </div>
        <div className="nodes-header">
          <div className="nodes-header-top">
            <div className="nodes-title-group">
              <h2>节点信息</h2>
              <span className="nodes-subtitle">
                {cluster ? `${cluster.name}（${clusterSlug}）` : clusterSlug}
              </span>
            </div>
            <button
              type="button"
              className="nodes-refresh-button"
              onClick={handleRefreshNodes}
              disabled={refreshing || loading || !canManageClusters}
            >
              {refreshing ? "刷新中..." : "刷新节点信息"}
            </button>
          </div>
          {retrievedAt && (
            <span className="nodes-meta">
              获取时间：{formatDate(retrievedAt)}
            </span>
          )}
        </div>
        {refreshNotice && <div className="feedback info">{refreshNotice}</div>}
        {error && <div className="feedback error">{error}</div>}
        {loading && <div className="feedback info">正在加载节点信息...</div>}
        {!loading && !error && output && parsedNodes && (
          <div className="nodes-table-wrapper">
            <table className="nodes-table">
              <thead>
                <tr>
                  {parsedNodes.columns.map((column) => (
                    <th key={column}>{column}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {parsedNodes.rows.map((row, rowIndex) => (
                  <tr key={`${rowIndex}-${row[0] ?? "row"}`}>
                    {parsedNodes.columns.map((column, columnIndex) => (
                      <td key={`${column}-${columnIndex}`}>
                        {row[columnIndex] || "-"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!loading && !error && output && !parsedNodes && (
          <pre className="nodes-output">{output}</pre>
        )}
        {!loading && !error && !output && (
          <div className="placeholder">暂无节点信息</div>
        )}
      </section>
    );
  };

interface LoginViewProps {
  loading: boolean;
  error: string | null;
  onSubmit: (username: string, password: string) => Promise<void>;
}

const LoginView = ({ loading, error, onSubmit }: LoginViewProps) => {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!username.trim() || !password) {
      setLocalError("请输入账号和密码");
      return;
    }
    setLocalError(null);
    await onSubmit(username.trim(), password);
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-header">
          <h1>Kubernetes 巡检中心</h1>
          <p>请先登录以继续使用系统</p>
        </div>
        {(localError || error) && (
          <div className="feedback error">{localError ?? error}</div>
        )}
        <form className="login-form" onSubmit={handleSubmit}>
          <label>
            账号
            <input
              type="text"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="例如：admin"
              disabled={loading}
              autoFocus
            />
          </label>
          <label>
            密码
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="请输入密码"
              disabled={loading}
            />
          </label>
          <button type="submit" className="primary" disabled={loading}>
            {loading ? "登录中..." : "登录"}
          </button>
        </form>
      </div>
    </div>
  );
};

interface PasswordModalProps {
  open: boolean;
  submitting: boolean;
  error: string | null;
  notice: string | null;
  onClose: () => void;
  onSubmit: (oldPassword: string, newPassword: string) => Promise<void>;
}

const PasswordModal = ({
  open,
  submitting,
  error,
  notice,
  onClose,
  onSubmit,
}: PasswordModalProps) => {
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setOldPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setLocalError(null);
    }
  }, [open]);

  if (!open) {
    return null;
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!oldPassword || !newPassword) {
      setLocalError("请完整填写当前密码和新密码");
      return;
    }
    if (newPassword.length < 6) {
      setLocalError("新密码至少 6 位");
      return;
    }
    if (newPassword !== confirmPassword) {
      setLocalError("两次输入的新密码不一致");
      return;
    }
    setLocalError(null);
    await onSubmit(oldPassword, newPassword);
  };

  return (
    <div className="modal-backdrop password-modal-backdrop" aria-modal="true">
      <div className="modal password-modal" role="dialog" aria-label="修改密码">
        <h3>修改密码</h3>
        {(localError || error) && (
          <div className="feedback error">{localError ?? error}</div>
        )}
        {notice && <div className="feedback success">{notice}</div>}
        <form onSubmit={handleSubmit}>
          <label>
            当前密码
            <input
              type="password"
              value={oldPassword}
              onChange={(event) => setOldPassword(event.target.value)}
              disabled={submitting}
            />
          </label>
          <label>
            新密码
            <input
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              disabled={submitting}
            />
          </label>
          <label>
            确认新密码
            <input
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              disabled={submitting}
            />
          </label>
          <div className="modal-actions">
            <button
              type="button"
              className="secondary"
              onClick={onClose}
              disabled={submitting}
            >
              取消
            </button>
            <button type="submit" className="primary" disabled={submitting}>
              {submitting ? "保存中..." : "确认修改"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

const App = () => {
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [passwordSubmitting, setPasswordSubmitting] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordNotice, setPasswordNotice] = useState<string | null>(null);

  const [clusters, setClusters] = useState<ClusterConfig[]>([]);
  const [agents, setAgents] = useState<InspectionAgent[]>([]);
  const [runs, setRuns] = useState<InspectionRunListItem[]>([]);
  const [items, setItems] = useState<InspectionItem[]>([]);
  const [schedules, setSchedules] = useState<InspectionSchedule[]>([]);
  const [overviewSummary, setOverviewSummary] = useState<OverviewSummary | null>(
    null
  );
  const [overviewMetrics, setOverviewMetrics] = useState<OverviewMetrics | null>(
    null
  );
  const isAuthenticated = authUser !== null;
  const permissionSet = useMemo(
    () => new Set(authUser?.permissions ?? []),
    [authUser?.permissions]
  );
  const hasPermission = useCallback(
    (permission: string) =>
      permissionSet.has("*") || permissionSet.has(permission),
    [permissionSet]
  );
  const canViewSchedule = hasPermission("schedule.read");
  const canCreateSchedule = hasPermission("schedule.create");
  const canUpdateSchedule = hasPermission("schedule.update");
  const canDeleteSchedule = hasPermission("schedule.delete");
  const canManageSchedule =
    canCreateSchedule || canUpdateSchedule || canDeleteSchedule;
  const canViewAudit = hasPermission("audit.read");
  const canViewHistory =
    hasPermission("history.read") || hasPermission("runRecord.read");
  const canUpdateHistory = hasPermission("history.update");
  const canDeleteHistory = hasPermission("history.delete");
  const canCreateHistory = hasPermission("history.create");
  const canViewRoles = hasPermission("role.read");
  const canCreateRoles = hasPermission("role.create");
  const canUpdateRoles = hasPermission("role.update");
  const canDeleteRoles = hasPermission("role.delete");
  const canViewUsers = hasPermission("user.read");
  const canCreateUsers = hasPermission("user.create");
  const canUpdateUsers = hasPermission("user.update");
  const canDeleteUsers = hasPermission("user.delete");
  const canReadReports = hasPermission("report.read");
  const canViewLicense = hasPermission("license.view");
  const canManageLicense = hasPermission("license.upload");
  const canViewInspectionItems = hasPermission("inspectionItem.read");
  const canManageInspectionItems =
    hasPermission("inspectionItem.create") ||
    hasPermission("inspectionItem.update") ||
    hasPermission("inspectionItem.delete");
  const canViewPrometheusVersions = hasPermission("prometheus.read");
  const canManagePrometheusVersions =
    hasPermission("prometheus.create") ||
    hasPermission("prometheus.update") ||
    hasPermission("prometheus.delete");
  const canViewClusterAgents = hasPermission("clusterAgent.read");
  const canCreateClusterAgents = hasPermission("clusterAgent.create");
  const canUpdateClusterAgents = hasPermission("clusterAgent.update");
  const canDeleteClusterAgents = hasPermission("clusterAgent.delete");
  const canTestClusterAgents =
    hasPermission("clusterAgent.test") || canUpdateClusterAgents;

  const [clusterError, setClusterError] = useState<string | null>(null);
  const [clusterNotice, setClusterNotice] = useState<string | null>(null);
  const [clusterNoticeType, setClusterNoticeType] =
    useState<NoticeType>(null);
  const [clusterNoticeScope, setClusterNoticeScope] =
    useState<NoticeScope | null>(null);
  const clearClusterNotice = useCallback(() => {
    setClusterNotice(null);
    setClusterNoticeType(null);
    setClusterNoticeScope(null);
  }, []);
  const showClusterNotice = useCallback(
    (scope: NoticeScope, message: string, type: Exclude<NoticeType, null>) => {
      setClusterNotice(message);
      setClusterNoticeType(type);
      setClusterNoticeScope(scope);
    },
    []
  );
  const [clusterUploading, setClusterUploading] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      setAuthLoading(true);
      try {
        const user = await getCurrentUser();
        if (cancelled) {
          return;
        }
        setAuthUser(user);
        setAuthError(null);
      } catch (err) {
        if (cancelled) {
          return;
        }
        const message =
          err instanceof Error ? err.message : "获取登录状态失败";
        const normalized = message.replace(/\s+/g, "");
        if (
          message === "未登录" ||
          normalized.includes("未登录") ||
          normalized.startsWith("{\"detail\"")
        ) {
          setAuthUser(null);
          setAuthError(null);
        } else {
          setAuthUser(null);
          setAuthError(message);
        }
      } finally {
        if (!cancelled) {
          setAuthLoading(false);
          setAuthChecked(true);
        }
      }
    };
    void check();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLogout = useCallback(async () => {
    setAuthSubmitting(true);
    setAuthError(null);
    try {
      await logout();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "退出登录失败";
      setAuthError(message);
    } finally {
      setAuthSubmitting(false);
      setAuthUser(null);
      setAuthChecked(true);
      setClusters([]);
      setAgents([]);
      setRuns([]);
      setItems([]);
      setSchedules([]);
      setRoles([]);
      setUsers([]);
      setSettingsTabId("overview");
    }
  }, []);

  const handleOpenPasswordModal = useCallback(() => {
    setPasswordError(null);
    setPasswordNotice(null);
    setPasswordModalOpen(true);
  }, []);

  const handleOpenSettings = useCallback(() => {
    setSettingsError(null);
    setSettingsNotice(null);
    setSettingsTabId("overview");
    navigate(SETTINGS_BASE_PATH, {
      replace: location.pathname.startsWith(SETTINGS_BASE_PATH),
    });
  }, [location.pathname, navigate]);

  const handleClosePasswordModal = useCallback(() => {
    setPasswordModalOpen(false);
    setPasswordError(null);
    setPasswordNotice(null);
  }, []);

  const handleChangePassword = useCallback(
    async (oldPassword: string, newPassword: string) => {
      setPasswordSubmitting(true);
      setPasswordError(null);
      setPasswordNotice(null);
      try {
        await changePassword(oldPassword, newPassword);
        setPasswordNotice("密码已更新");
        setPasswordModalOpen(false);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "修改密码失败";
        setPasswordError(message);
      } finally {
        setPasswordSubmitting(false);
      }
    },
    []
  );

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    if (!authUser || !authChecked) {
      document.body.classList.add("login-lock");
    } else {
      document.body.classList.remove("login-lock");
    }
    return () => {
      document.body.classList.remove("login-lock");
    };
  }, [authUser, authChecked]);
  const [clusterNameInput, setClusterNameInput] = useState("");
  const [clusterPromInput, setClusterPromInput] = useState("");
  const [clusterDefaultAgentIdInput, setClusterDefaultAgentIdInput] =
    useState<number | null>(null);
  const [kubeconfigModalOpen, setKubeconfigModalOpen] = useState(false);
  const [kubeconfigText, setKubeconfigText] = useState("");
  const [kubeconfigFile, setKubeconfigFile] = useState<File | null>(null);
  const [kubeconfigFileName, setKubeconfigFileName] = useState<string | null>(
    null
  );
  const [kubeconfigEdited, setKubeconfigEdited] = useState(false);

  const [inspectionNotice, setInspectionNotice] = useState<string | null>(null);
  const [inspectionError, setInspectionError] = useState<string | null>(null);
  const [inspectionLoading, setInspectionLoading] = useState(false);
  const [scheduleNotice, setScheduleNotice] = useState<string | null>(null);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [scheduleSubmitting, setScheduleSubmitting] = useState(false);

  const [selectedItemIds, setSelectedItemIdsState] = useState<number[]>([]);
  const [operator, setOperator] = useState("");
  const [prometheusVersionOptions, setPrometheusVersionOptions] = useState<
    string[]
  >(() => loadPrometheusVersionOptions());

  const [confirmState, setConfirmState] = useState<ConfirmDialogState | null>(
    null
  );

  const [clusterDisplayIds, setClusterDisplayIds] = useState<
    Record<number, string>
  >(() => loadStoredClusterDisplayIds());
  const [testingClusterIds, setTestingClusterIds] = useState<
    Record<number, boolean>
  >({});

  const [clusterEditState, setClusterEditState] =
    useState<ClusterConfig | null>(null);
  const [clusterEditSubmitting, setClusterEditSubmitting] = useState(false);
  const [clusterEditError, setClusterEditError] = useState<string | null>(null);
  const [agentNotice, setAgentNotice] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [agentSubmitting, setAgentSubmitting] = useState(false);
  const [generatedAgentCommand, setGeneratedAgentCommand] = useState<
    string | null
  >(null);
  const [pendingRefreshTargets, setPendingRefreshTargets] = useState<
    Record<number, number>
  >({});

  const [settingsSubmitting, setSettingsSubmitting] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);
  const [settingsTabId, setSettingsTabId] = useState<string>("overview");
  const previousSettingsPathRef = useRef<string>("/");
  const [roles, setRoles] = useState<AuthRole[]>([]);
  const [rolesLoading, setRolesLoading] = useState(false);
  const [rolesError, setRolesError] = useState<string | null>(null);
  const [rolesNotice, setRolesNotice] = useState<string | null>(null);
  const [roleSubmitting, setRoleSubmitting] = useState(false);
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [usersNotice, setUsersNotice] = useState<string | null>(null);
  const [usersSubmitting, setUsersSubmitting] = useState(false);
  const [licenseStatus, setLicenseStatus] = useState<LicenseStatus | null>(null);
  const [licenseError, setLicenseError] = useState<string | null>(null);
  const [licenseLoading, setLicenseLoading] = useState(false);
  const [licenseUploading, setLicenseUploading] = useState(false);
  const [licenseTextUploading, setLicenseTextUploading] = useState(false);

  useAutoClearError(authError, setAuthError);
  useAutoClearError(passwordError, setPasswordError);
  useAutoClearError(clusterError, setClusterError);
  useAutoClearError(inspectionError, setInspectionError);
  useAutoClearError(scheduleError, setScheduleError);
  useAutoClearError(clusterEditError, setClusterEditError);
  useAutoClearError(agentError, setAgentError);
  useAutoClearError(settingsError, setSettingsError);
  useAutoClearError(rolesError, setRolesError);
  useAutoClearError(usersError, setUsersError);
  useAutoClearError(licenseError, setLicenseError);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(
      PROMETHEUS_VERSION_STORAGE_KEY,
      JSON.stringify(prometheusVersionOptions)
    );
  }, [prometheusVersionOptions]);

  const licenseFeatureSet = useMemo(
    () =>
      new Set(
        (licenseStatus?.features ?? []).map((feature) =>
          feature.toLowerCase()
        )
      ),
    [licenseStatus]
  );
  const licenseValid = licenseStatus?.valid ?? false;
  const canManageClusters = licenseValid && licenseFeatureSet.has("clusters");
  const canRunInspections =
    licenseValid && licenseFeatureSet.has("inspections");
  const canManageAgents =
    licenseValid &&
    (licenseFeatureSet.has("agents") || licenseFeatureSet.has("inspections"));
  const canDownloadReports =
    licenseValid && licenseFeatureSet.has("reports") && canReadReports;
  const licenseReason = licenseValid
    ? null
    : licenseStatus?.reason ?? licenseError ?? "当前 License 未生效或未安装。";

  const licenseCapabilities = useMemo<LicenseCapabilities>(
    () => ({
      loading: licenseLoading,
      valid: licenseValid,
      reason: licenseReason,
      features: licenseStatus?.features ?? [],
      canManageClusters,
      canManageAgents,
      canRunInspections,
      canDownloadReports,
      status: licenseStatus,
    }),
    [
      licenseLoading,
      licenseValid,
      licenseReason,
      licenseStatus,
      canManageClusters,
      canManageAgents,
      canRunInspections,
      canDownloadReports,
    ]
  );

  useEffect(() => {
    if (!licenseValid) {
      return;
    }
    if (isLicenseRelatedMessage(licenseError)) {
      setLicenseError(null);
    }
    if (isLicenseRelatedMessage(clusterError)) {
      setClusterError(null);
    }
    if (isLicenseRelatedMessage(agentError)) {
      setAgentError(null);
    }
    if (isLicenseRelatedMessage(settingsError)) {
      setSettingsError(null);
    }
    if (isLicenseRelatedMessage(inspectionError)) {
      setInspectionError(null);
    }
    if (isLicenseRelatedMessage(scheduleError)) {
      setScheduleError(null);
    }
    if (isLicenseRelatedMessage(clusterNotice)) {
      clearClusterNotice();
    }
  }, [
    licenseValid,
    licenseError,
    clusterError,
    agentError,
    settingsError,
    inspectionError,
    scheduleError,
    clusterNotice,
    clearClusterNotice,
  ]);

  const refreshLicenseStatus = useCallback(async (): Promise<LicenseStatus | null> => {
    setLicenseLoading(true);
    try {
      const status = await getLicenseStatus();
      setLicenseStatus(status);
      setLicenseError(null);
      return status;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "获取 License 状态失败";
      setLicenseStatus(null);
      setLicenseError(message);
      return null;
    } finally {
      setLicenseLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }
    void refreshLicenseStatus();
  }, [isAuthenticated, refreshLicenseStatus]);

  useEffect(() => {
    if (typeof window === "undefined" || !isAuthenticated) {
      return;
    }
    const intervalId = window.setInterval(() => {
      void refreshLicenseStatus();
    }, LICENSE_POLL_INTERVAL);
    return () => window.clearInterval(intervalId);
  }, [isAuthenticated, refreshLicenseStatus]);

  useEffect(() => {
    if (typeof window === "undefined" || !isAuthenticated) {
      return;
    }
    const handleFocus = () => {
      void refreshLicenseStatus();
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [isAuthenticated, refreshLicenseStatus]);

  useEffect(() => {
    if (typeof window === "undefined" || !isAuthenticated) {
      return;
    }
    const expiresAt = parseDateValue(licenseStatus?.expires_at);
    if (!expiresAt) {
      return;
    }
    const delay = expiresAt.getTime() - Date.now();
    if (delay > 0 && delay > 2147483647) {
      return;
    }
    const timerId = window.setTimeout(
      () => {
        void refreshLicenseStatus();
      },
      Math.max(0, delay + 1000)
    );
    return () => window.clearTimeout(timerId);
  }, [isAuthenticated, licenseStatus?.expires_at, refreshLicenseStatus]);

  const refreshAgents = useCallback(async () => {
    if (!canViewClusterAgents) {
      setAgents([]);
      setAgentError(null);
      return null;
    }
    try {
      logWithTimestamp("info", "开始获取 Agent 列表");
      const data = await getAgents();
      setAgents(data);
      setAgentError(null);
      return data;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "获取 Agent 列表失败";
      logWithTimestamp("error", "获取 Agent 列表失败: %s", message);
      setAgentError(message);
      return null;
    }
  }, [canViewClusterAgents]);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }
    void refreshAgents();
  }, [isAuthenticated, refreshAgents]);

  const handleUploadLicenseFile = useCallback(
    async (file: File) => {
      if (!canManageLicense) {
        setLicenseError("当前账号无 License 上传权限");
        return null;
      }
      setLicenseUploading(true);
      try {
        const status = await uploadLicense(file);
        setLicenseStatus(status);
        setLicenseError(null);
        return status;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "上传 License 失败";
        setLicenseError(message);
        throw err instanceof Error ? err : new Error(message);
      } finally {
        setLicenseUploading(false);
      }
    },
    [canManageLicense]
  );

  const handleUploadLicenseText = useCallback(
    async (content: string) => {
      if (!canManageLicense) {
        setLicenseError("当前账号无 License 上传权限");
        return null;
      }
      setLicenseTextUploading(true);
      try {
        const status = await uploadLicenseText(content);
        setLicenseStatus(status);
        setLicenseError(null);
        return status;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "导入 License 失败";
        setLicenseError(message);
        throw err instanceof Error ? err : new Error(message);
      } finally {
        setLicenseTextUploading(false);
      }
    },
    [canManageLicense]
  );

  const sortedItems = useMemo(
    () => items.slice().sort(compareInspectionItemByName),
    [items]
  );

const location = useLocation();
const navigate = useNavigate();
const previousPathRef = useRef(location.pathname);
const [suppressOverviewDetailLoading, setSuppressOverviewDetailLoading] =
  useState(false);
useEffect(() => {
  const previousPath = previousPathRef.current;
  if (location.pathname === "/" && previousPath !== "/") {
    setSuppressOverviewDetailLoading(true);
  } else if (location.pathname !== "/") {
    setSuppressOverviewDetailLoading(false);
  }
  previousPathRef.current = location.pathname;
}, [location.pathname]);
const effectiveSuppressDetailLoading =
  suppressOverviewDetailLoading ||
  (location.pathname === "/" && previousPathRef.current !== "/");
const currentNoticeScope = useMemo(
  () => resolveNoticeScope(location.pathname),
  [location.pathname]
);
const loginRedirectState = useMemo(
  () => ({
    from: {
      pathname: location.pathname,
      search: location.search,
      hash: location.hash,
    },
  }),
  [location.pathname, location.search, location.hash]
);
  const handleLogin = useCallback(
    async (username: string, password: string) => {
      setAuthSubmitting(true);
      setAuthError(null);
      try {
        const user = await login(username, password);
        setAuthUser(user);
        setSettingsTabId("overview");
        setConfirmState(null);
        previousSettingsPathRef.current = "/";
        navigate("/", { replace: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : "登录失败";
        setAuthError(message);
      } finally {
        setAuthSubmitting(false);
      }
    },
    [navigate]
  );

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }
    const pathname = location.pathname;
    if (pathname.startsWith("/audit")) {
      return;
    }
    let description: string | null = null;
    let entityType: string | null = null;
    let entityId: number | null | undefined = undefined;
    if (pathname === "/" || pathname === "") {
      description = "查询首页";
      entityType = "overview";
    } else if (pathname.startsWith("/history")) {
      description = "查询巡检记录列表";
      entityType = "inspection_run";
    } else if (pathname.startsWith("/schedule")) {
      description = "查询定时巡检列表";
      entityType = "inspection_schedule";
    } else if (pathname === "/clusters") {
      description = "查询集群列表";
      entityType = "cluster_config";
    } else if (pathname.startsWith("/setting")) {
      const segments = pathname.split("/").filter(Boolean);
      const tab = (segments[1] ?? "overview").toLowerCase();
      if (tab === "inspection") {
        description = "查询巡检项设置";
        entityType = "inspection_item";
      } else if (tab === "prometheus-version") {
        description = "查询 Prometheus 版本设置";
        entityType = "prometheus_version";
      } else if (tab === "users") {
        description = "查询用户管理";
        entityType = "auth_user";
      } else if (tab === "license") {
        description = "查询 License 设置";
        entityType = "license";
      } else {
        description = "查询设置总览";
        entityType = "setting";
      }
    } else if (pathname.startsWith("/clusters/")) {
      const segments = pathname.split("/").filter(Boolean);
      const clusterKey = segments[1] ?? "";
      if (segments[2] === "runs" && segments[3]) {
        description = `查看巡检记录详情：${clusterKey}/${segments[3]}`;
        entityType = "inspection_run";
      } else if (segments[2] === "nodes") {
        description = `查看集群节点：${clusterKey}`;
        entityType = "cluster_config";
      } else {
        description = `查看集群概览：${clusterKey}`;
        entityType = "cluster_config";
      }
    }

    if (!description || !entityType) {
      return;
    }
    void recordAuditLog({
      action: "query",
      entity_type: entityType,
      entity_id: entityId,
      description,
    }).catch((err) => {
      logWithTimestamp(
        "warn",
        "记录审计查询失败: %s",
        err instanceof Error ? err.message : String(err)
      );
    });
  }, [isAuthenticated, location.pathname]);

  useEffect(() => {
    if (isAuthenticated) {
      return;
    }
    setSettingsTabId("overview");
    setConfirmState((prev) =>
      prev && prev.scope === "settings" ? null : prev
    );
    previousSettingsPathRef.current = "/";
  }, [isAuthenticated]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const updateOffset = () => {
      const nav = document.querySelector<HTMLElement>(".top-navigation");
      if (!nav) {
        return;
      }
      document.documentElement.style.setProperty(
        "--top-nav-height",
        `${nav.offsetHeight}px`
      );
    };
    updateOffset();
    window.addEventListener("resize", updateOffset);
    return () => {
      window.removeEventListener("resize", updateOffset);
    };
  }, []);

  const globalNotices = useMemo(() => {
    const notices: GlobalNotice[] = [];
    if (
      clusterError &&
      (currentNoticeScope === "overview" ||
        currentNoticeScope === "clusterDetail")
    ) {
      notices.push({
        key: "cluster-error",
        type: "error",
        message: clusterError,
      });
    }
    if (currentNoticeScope === "clusterDetail" && inspectionError) {
      notices.push({
        key: "inspection-error",
        type: "error",
        message: inspectionError,
      });
    }
    if (
      clusterNotice &&
      clusterNoticeType &&
      clusterNoticeScope === currentNoticeScope
    ) {
      notices.push({
        key: "cluster-notice",
        type: clusterNoticeType,
        message: clusterNotice,
      });
    }
    if (currentNoticeScope === "clusterDetail" && inspectionNotice) {
      notices.push({
        key: "inspection-notice",
        type: "success",
        message: inspectionNotice,
      });
    }
    return notices;
  }, [
    clusterError,
    clusterNotice,
    clusterNoticeScope,
    clusterNoticeType,
    currentNoticeScope,
    inspectionError,
    inspectionNotice,
  ]);

  const runDisplayIds = useMemo(
    () => createRunDisplayIdMap(runs, clusters),
    [runs, clusters]
  );

  useEffect(() => {
    const pathWithSearch = `${location.pathname}${location.search}${location.hash}`;
    if (!location.pathname.startsWith(SETTINGS_BASE_PATH)) {
      previousSettingsPathRef.current =
        pathWithSearch.length > 0 ? pathWithSearch : "/";
    }
  }, [location.pathname, location.search, location.hash]);

  useEffect(() => {
    if (!location.pathname.startsWith(SETTINGS_BASE_PATH)) {
      setConfirmState((prev) =>
        prev && prev.scope === "settings" ? null : prev
      );
      setSettingsTabId("overview");
    }
  }, [location.pathname]);

  const setClusterTesting = useCallback((clusterId: number, value: boolean) => {
    setTestingClusterIds((prev) => {
      const next = { ...prev };
      if (value) {
        next[clusterId] = true;
      } else {
        delete next[clusterId];
      }
      return next;
    });
  }, []);

  useEffect(() => {
    persistClusterDisplayIds(clusterDisplayIds);
  }, [clusterDisplayIds]);

  useEffect(() => {
    if (
      !clusterNotice ||
      !clusterNoticeType ||
      clusterNoticeType === "error" ||
      typeof window === "undefined"
    ) {
      return;
    }

    const timeout = window.setTimeout(() => {
      clearClusterNotice();
    }, 5000);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [clusterNotice, clusterNoticeType, clearClusterNotice]);

  useEffect(() => {
    if (!inspectionNotice || typeof window === "undefined") {
      return;
    }

    const timeout = window.setTimeout(() => {
      setInspectionNotice(null);
    }, 5000);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [inspectionNotice]);

  useEffect(() => {
    if (!settingsNotice || typeof window === "undefined") {
      return;
    }

    const timeout = window.setTimeout(() => {
      setSettingsNotice(null);
    }, 5000);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [settingsNotice]);

  useEffect(() => {
    if (!scheduleNotice || typeof window === "undefined") {
      return;
    }

    const timeout = window.setTimeout(() => {
      setScheduleNotice(null);
    }, 5000);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [scheduleNotice]);

  useEffect(() => {
    if ((!rolesNotice && !rolesError) || typeof window === "undefined") {
      return;
    }
    const timeout = window.setTimeout(() => {
      setRolesNotice(null);
      setRolesError(null);
    }, 5000);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [rolesNotice, rolesError]);

  useEffect(() => {
    if ((!usersNotice && !usersError) || typeof window === "undefined") {
      return;
    }
    const timeout = window.setTimeout(() => {
      setUsersNotice(null);
      setUsersError(null);
    }, 5000);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [usersNotice, usersError]);

  useEffect(() => {
    if (!agentNotice || typeof window === "undefined") {
      return;
    }
    const timeout = window.setTimeout(() => {
      setAgentNotice(null);
    }, 5000);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [agentNotice]);

  const refreshClusters = useCallback(async () => {
    if (!canViewClusterAgents) {
      setClusters([]);
      setClusterDisplayIds({});
      setClusterError(null);
      setOverviewSummary(null);
      return null;
    }
    try {
      logWithTimestamp("info", "开始获取集群信息");
      const data = await getClusters();
      setClusters((previous) =>
        areClusterListsEqual(previous, data) ? previous ?? data : data
      );
      setClusterDisplayIds((prev) => {
        const next = assignClusterDisplayIds(data, prev);
        return isSameDisplayMap(prev, next) ? prev : next;
      });
      setClusterError(null);
      logWithTimestamp("info", "集群信息获取成功,数量: %d", data.length);
      return data;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "获取集群信息失败";
      logWithTimestamp("error", "获取集群信息失败: %s", message);
      setClusterError(message);
      return null;
    }
  }, [canViewClusterAgents]);

  const refreshOverviewSummary = useCallback(async () => {
    if (!canViewClusterAgents) {
      setOverviewSummary(null);
      return null;
    }
    try {
      const data = await getOverviewSummary();
      setOverviewSummary(data);
      return data;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "获取首页汇总失败";
      logWithTimestamp("error", "获取首页汇总失败: %s", message);
      setOverviewSummary(null);
      return null;
    }
  }, [canViewClusterAgents]);

  const refreshOverviewMetrics = useCallback(async () => {
    if (!canViewClusterAgents) {
      setOverviewMetrics(null);
      return null;
    }
    try {
      const data = await getOverviewMetrics({
        minutes: 60,
        interval_seconds: 60,
      });
      setOverviewMetrics(data);
      return data;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "获取首页趋势失败";
      logWithTimestamp("error", "获取首页趋势失败: %s", message);
      setOverviewMetrics(null);
      return null;
    }
  }, [canViewClusterAgents]);

  const handleTestClusterConnection = useCallback(
    async (
      clusterId: number,
      options?: { quiet?: boolean }
    ) => {
      const { quiet } = options ?? {};
      if (!canTestClusterAgents) {
        const message = "当前账号无集群/Agent 连接测试权限。";
        setClusterError(null);
        if (!quiet) {
          clearClusterNotice();
        }
        showClusterNotice(
          quiet ? "overview" : currentNoticeScope,
          message,
          "error"
        );
        return;
      }
      if (!licenseCapabilities.canManageClusters) {
        const message =
          licenseCapabilities.reason ?? "当前 License 不支持集群管理。";
        setClusterError(null);
        if (!quiet) {
          clearClusterNotice();
        }
        showClusterNotice(
          quiet ? "overview" : currentNoticeScope,
          message,
          "error"
        );
        return;
      }
      if (!quiet) {
        clearClusterNotice();
        setClusterError(null);
      }
      setClusterTesting((prev) => ({ ...prev, [clusterId]: true }));
      try {
        logWithTimestamp("info", "开始测试集群连接: %s", clusterId);
        await testClusterConnection(clusterId);
        logWithTimestamp("info", "连接测试请求已下发: %s", clusterId);
        setPendingRefreshTargets((prev) => ({
          ...prev,
          [clusterId]: Date.now(),
        }));
        const noticeScope = quiet ? "overview" : currentNoticeScope;
        showClusterNotice(
          noticeScope,
          "连接测试已下发，等待结果返回。",
          "success"
        );
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "测试集群连接失败";
        logWithTimestamp("error", "测试集群连接失败: %s", message);
        showClusterNotice(quiet ? "overview" : currentNoticeScope, message, "error");
      } finally {
        setClusterTesting((prev) => ({ ...prev, [clusterId]: false }));
      }
    },
    [
      clearClusterNotice,
      currentNoticeScope,
      setClusterTesting,
      showClusterNotice,
      licenseCapabilities,
      canTestClusterAgents,
    ]
  );

  const refreshRuns = useCallback(async (): Promise<InspectionRunListItem[] | null> => {
    if (!canViewHistory && !hasPermission("result.read") && !hasPermission("report.read")) {
      setRuns([]);
      return null;
    }
    try {
      logWithTimestamp("info", "开始获取巡检历史");
      const data = await getInspectionRuns();
      const filtered = data.filter(
        (run) => run.operator !== CONNECTION_TEST_OPERATOR
      );
        setRuns((previous) =>
          areRunListsEqual(previous, filtered) ? previous ?? filtered : filtered
        );
        void refreshOverviewSummary();
        logWithTimestamp("info", "巡检历史获取成功,数量: %d", filtered.length);
        return filtered;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "获取巡检历史失败";
      logWithTimestamp("error", "获取巡检历史失败: %s", message);
      showClusterNotice(currentNoticeScope, message, "error");
      return null;
    }
  }, [
    currentNoticeScope,
    showClusterNotice,
    canViewHistory,
    hasPermission,
    refreshOverviewSummary,
  ]);

  const handleCreateAgent = useCallback(
    async (payload: {
      name: string;
      backend_url: string;
      description?: string;
      prometheus_url?: string | null;
      isRancherLocal?: boolean;
      rancherUrl?: string | null;
      rancherApiKey?: string | null;
    }) => {
      if (!canCreateClusterAgents) {
        setAgentError("当前账户没有创建 Agent 集群的权限。");
        return;
      }
      if (!licenseCapabilities.canManageAgents) {
        setAgentError(
          licenseCapabilities.reason ?? "当前 License 不支持 Agent 管理。"
        );
        return;
      }
      const normalizedName = payload.name.trim();
      if (!normalizedName) {
        setAgentError("Agent 名称不能为空。");
        return;
      }
      if (agents.some((agent) => agent.name.trim() === normalizedName)) {
        setAgentError(`Agent 名称 ${normalizedName} 已存在，请更换其他名称。`);
        return;
      }
      const { backend_url, ...requestPayload } = payload;
      const normalizedBackendUrl = normalizeBackendUrl(backend_url);
      const normalizedPrometheusUrl =
        requestPayload.prometheus_url?.trim() || undefined;
      const normalizedRancherUrl =
        requestPayload.rancherUrl?.trim() || undefined;
      const normalizedRancherApiKey =
        requestPayload.rancherApiKey?.trim() || undefined;
      setAgentSubmitting(true);
      setAgentNotice(null);
      setAgentError(null);
      setGeneratedAgentCommand(null);
      try {
        const response = await apiCreateAgent({
          ...requestPayload,
          name: normalizedName,
          prometheus_url: normalizedPrometheusUrl,
          ...(requestPayload.isRancherLocal
            ? {
                rancherUrl: normalizedRancherUrl,
                rancherApiKey: normalizedRancherApiKey,
              }
            : {}),
        });
        setGeneratedAgentCommand(
          buildAgentRegisterCommand({
            backendUrl: normalizedBackendUrl,
            token: response.token,
            clusterName: normalizedName,
            prometheusUrl: normalizedPrometheusUrl,
          })
        );
        setAgentNotice(
          `Agent ${response.name} 创建成功，请在目标节点执行注册命令。`
        );
        await Promise.all([refreshAgents(), refreshClusters()]);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "创建 Agent 失败";
        setAgentError(message);
        throw err instanceof Error ? err : new Error(message);
      } finally {
        setAgentSubmitting(false);
      }
    },
    [
      licenseCapabilities,
      agents,
      refreshAgents,
      refreshClusters,
      canCreateClusterAgents,
    ]
  );

  const handleClearAgentCommand = useCallback(() => {
    setGeneratedAgentCommand(null);
  }, []);

  useEffect(() => {
    if (!authUser || location.pathname !== "/login") {
      return;
    }
    const state = location.state as
      | {
          from?: {
            pathname?: string;
            search?: string;
            hash?: string;
          };
        }
      | undefined;
    const from = state?.from;
    const fromPath = from?.pathname && from.pathname !== "/login" ? from.pathname : "/";
    const target = `${fromPath}${from?.search ?? ""}${from?.hash ?? ""}`;
    navigate(target, { replace: true });
  }, [authUser, location.pathname, location.state, navigate]);

  const hasRunningRuns = useMemo(
    () =>
      runs.some(
        (run) =>
          run.status === "running" ||
          run.status === "queued" ||
          (!run.report_path && run.progress >= 100)
      ),
    [runs]
  );

  useEffect(() => {
    if (!isAuthenticated || !hasRunningRuns || typeof window === "undefined") {
      return;
    }
    let cancelled = false;
    let timerId: number | null = null;

    const poll = async () => {
      const data = await refreshRuns();
      if (cancelled) {
        return;
      }
      const shouldContinue = data
        ? data.some(
            (run) =>
              run.status === "running" ||
              run.status === "queued" ||
              (!run.report_path && run.progress >= 100)
          )
        : true;
      if (shouldContinue && !cancelled) {
        const delay = data
          ? RUN_STATUS_POLL_INTERVAL
          : RUN_STATUS_POLL_RETRY_INTERVAL;
        timerId = window.setTimeout(() => {
          if (!cancelled) {
            void poll();
          }
        }, delay);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
    };
  }, [isAuthenticated, hasRunningRuns, refreshRuns]);

  const refreshItems = useCallback(async () => {
    if (!canViewInspectionItems) {
      setItems([]);
      setInspectionError(null);
      return;
    }
    try {
      logWithTimestamp("info", "开始获取巡检项");
      const data = await getInspectionItems();
      setItems(data);
      setInspectionError(null);
      logWithTimestamp("info", "巡检项获取成功,数量: %d", data.length);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "获取巡检项失败";
      logWithTimestamp("error", "获取巡检项失败: %s", message);
      setInspectionError(message);
    }
  }, [canViewInspectionItems]);

  const refreshSchedules = useCallback(async () => {
    if (!canViewSchedule) {
      setSchedules([]);
      setScheduleError(null);
      return null;
    }
    try {
      logWithTimestamp("info", "开始获取定时巡检");
      const data = await getInspectionSchedules();
      setSchedules(data);
      setScheduleError(null);
      return data;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "获取定时巡检失败";
      logWithTimestamp("error", "获取定时巡检失败: %s", message);
      setScheduleError(message);
      return null;
    }
  }, [canViewSchedule]);

  const refreshRoles = useCallback(async () => {
    if (!canViewRoles) {
      setRoles([]);
      return null;
    }
    setRolesLoading(true);
    try {
      const data = await getRoles();
      setRoles(data);
      setRolesError(null);
      return data;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "获取角色列表失败";
      setRolesError(message);
      return null;
    } finally {
      setRolesLoading(false);
    }
  }, [canViewRoles]);

  const refreshUsers = useCallback(async () => {
    if (!canViewUsers) {
      setUsers([]);
      return null;
    }
    setUsersLoading(true);
    try {
      const data = await getUsers();
      setUsers(data);
      setUsersError(null);
      return data;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "获取用户列表失败";
      setUsersError(message);
      return null;
    } finally {
      setUsersLoading(false);
    }
  }, [canViewUsers]);

  const handleCreateRole = useCallback(
    async (payload: {
      name: string;
      display_name?: string;
      description?: string;
      permissions: string[];
    }) => {
      if (!canCreateRoles) {
        setRolesError("无权限创建角色");
        return;
      }
      setRoleSubmitting(true);
      setRolesError(null);
      setRolesNotice(null);
      try {
        await createRole(payload);
        setRolesNotice("角色创建成功");
        await refreshRoles();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "创建角色失败";
        setRolesError(message);
        throw err instanceof Error ? err : new Error(message);
      } finally {
        setRoleSubmitting(false);
      }
    },
    [canCreateRoles, refreshRoles]
  );

  const handleUpdateRole = useCallback(
    async (
      roleId: number,
      payload: {
        display_name?: string;
        description?: string;
        permissions?: string[];
      }
    ) => {
      if (!canUpdateRoles) {
        setRolesError("无权限修改角色");
        return;
      }
      setRoleSubmitting(true);
      setRolesError(null);
      setRolesNotice(null);
      try {
        await updateRole(roleId, payload);
        setRolesNotice("角色已更新");
        await refreshRoles();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "更新角色失败";
        setRolesError(message);
        throw err instanceof Error ? err : new Error(message);
      } finally {
        setRoleSubmitting(false);
      }
    },
    [canUpdateRoles, refreshRoles]
  );

  const handleDeleteRole = useCallback(
    (role: AuthRole) => {
      if (!canDeleteRoles) {
        setRolesError("无权限删除角色");
        return;
      }
      setConfirmState({
        title: "删除角色",
        message: `确认删除角色(${role.display_name || role.name})？该操作不可恢复。`,
        confirmLabel: "删除",
        variant: "danger",
        scope: "settings",
        onConfirm: async () => {
          setRoleSubmitting(true);
          setRolesError(null);
          setRolesNotice(null);
          try {
            await deleteRole(role.id);
            setRolesNotice("角色已删除");
            await refreshRoles();
          } catch (err) {
            const message =
              err instanceof Error ? err.message : "删除角色失败";
            setRolesError(message);
            throw err instanceof Error ? err : new Error(message);
          } finally {
            setRoleSubmitting(false);
          }
        },
      });
    },
    [canDeleteRoles, refreshRoles]
  );

  const handleCreateUser = useCallback(
    async (payload: {
      username: string;
      display_name?: string;
      password: string;
      roles: string[];
    }) => {
      if (!canCreateUsers) {
        setUsersError("无权限创建用户");
        return;
      }
      if (!licenseCapabilities.valid) {
        setUsersError(
          licenseCapabilities.reason ?? "当前 License 未生效或未安装。"
        );
        setUsersNotice(null);
        return;
      }
      setUsersSubmitting(true);
      setUsersError(null);
      setUsersNotice(null);
      try {
        await createUser(payload);
        setUsersNotice("用户创建成功");
        await refreshUsers();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "用户创建失败";
        setUsersError(message);
      } finally {
        setUsersSubmitting(false);
      }
    },
    [canCreateUsers, refreshUsers, licenseCapabilities]
  );

  const handleUpdateUser = useCallback(
    async (
      userId: number,
      payload: {
        display_name?: string;
        password?: string;
        roles?: string[];
        is_active?: boolean;
      }
    ) => {
      if (!canUpdateUsers) {
        setUsersError("无权限修改用户");
        return;
      }
      if (!licenseCapabilities.valid) {
        setUsersError(
          licenseCapabilities.reason ?? "当前 License 未生效或未安装。"
        );
        setUsersNotice(null);
        return;
      }
      setUsersSubmitting(true);
      setUsersError(null);
      setUsersNotice(null);
      try {
        await updateUser(userId, payload);
        setUsersNotice("用户已更新");
        await refreshUsers();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "用户更新失败";
        setUsersError(message);
      } finally {
        setUsersSubmitting(false);
      }
    },
    [canUpdateUsers, refreshUsers, licenseCapabilities]
  );

  const handleDeleteUser = useCallback(
    (user: AuthUser) => {
      if (!canDeleteUsers) {
        setUsersError("无权限删除用户");
        return;
      }
      if (!licenseCapabilities.valid) {
        setUsersError(
          licenseCapabilities.reason ?? "当前 License 未生效或未安装。"
        );
        setUsersNotice(null);
        return;
      }
      setConfirmState({
        title: "删除用户",
        message: `确认删除用户(${user.username})？该操作不可恢复。`,
        confirmLabel: "删除",
        variant: "danger",
        scope: "settings",
        onConfirm: async () => {
          setUsersSubmitting(true);
          setUsersError(null);
          setUsersNotice(null);
          try {
            await deleteUser(user.id);
            setUsersNotice("用户已删除");
            await refreshUsers();
          } catch (err) {
            const message =
              err instanceof Error ? err.message : "用户删除失败";
            setUsersError(message);
            throw err instanceof Error ? err : new Error(message);
          } finally {
            setUsersSubmitting(false);
          }
        },
      });
    },
    [canDeleteUsers, refreshUsers, licenseCapabilities]
  );

  const pendingClusterIds = useMemo(
    () =>
      clusters
        .filter(
          (cluster) =>
            cluster.connection_status === "pending" ||
            (cluster.connection_status === "warning" &&
              (!cluster.last_checked_at ||
                (cluster.connection_message || "").includes("等待 Agent 注册")))
        )
        .map((cluster) => cluster.id),
    [clusters]
  );

  const handleLeaveSettings = useCallback(() => {
    setConfirmState((prev) =>
      prev && prev.scope === "settings" ? null : prev
    );
    setSettingsTabId("overview");
    const target =
      previousSettingsPathRef.current &&
      !previousSettingsPathRef.current.startsWith(SETTINGS_BASE_PATH)
        ? previousSettingsPathRef.current
        : "/";
    navigate(target, {
      replace: true,
    });
  }, [navigate]);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }
    void refreshClusters();
    void refreshRuns();
    void refreshOverviewSummary();
    void refreshOverviewMetrics();
    void refreshItems();
    void refreshSchedules();
    void refreshRoles();
    void refreshUsers();
  }, [
    isAuthenticated,
    refreshClusters,
    refreshRuns,
    refreshOverviewSummary,
    refreshOverviewMetrics,
    refreshItems,
    refreshSchedules,
    refreshRoles,
    refreshUsers,
  ]);

  useEffect(() => {
    if (typeof window === "undefined" || !isAuthenticated) {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshClusters();
      void refreshOverviewSummary();
      void refreshOverviewMetrics();
    }, CLUSTER_HEARTBEAT_REFRESH_INTERVAL);
    return () => {
      window.clearInterval(timer);
    };
  }, [
    isAuthenticated,
    refreshClusters,
    refreshOverviewSummary,
    refreshOverviewMetrics,
  ]);

  useEffect(() => {
    if (typeof window === "undefined" || !isAuthenticated) {
      return;
    }
    if (!location.pathname.startsWith("/schedule")) {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshSchedules();
    }, SCHEDULE_REFRESH_INTERVAL);
    return () => {
      window.clearInterval(timer);
    };
  }, [isAuthenticated, location.pathname, refreshSchedules]);

  useEffect(() => {
    if (
      !isAuthenticated ||
      pendingClusterIds.length === 0 ||
      typeof window === "undefined"
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshClusters();
    }, 5000);
    return () => {
      window.clearInterval(timer);
    };
  }, [isAuthenticated, pendingClusterIds, refreshClusters]);

  useEffect(() => {
    setPendingRefreshTargets((prev) => {
      if (!Object.keys(prev).length) {
        return prev;
      }
      const next: Record<number, number> = {};
      clusters.forEach((cluster) => {
        const status = cluster.connection_status as string;
        const shouldKeep =
          prev[cluster.id] &&
          (status === "pending" ||
            (status === "warning" &&
              (!cluster.last_checked_at ||
                (cluster.connection_message || "").includes("等待 Agent 注册") ||
                (cluster.connection_message || "").includes("连接测试"))));
        if (shouldKeep) {
          next[cluster.id] = prev[cluster.id];
        }
      });
      if (Object.keys(next).length === Object.keys(prev).length) {
        return prev;
      }
      return next;
    });
  }, [clusters]);

  useEffect(() => {
    if (
      !isAuthenticated ||
      !Object.keys(pendingRefreshTargets).length ||
      typeof window === "undefined"
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshClusters();
    }, 4000);
    return () => {
      window.clearInterval(timer);
    };
  }, [isAuthenticated, pendingRefreshTargets, refreshClusters]);

  const resetClusterUploadForm = () => {
    setClusterNameInput("");
    setClusterPromInput("");
    setClusterDefaultAgentIdInput(null);
    setKubeconfigText("");
    setKubeconfigFile(null);
    setKubeconfigFileName(null);
    setKubeconfigEdited(false);
    setKubeconfigModalOpen(false);
  };

  const handleOpenKubeconfigModal = useCallback(() => {
    if (!canCreateClusterAgents) {
      setClusterError("当前账号无集群/Agent 创建权限。");
      return;
    }
    if (!licenseCapabilities.canManageClusters) {
      setClusterError(
        licenseCapabilities.reason ?? "当前 License 不支持集群管理。"
      );
      return;
    }
    setKubeconfigModalOpen(true);
  }, [licenseCapabilities, setClusterError, canCreateClusterAgents]);

  const handleCloseKubeconfigModal = useCallback(() => {
    setKubeconfigModalOpen(false);
  }, []);

  const handleKubeconfigFileSelected = useCallback((file: File) => {
    setKubeconfigFile(file);
    setKubeconfigFileName(file.name);
    setKubeconfigEdited(false);

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setKubeconfigText(reader.result);
        setClusterError(null);
      } else {
        setKubeconfigText("");
      }
    };
    reader.onerror = () => {
      setClusterError("读取 kubeconfig 文件失败，请重试");
      setKubeconfigFile(null);
      setKubeconfigFileName(null);
      setKubeconfigText("");
      setKubeconfigEdited(false);
    };
    reader.readAsText(file);
  }, []);

  const handleKubeconfigTextChange = useCallback((value: string) => {
    setKubeconfigText(value);
    if (value.trim().length === 0) {
      setKubeconfigEdited(false);
      setKubeconfigFile(null);
      setKubeconfigFileName(null);
    } else {
      setKubeconfigEdited(true);
    }
    setClusterError(null);
  }, []);

  const handleKubeconfigClear = useCallback(() => {
    setKubeconfigText("");
    setKubeconfigFile(null);
    setKubeconfigFileName(null);
    setKubeconfigEdited(false);
  }, []);

  const handleUploadCluster = useCallback(async () => {
    if (!canCreateClusterAgents) {
      setClusterError("当前账号无集群/Agent 创建权限。");
      return;
    }
    if (!licenseCapabilities.canManageClusters) {
      setClusterError(
        licenseCapabilities.reason ?? "当前 License 不支持集群管理。"
      );
      return;
    }
    if (!licenseCapabilities.canManageAgents) {
      setClusterError(
        licenseCapabilities.reason ?? "当前 License 不支持 Agent 管理。"
      );
      return;
    }

    if (
      clusterDefaultAgentIdInput === null ||
      Number.isNaN(clusterDefaultAgentIdInput)
    ) {
      setClusterError("未检测到可用 Agent，请先创建 Agent 后再上传。");
      return;
    }

    const hasText = kubeconfigText.trim().length > 0;
    let fileToUpload: File | null = null;

    if (!kubeconfigEdited && kubeconfigFile) {
      fileToUpload = kubeconfigFile;
    } else if (hasText) {
      const filename =
        (kubeconfigFileName && kubeconfigFileName.trim()) ||
        "kubeconfig.yaml";
      fileToUpload = new File([kubeconfigText], filename, {
        type: "application/x-yaml",
      });
    }

    if (!fileToUpload) {
      setClusterError("请先导入或粘贴 kubeconfig 内容");
      setKubeconfigModalOpen(true);
      return;
    }

    const formData = new FormData();
    formData.append("file", fileToUpload);
    if (clusterNameInput.trim()) {
      formData.append("name", clusterNameInput.trim());
    }
    if (clusterPromInput.trim()) {
      formData.append("prometheus_url", clusterPromInput.trim());
    }
    formData.append("execution_mode", "agent");
    formData.append("default_agent_id", String(clusterDefaultAgentIdInput));

    setClusterUploading(true);
    setClusterError(null);
    clearClusterNotice();

    try {
      logWithTimestamp(
        "info",
        "上传集群: %s",
        clusterNameInput || fileToUpload.name
      );
      await registerCluster(formData);
      resetClusterUploadForm();
      await refreshClusters();
      await refreshRuns();
      await refreshAgents();
      showClusterNotice(currentNoticeScope, "集群注册成功", "success");
      logWithTimestamp("info", "集群注册成功");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "上传集群失败";
      logWithTimestamp("error", "上传集群失败: %s", message);
      setClusterError(message);
    } finally {
      setClusterUploading(false);
    }
  }, [
    clusterNameInput,
    clusterPromInput,
    clusterDefaultAgentIdInput,
    kubeconfigEdited,
    kubeconfigFile,
    kubeconfigFileName,
    kubeconfigText,
    refreshClusters,
    refreshRuns,
    refreshAgents,
    clearClusterNotice,
    currentNoticeScope,
    showClusterNotice,
    licenseCapabilities,
    canCreateClusterAgents,
  ]);

  const handleUpdateClusterExecution = useCallback(
    async (clusterId: number, payload: { defaultAgentId: number | null }) => {
      if (!canUpdateClusterAgents) {
        const reason = "当前账号无集群/Agent 修改权限。";
        setClusterError(reason);
        throw new Error(reason);
      }
      if (!licenseCapabilities.canManageClusters) {
        const reason =
          licenseCapabilities.reason ?? "当前 License 不支持集群管理。";
        setClusterError(reason);
        throw new Error(reason);
      }
      if (!licenseCapabilities.canManageAgents) {
        const reason =
          licenseCapabilities.reason ?? "当前 License 不支持 Agent 管理。";
        setClusterError(reason);
        throw new Error(reason);
      }
      const formData = new FormData();
      formData.append("execution_mode", "agent");
      if (payload.defaultAgentId !== null) {
        formData.append("default_agent_id", String(payload.defaultAgentId));
      }
      try {
        logWithTimestamp("info", "更新集群执行配置: %s", clusterId);
        await updateCluster(clusterId, formData);
        await refreshClusters();
        await refreshRuns();
        await refreshAgents();
        showClusterNotice("clusterDetail", "执行配置已更新", "success");
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "更新执行配置失败";
        logWithTimestamp("error", "更新执行配置失败: %s", message);
        setClusterError(message);
        throw err instanceof Error ? err : new Error(message);
      }
    },
    [
      licenseCapabilities,
      refreshClusters,
      refreshRuns,
      refreshAgents,
      showClusterNotice,
      canUpdateClusterAgents,
    ]
  );
  useEffect(() => {
    // 预留引用，避免未来依赖时重新声明
  }, [handleUpdateClusterExecution]);
const hasManualKubeconfig = useMemo(
    () => kubeconfigEdited && kubeconfigText.trim().length > 0,
    [kubeconfigEdited, kubeconfigText]
  );

  const kubeconfigReady = useMemo(
    () =>
      hasManualKubeconfig ||
      (!!kubeconfigFile && !kubeconfigEdited),
    [hasManualKubeconfig, kubeconfigEdited, kubeconfigFile]
  );

  const kubeconfigSummary = useMemo(() => {
    if (!kubeconfigReady) {
      return null;
    }
    if (hasManualKubeconfig) {
      return kubeconfigFileName
        ? `已基于 ${kubeconfigFileName} 进行编辑`
        : "已粘贴 kubeconfig 内容";
    }
    if (kubeconfigFile) {
      return `已选择文件: ${kubeconfigFile.name}`;
    }
    return "已导入 kubeconfig 内容";
  }, [
    hasManualKubeconfig,
    kubeconfigReady,
    kubeconfigFileName,
    kubeconfigFile,
  ]);

  const setSelectedItemIds = useCallback(
    (updater: (prev: number[]) => number[]) => {
      setSelectedItemIdsState((prev) => updater(prev));
    },
    []
  );

  const handleStartInspection = useCallback(
    async (clusterId: number, prometheusVersion: string) => {
      if (!canCreateHistory) {
        setInspectionError("当前账号无历史巡检创建权限。");
        return;
      }
      if (!licenseCapabilities.canRunInspections) {
        setInspectionError(
          licenseCapabilities.reason ?? "当前 License 不支持巡检功能。"
        );
        return;
      }
      if (selectedItemIds.length === 0) {
        setInspectionError("请至少选择一个巡检项");
        return;
      }

      setInspectionLoading(true);
      setInspectionError(null);
      setInspectionNotice(null);

      try {
        const operatorName = operator.trim();
        logWithTimestamp(
          "info",
          "创建巡检: cluster=%s items=%s",
          clusterId,
          selectedItemIds.join(",")
        );
        const run = await createInspectionRun(
          selectedItemIds,
          clusterId,
          operatorName || undefined,
          prometheusVersion
        );
        setInspectionNotice("巡检任务已启动，状态会自动更新。");
        setSelectedItemIdsState([]);
        await refreshRuns();
        await refreshClusters();
        if (run?.id) {
          logWithTimestamp("info", "巡检任务创建成功: %s", run.id);
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "创建巡检失败";
        logWithTimestamp("error", "创建巡检失败: %s", message);
        setInspectionError(message);
      } finally {
      setInspectionLoading(false);
    }
  },
  [
    selectedItemIds,
    operator,
    refreshRuns,
    refreshClusters,
    licenseCapabilities,
    canCreateHistory,
  ]
);

  const handleDeleteClustersBulk = useCallback(
    (clusterIds: number[]): Promise<void> => {
      if (!canDeleteClusterAgents) {
        const message = "当前账号无集群/Agent 删除权限。";
        setClusterError(message);
        return Promise.resolve();
      }
      if (!licenseCapabilities.canManageClusters) {
        const message =
          licenseCapabilities.reason ?? "当前 License 不支持集群管理。";
        setClusterError(message);
        return Promise.resolve();
      }
      const targets = clusters.filter((cluster) =>
        clusterIds.includes(cluster.id)
      );
      if (targets.length === 0) {
        return Promise.resolve();
      }
      setConfirmState({
        title: "批量删除集群",
        message: `确认删除当前筛选结果中选中的 ${targets.length} 个集群？该操作不可恢复。`,
        confirmLabel: "删除",
        variant: "danger",
        options: [
          {
            id: "deleteLocalFiles",
            label: "同时删除关联巡检记录及报告文件",
          },
        ],
          onConfirm: async (optionsMap) => {
            try {
              const deleteFiles = Boolean(optionsMap?.deleteLocalFiles);
              for (const cluster of targets) {
                logWithTimestamp("info", "删除集群: %s", cluster.id);
                await apiDeleteCluster(cluster.id, { deleteFiles });
              }
              const targetIds = targets.map((cluster) => cluster.id);
              const targetNames = new Set(targets.map((cluster) => cluster.name.trim()));
              setClusters((prev) =>
                prev.filter((cluster) => !targetIds.includes(cluster.id))
              );
              setOverviewMetrics((prev) => {
                if (!prev) {
                  return prev;
                }
                const nextSeries = prev.series.filter(
                  (series) => !targetIds.includes(series.cluster_id)
                );
                return nextSeries.length === prev.series.length
                  ? prev
                  : { ...prev, series: nextSeries };
              });
              setClusterDisplayIds((prev) => {
                let changed = false;
                const next = { ...prev };
                targetIds.forEach((clusterId) => {
                  if (clusterId in next) {
                  delete next[clusterId];
                  changed = true;
                }
              });
              return changed ? next : prev;
            });
            setAgents((prev) =>
              prev.filter((agent) => {
                const agentClusterId = agent.cluster_id ?? null;
                if (agentClusterId !== null && targetIds.includes(agentClusterId)) {
                  return false;
                }
                const agentName = agent.name?.trim() ?? "";
                const agentClusterName = agent.cluster_name?.trim() ?? "";
                if (agentName && targetNames.has(agentName)) {
                  return false;
                }
                if (agentClusterName && targetNames.has(agentClusterName)) {
                  return false;
                }
                return true;
                })
              );
              await refreshClusters();
              await refreshRuns();
              await refreshAgents();
              await refreshOverviewSummary();
              await refreshOverviewMetrics();
              showClusterNotice("overview", `已删除 ${targets.length} 个集群`, "success");
            } catch (err) {
              const message =
                err instanceof Error ? err.message : "删除集群失败";
              logWithTimestamp("error", "批量删除集群失败: %s", message);
            showClusterNotice("overview", message, "error");
            throw err instanceof Error ? err : new Error(message);
          }
        },
      });
      return Promise.resolve();
    },
    [
      clusters,
      refreshAgents,
      refreshClusters,
      refreshOverviewMetrics,
      refreshOverviewSummary,
      refreshRuns,
      setOverviewMetrics,
      setAgents,
      setClusterDisplayIds,
      setClusters,
      showClusterNotice,
      licenseCapabilities,
      setClusterError,
      canDeleteClusterAgents,
    ]
  );

  const handleDeleteCluster = useCallback(
    (cluster: ClusterConfig): Promise<void> => {
      if (!canDeleteClusterAgents) {
        const message = "当前账号无集群/Agent 删除权限。";
        setClusterError(message);
        return Promise.resolve();
      }
      if (!licenseCapabilities.canManageClusters) {
        const message =
          licenseCapabilities.reason ?? "当前 License 不支持集群管理。";
        setClusterError(message);
        return Promise.resolve();
      }
      setConfirmState({
        title: "删除集群",
        message: `确认删除集群(${cluster.name})？该操作不可恢复。`,
        confirmLabel: "删除",
        variant: "danger",
        options: [
          {
            id: "deleteLocalFiles",
            label: "同时删除关联巡检记录及报告文件",
          },
        ],
          onConfirm: async (optionsMap) => {
            try {
              logWithTimestamp("info", "删除集群: %s", cluster.id);
              const deleteFiles = Boolean(optionsMap?.deleteLocalFiles);
              await apiDeleteCluster(cluster.id, { deleteFiles });
              const clusterName = cluster.name.trim();
              setClusters((prev) => prev.filter((item) => item.id !== cluster.id));
              setOverviewMetrics((prev) => {
                if (!prev) {
                  return prev;
                }
                const nextSeries = prev.series.filter(
                  (series) => series.cluster_id !== cluster.id
                );
                return nextSeries.length === prev.series.length
                  ? prev
                  : { ...prev, series: nextSeries };
              });
              setClusterDisplayIds((prev) => {
                if (!(cluster.id in prev)) {
                  return prev;
                }
                const next = { ...prev };
                delete next[cluster.id];
                return next;
              });
              setAgents((prev) =>
                prev.filter((agent) => {
                  const agentClusterId = agent.cluster_id ?? null;
                  if (agentClusterId === cluster.id) {
                    return false;
                  }
                  const agentName = agent.name?.trim() ?? "";
                  const agentClusterName = agent.cluster_name?.trim() ?? "";
                  if (agentName && agentName === clusterName) {
                    return false;
                  }
                  if (agentClusterName && agentClusterName === clusterName) {
                    return false;
                  }
                  return true;
                })
              );
              await refreshClusters();
              await refreshRuns();
              await refreshAgents();
              await refreshOverviewSummary();
              await refreshOverviewMetrics();
              const successScope = location.pathname.includes("/clusters/")
                ? "overview"
                : currentNoticeScope;
              showClusterNotice(successScope, "集群已删除", "success");
              if (location.pathname.includes("/clusters/")) {
                navigate("/", { replace: true });
              }
            } catch (err) {
              const message =
                err instanceof Error ? err.message : "删除集群失败";
              logWithTimestamp("error", "删除集群失败: %s", message);
              showClusterNotice(currentNoticeScope, message, "error");
              throw err instanceof Error ? err : new Error(message);
            }
          },
        });
        return Promise.resolve();
    },
    [
      refreshAgents,
      refreshClusters,
      refreshOverviewMetrics,
      refreshOverviewSummary,
      refreshRuns,
      location.pathname,
      navigate,
      currentNoticeScope,
      setOverviewMetrics,
      setAgents,
      setClusterDisplayIds,
      setClusters,
      showClusterNotice,
      licenseCapabilities,
      setClusterError,
      canDeleteClusterAgents,
    ]
  );

  const handleDeleteRunsBulk = useCallback(
    (runIds: number[], scope: NoticeScope): Promise<void> => {
      if (!canDeleteHistory) {
        showClusterNotice(scope, "当前账号无巡检记录删除权限。", "error");
        return Promise.resolve();
      }
      if (!licenseCapabilities.canRunInspections) {
        const message =
          licenseCapabilities.reason ?? "当前 License 不支持巡检功能。";
        showClusterNotice(scope, message, "error");
        return Promise.resolve();
      }
      const targets = runs.filter((run) => runIds.includes(run.id));
      if (targets.length === 0) {
        return Promise.resolve();
      }
      const blockedTargets = targets.filter((run) => run.status === "running");
      if (blockedTargets.length > 0) {
        setConfirmState({
          title: "无法删除巡检记录",
          message: "所选包含进行中的巡检任务，请先取消后再删除。",
          confirmLabel: "知道了",
          cancelLabel: "关闭",
          onConfirm: () => Promise.resolve(),
        });
        return Promise.resolve();
      }
      setConfirmState({
        title: "批量删除巡检记录",
        message: `确认删除选中的 ${targets.length} 条巡检记录？该操作不可恢复。`,
        confirmLabel: "删除",
        variant: "danger",
        options: [
          {
            id: "deleteReportFile",
            label: "同时删除本地巡检报告文件",
          },
        ],
        onConfirm: async (optionsMap) => {
          try {
            const deleteFiles = Boolean(optionsMap?.deleteReportFile);
            const runIds = targets.map((run) => run.id);
            logWithTimestamp(
              "info",
              "批量删除巡检记录: %s 条",
              runIds.length
            );
            await apiDeleteInspectionRunsBulk(runIds, { deleteFiles });
            await refreshRuns();
            await refreshClusters();
            showClusterNotice(scope, `已删除 ${targets.length} 条巡检记录`, "success");
          } catch (err) {
            const message =
              err instanceof Error ? err.message : "删除巡检记录失败";
            logWithTimestamp("error", "批量删除巡检记录失败: %s", message);
            showClusterNotice(scope, message, "error");
            throw err instanceof Error ? err : new Error(message);
          }
        },
      });
      return Promise.resolve();
    },
    [
      runs,
      refreshRuns,
      refreshClusters,
      showClusterNotice,
      licenseCapabilities,
      canDeleteHistory,
    ]
  );

  const handleDeleteRun = useCallback(
    (run: InspectionRunListItem): Promise<void> => {
      if (!canDeleteHistory) {
        showClusterNotice(
          currentNoticeScope,
          "当前账号无巡检记录删除权限。",
          "error"
        );
        return Promise.resolve();
      }
      if (!licenseCapabilities.canRunInspections) {
        const message =
          licenseCapabilities.reason ?? "当前 License 不支持巡检功能。";
        showClusterNotice(currentNoticeScope, message, "error");
        return Promise.resolve();
      }
      const displayId = runDisplayIds[run.id] ?? String(run.id);
      setConfirmState({
        title: "删除巡检记录",
        message: `确认删除巡检记录(${displayId})？该操作不可恢复。`,
        confirmLabel: "删除",
        variant: "danger",
        options: [
          {
            id: "deleteReportFile",
            label: "同时删除本地巡检报告文件",
          },
        ],
        onConfirm: async (optionsMap) => {
          try {
            logWithTimestamp("info", "删除巡检记录: %s", run.id);
            const deleteFiles = Boolean(optionsMap?.deleteReportFile);
            await apiDeleteInspectionRun(run.id, { deleteFiles });
            await refreshRuns();
            await refreshClusters();
            showClusterNotice(currentNoticeScope, "巡检记录已删除", "success");
          } catch (err) {
            const message =
              err instanceof Error ? err.message : "删除巡检记录失败";
            logWithTimestamp("error", "删除巡检记录失败: %s", message);
            showClusterNotice(currentNoticeScope, message, "error");
            throw err instanceof Error ? err : new Error(message);
          }
        },
      });
      return Promise.resolve();
    },
    [
      runDisplayIds,
      refreshRuns,
      refreshClusters,
      currentNoticeScope,
      showClusterNotice,
      licenseCapabilities,
      canDeleteHistory,
    ]
  );

  const handleDeleteRunById = useCallback(
    (runId: number, redirectPath?: string): Promise<void> => {
      if (!canDeleteHistory) {
        showClusterNotice(
          currentNoticeScope,
          "当前账号无巡检记录删除权限。",
          "error"
        );
        return Promise.resolve();
      }
      if (!licenseCapabilities.canRunInspections) {
        const message =
          licenseCapabilities.reason ?? "当前 License 不支持巡检功能。";
        showClusterNotice(currentNoticeScope, message, "error");
        return Promise.resolve();
      }
      const displayId = runDisplayIds[runId] ?? String(runId);
      setConfirmState({
        title: "删除巡检记录",
        message: `确认删除巡检记录(${displayId})？该操作不可恢复。`,
        confirmLabel: "删除",
        variant: "danger",
        options: [
          {
            id: "deleteReportFile",
            label: "同时删除本地巡检报告 (PDF)",
            description: "勾选后将移除 reports/ 目录中的对应报告。",
          },
        ],
        onConfirm: async (optionsMap) => {
          try {
            logWithTimestamp("info", "删除巡检记录: %s", runId);
            const deleteFiles = Boolean(optionsMap?.deleteReportFile);
            await apiDeleteInspectionRun(runId, { deleteFiles });
            await refreshRuns();
            await refreshClusters();
            const targetScope = redirectPath
              ? resolveNoticeScope(redirectPath)
              : currentNoticeScope;
            showClusterNotice(targetScope, "巡检记录已删除", "success");
            if (redirectPath) {
              navigate(redirectPath, { replace: true });
            }
          } catch (err) {
            const message =
              err instanceof Error ? err.message : "删除巡检记录失败";
            logWithTimestamp("error", "删除巡检记录失败: %s", message);
            showClusterNotice(currentNoticeScope, message, "error");
            throw err instanceof Error ? err : new Error(message);
          }
        },
      });
      return Promise.resolve();
    },
    [
      runDisplayIds,
      refreshRuns,
      refreshClusters,
      navigate,
      currentNoticeScope,
      showClusterNotice,
      licenseCapabilities,
      canDeleteHistory,
    ]
  );

  const handleCancelRun = useCallback(
    (run: InspectionRunListItem): Promise<void> => {
      if (!canUpdateHistory) {
        showClusterNotice(
          currentNoticeScope,
          "当前账号无巡检记录修改权限。",
          "error"
        );
        return Promise.resolve();
      }
      if (!licenseCapabilities.canRunInspections) {
        const message =
          licenseCapabilities.reason ?? "当前 License 不支持巡检功能。";
        showClusterNotice(currentNoticeScope, message, "error");
        return Promise.resolve();
      }
      const displayId = runDisplayIds[run.id] ?? String(run.id);
      setConfirmState({
        title: "取消巡检",
        message: `确认取消巡检记录(${displayId})？已产生的巡检结果将被保留。`,
        confirmLabel: "确认取消",
        variant: "danger",
        onConfirm: async () => {
          try {
            logWithTimestamp("info", "取消巡检记录: %s", run.id);
            await cancelInspectionRun(run.id);
            await refreshRuns();
            await refreshClusters();
            showClusterNotice(currentNoticeScope, "巡检已取消", "warning");
          } catch (err) {
            const message =
              err instanceof Error ? err.message : "取消巡检失败";
            logWithTimestamp("error", "取消巡检失败: %s", message);
            showClusterNotice(currentNoticeScope, message, "error");
            throw err instanceof Error ? err : new Error(message);
          }
        },
      });
      return Promise.resolve();
    },
    [
      runDisplayIds,
      refreshRuns,
      refreshClusters,
      currentNoticeScope,
      showClusterNotice,
      licenseCapabilities,
      canUpdateHistory,
    ]
  );

  const handlePauseRun = useCallback(
    async (run: InspectionRunListItem): Promise<void> => {
      if (!canUpdateHistory) {
        showClusterNotice(
          currentNoticeScope,
          "当前账号无巡检记录修改权限。",
          "error"
        );
        return;
      }
      if (!licenseCapabilities.canRunInspections) {
        const message =
          licenseCapabilities.reason ?? "当前 License 不支持巡检功能。";
        showClusterNotice(currentNoticeScope, message, "error");
        return;
      }
      try {
        logWithTimestamp("info", "暂停巡检记录: %s", run.id);
        await pauseInspectionRun(run.id);
        await refreshRuns();
        await refreshClusters();
        showClusterNotice(currentNoticeScope, "巡检已暂停", "warning");
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "暂停巡检失败";
        logWithTimestamp("error", "暂停巡检失败: %s", message);
        showClusterNotice(currentNoticeScope, message, "error");
      }
    },
    [
      refreshRuns,
      refreshClusters,
      currentNoticeScope,
      showClusterNotice,
      licenseCapabilities,
      canUpdateHistory,
    ]
  );

  const handleResumeRun = useCallback(
    async (run: InspectionRunListItem): Promise<void> => {
      if (!canUpdateHistory) {
        showClusterNotice(
          currentNoticeScope,
          "当前账号无巡检记录修改权限。",
          "error"
        );
        return;
      }
      if (!licenseCapabilities.canRunInspections) {
        const message =
          licenseCapabilities.reason ?? "当前 License 不支持巡检功能。";
        showClusterNotice(currentNoticeScope, message, "error");
        return;
      }
      try {
        logWithTimestamp("info", "继续巡检记录: %s", run.id);
        await resumeInspectionRun(run.id);
        await refreshRuns();
        await refreshClusters();
        showClusterNotice(currentNoticeScope, "巡检已继续", "success");
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "继续巡检失败";
        logWithTimestamp("error", "继续巡检失败: %s", message);
        showClusterNotice(currentNoticeScope, message, "error");
      }
    },
    [
      refreshRuns,
      refreshClusters,
      currentNoticeScope,
      showClusterNotice,
      licenseCapabilities,
      canUpdateHistory,
    ]
  );

  const handleCancelRunById = useCallback(
    (runId: number, redirectPath?: string): Promise<void> => {
      if (!canUpdateHistory) {
        showClusterNotice(
          currentNoticeScope,
          "当前账号无巡检记录修改权限。",
          "error"
        );
        return Promise.resolve();
      }
      if (!licenseCapabilities.canRunInspections) {
        const message =
          licenseCapabilities.reason ?? "当前 License 不支持巡检功能。";
        showClusterNotice(currentNoticeScope, message, "error");
        return Promise.resolve();
      }
      const displayId = runDisplayIds[runId] ?? String(runId);
      setConfirmState({
        title: "取消巡检",
        message: `确认取消巡检记录(${displayId})？已产生的巡检结果将被保留。`,
        confirmLabel: "确认取消",
        variant: "danger",
        onConfirm: async () => {
          try {
            logWithTimestamp("info", "取消巡检记录: %s", runId);
            await cancelInspectionRun(runId);
            await refreshRuns();
            await refreshClusters();
            const targetScope = redirectPath
              ? resolveNoticeScope(redirectPath)
              : currentNoticeScope;
            showClusterNotice(targetScope, "巡检已取消", "warning");
            if (redirectPath) {
              navigate(redirectPath, { replace: true });
            }
          } catch (err) {
            const message =
              err instanceof Error ? err.message : "取消巡检失败";
            logWithTimestamp("error", "取消巡检失败: %s", message);
            showClusterNotice(currentNoticeScope, message, "error");
            throw err instanceof Error ? err : new Error(message);
          }
        },
      });
      return Promise.resolve();
    },
    [
      runDisplayIds,
      refreshRuns,
      refreshClusters,
      navigate,
      currentNoticeScope,
      showClusterNotice,
      licenseCapabilities,
      canUpdateHistory,
    ]
  );

  const handlePauseRunById = useCallback(
    async (runId: number): Promise<void> => {
      if (!canUpdateHistory) {
        showClusterNotice(
          currentNoticeScope,
          "当前账号无巡检记录修改权限。",
          "error"
        );
        return;
      }
      if (!licenseCapabilities.canRunInspections) {
        const message =
          licenseCapabilities.reason ?? "当前 License 不支持巡检功能。";
        showClusterNotice(currentNoticeScope, message, "error");
        return;
      }
      try {
        logWithTimestamp("info", "暂停巡检记录: %s", runId);
        await pauseInspectionRun(runId);
        await refreshRuns();
        await refreshClusters();
        showClusterNotice(currentNoticeScope, "巡检已暂停", "warning");
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "暂停巡检失败";
        logWithTimestamp("error", "暂停巡检失败: %s", message);
        showClusterNotice(currentNoticeScope, message, "error");
      }
    },
    [
      refreshRuns,
      refreshClusters,
      currentNoticeScope,
      showClusterNotice,
      licenseCapabilities,
      canUpdateHistory,
    ]
  );

  const handleResumeRunById = useCallback(
    async (runId: number): Promise<void> => {
      if (!canUpdateHistory) {
        showClusterNotice(
          currentNoticeScope,
          "当前账号无巡检记录修改权限。",
          "error"
        );
        return;
      }
      if (!licenseCapabilities.canRunInspections) {
        const message =
          licenseCapabilities.reason ?? "当前 License 不支持巡检功能。";
        showClusterNotice(currentNoticeScope, message, "error");
        return;
      }
      try {
        logWithTimestamp("info", "继续巡检记录: %s", runId);
        await resumeInspectionRun(runId);
        await refreshRuns();
        await refreshClusters();
        showClusterNotice(currentNoticeScope, "巡检已继续", "success");
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "继续巡检失败";
        logWithTimestamp("error", "继续巡检失败: %s", message);
        showClusterNotice(currentNoticeScope, message, "error");
      }
    },
    [
      refreshRuns,
      refreshClusters,
      currentNoticeScope,
      showClusterNotice,
      licenseCapabilities,
      canUpdateHistory,
    ]
  );

  const handleEditCluster = useCallback(
    (cluster: ClusterConfig) => {
      if (!canUpdateClusterAgents) {
        setClusterError("当前账号无集群/Agent 修改权限。");
        return;
      }
      setClusterEditState(cluster);
      setClusterEditError(null);
    },
    [canUpdateClusterAgents]
  );

  const handleSaveInspectionItem = useCallback(
    async ({
      id,
      name,
      description,
      check_type,
      prometheus_version,
      config,
    }: {
      id?: number;
      name: string;
      description?: string;
      check_type: string;
      prometheus_version?: string;
      config: Record<string, unknown>;
    }) => {
      if (!canManageInspectionItems) {
        setSettingsError("当前账号无巡检项管理权限。");
        setSettingsNotice(null);
        return;
      }
      if (!licenseCapabilities.canRunInspections) {
        setSettingsError(
          licenseCapabilities.reason ?? "当前 License 不支持巡检项管理。"
        );
        setSettingsNotice(null);
        return;
      }
      setSettingsSubmitting(true);
      try {
        if (id) {
          logWithTimestamp("info", "更新巡检项: %s", id);
          await apiUpdateInspectionItem(id, {
            name,
            description,
            check_type,
            prometheus_version,
            config,
          });
          setSettingsNotice("巡检项已更新");
        } else {
          logWithTimestamp("info", "创建巡检项: %s", name);
          await apiCreateInspectionItem({
            name,
            description,
            check_type,
            prometheus_version,
            config,
          });
          setSettingsNotice("巡检项已创建");
        }
        await refreshItems();
        setSettingsError(null);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "保存巡检项失败";
        logWithTimestamp("error", "保存巡检项失败: %s", message);
        setSettingsError(message);
        throw err instanceof Error ? err : new Error(message);
      } finally {
        setSettingsSubmitting(false);
      }
    },
    [refreshItems, licenseCapabilities, canManageInspectionItems]
  );

  const handleAddPrometheusVersion = useCallback(
    (value: string): { ok: boolean; message?: string } => {
      if (!canManagePrometheusVersions) {
        return { ok: false, message: "当前账号无 Prometheus 版本管理权限" };
      }
      if (!licenseCapabilities.canRunInspections) {
        return {
          ok: false,
          message:
            licenseCapabilities.reason ?? "当前 License 不支持版本管理",
        };
      }
      const trimmed = value.trim();
      if (!trimmed) {
        return { ok: false, message: "请输入版本号" };
      }
      if (!/^\d+(?:\.\d+){1,2}$/.test(trimmed)) {
        return { ok: false, message: "版本格式应类似 3.2 或 2.55" };
      }
      const exists = prometheusVersionOptions.some(
        (item) => item.trim() === trimmed
      );
      if (exists) {
        return { ok: false, message: "该版本已存在" };
      }
      setPrometheusVersionOptions((prev) => [...prev, trimmed]);
      void recordAuditLog({
        action: "create",
        entity_type: "prometheus_version",
        description: `新增 Prometheus 版本 ${trimmed}`,
      }).catch((err) => {
        logWithTimestamp(
          "warn",
          "记录 Prometheus 版本新增审计失败: %s",
          err instanceof Error ? err.message : String(err)
        );
      });
      return { ok: true };
    },
    [prometheusVersionOptions, licenseCapabilities, canManagePrometheusVersions]
  );

  const handleDeletePrometheusVersion = useCallback(
    (value: string): { ok: boolean; message?: string } => {
      if (!canManagePrometheusVersions) {
        return { ok: false, message: "当前账号无 Prometheus 版本管理权限" };
      }
      if (!licenseCapabilities.canRunInspections) {
        return {
          ok: false,
          message:
            licenseCapabilities.reason ?? "当前 License 不支持版本管理",
        };
      }
      const trimmed = value.trim();
      if (!trimmed) {
        return { ok: false, message: "版本号无效" };
      }
      if (trimmed === DEFAULT_PROMETHEUS_VERSION) {
        return { ok: false, message: "默认版本不可删除" };
      }
      const usedCount = items.filter((item) => {
        if (!isPromqlType(item.check_type)) {
          return false;
        }
        const raw = String(item.prometheus_version ?? DEFAULT_PROMETHEUS_VERSION)
          .trim();
        const resolved = raw || DEFAULT_PROMETHEUS_VERSION;
        return resolved === trimmed;
      }).length;
      if (usedCount > 0) {
        return {
          ok: false,
          message: `该版本已被 ${usedCount} 个 PromQL 巡检项使用，无法删除`,
        };
      }
      setPrometheusVersionOptions((prev) =>
        prev.filter((version) => version !== trimmed)
      );
      void recordAuditLog({
        action: "delete",
        entity_type: "prometheus_version",
        description: `删除 Prometheus 版本 ${trimmed}`,
      }).catch((err) => {
        logWithTimestamp(
          "warn",
          "记录 Prometheus 版本删除审计失败: %s",
          err instanceof Error ? err.message : String(err)
        );
      });
      return { ok: true };
    },
    [items, licenseCapabilities, canManagePrometheusVersions]
  );

  const deleteInspectionItemsBatch = useCallback(
    async (ids: number[], successMessage: string) => {
      if (!canManageInspectionItems) {
        setSettingsError("当前账号无巡检项管理权限。");
        setSettingsNotice(null);
        return;
      }
      if (!licenseCapabilities.canRunInspections) {
        setSettingsError(
          licenseCapabilities.reason ?? "当前 License 不支持巡检项管理。"
        );
        setSettingsNotice(null);
        return;
      }
      setSettingsSubmitting(true);
      try {
        for (const itemId of ids) {
          logWithTimestamp("info", "删除巡检项: %s", itemId);
          await apiDeleteInspectionItem(itemId);
        }
        await refreshItems();
        setSettingsNotice(successMessage);
        setSettingsError(null);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "删除巡检项失败";
        logWithTimestamp("error", "删除巡检项失败: %s", message);
        setSettingsError(message);
        throw err instanceof Error ? err : new Error(message);
      } finally {
        setSettingsSubmitting(false);
      }
    },
    [refreshItems, licenseCapabilities, canManageInspectionItems]
  );

  const performDeleteInspectionItem = useCallback(
    (item: InspectionItem) =>
      deleteInspectionItemsBatch([item.id], "巡检项已删除"),
    [deleteInspectionItemsBatch]
  );

  const handleDeleteInspectionItem = useCallback(
    (item: InspectionItem) => {
      if (!canManageInspectionItems) {
        setSettingsError("当前账号无巡检项管理权限。");
        setSettingsNotice(null);
        return;
      }
      if (!licenseCapabilities.canRunInspections) {
        setSettingsError(
          licenseCapabilities.reason ?? "当前 License 不支持巡检项管理。"
        );
        setSettingsNotice(null);
        return;
      }
      setConfirmState({
        title: "删除巡检项",
        message: `确认删除巡检项(${item.name})？该操作不可恢复。`,
        confirmLabel: "删除",
        variant: "danger",
        scope: "settings",
        onConfirm: () => performDeleteInspectionItem(item),
      });
    },
    [performDeleteInspectionItem, licenseCapabilities, canManageInspectionItems]
  );

  const handleDeleteInspectionItemsBulk = useCallback(
    (itemIds: number[]) => {
      if (!canManageInspectionItems) {
        setSettingsError("当前账号无巡检项管理权限。");
        setSettingsNotice(null);
        return;
      }
      if (!licenseCapabilities.canRunInspections) {
        setSettingsError(
          licenseCapabilities.reason ?? "当前 License 不支持巡检项管理。"
        );
        setSettingsNotice(null);
        return;
      }
      const targetIds = items
        .filter((item) => itemIds.includes(item.id))
        .map((item) => item.id);
      if (targetIds.length === 0) {
        return;
      }
      const targetCount = targetIds.length;
      setConfirmState({
        title: "删除巡检项",
        message:
          targetCount === 1
            ? "确认删除该巡检项？该操作不可恢复。"
            : `确认删除选中的 ${targetCount} 条巡检项？该操作不可恢复。`,
        confirmLabel: "删除",
        variant: "danger",
        scope: "settings",
        onConfirm: () =>
          deleteInspectionItemsBatch(
            targetIds,
            targetCount === 1
              ? "巡检项已删除"
              : `已删除 ${targetCount} 个巡检项`
          ),
      });
    },
    [items, deleteInspectionItemsBatch, licenseCapabilities, canManageInspectionItems]
  );

  const handleExportInspectionItems = useCallback(async (format: "json" | "yaml") => {
    if (!canViewInspectionItems) {
      setSettingsError("当前账号无巡检项查看权限。");
      setSettingsNotice(null);
      return;
    }
    if (!licenseCapabilities.canRunInspections) {
      setSettingsError(
        licenseCapabilities.reason ?? "当前 License 不支持巡检项管理。"
      );
      setSettingsNotice(null);
      return;
    }
    setSettingsSubmitting(true);
    setSettingsNotice(null);
    setSettingsError(null);
    let objectUrl: string | null = null;
    let tempLink: HTMLAnchorElement | null = null;
    try {
      logWithTimestamp("info", "导出巡检项，格式: %s", format);
      let exportDate = new Date();
      let fileContent = "";
      let mimeType = "";
      if (format === "yaml") {
        fileContent = await exportInspectionItemsYaml();
        mimeType = "text/yaml;charset=utf-8";
      } else {
        const payload = await exportInspectionItems();
        const rawTimestamp = payload.exported_at ?? new Date().toISOString();
        exportDate = new Date(rawTimestamp);
        if (Number.isNaN(exportDate.getTime())) {
          exportDate = new Date();
        }
        const exportPayload = {
          exported_at: exportDate.toISOString(),
          items: payload.items,
        };
        fileContent = JSON.stringify(exportPayload, null, 2);
        mimeType = "application/json;charset=utf-8";
      }
      if (Number.isNaN(exportDate.getTime())) {
        exportDate = new Date();
      }
      const pad = (value: number) => value.toString().padStart(2, "0");
      const filename = `inspection-items-${exportDate.getFullYear()}${pad(
        exportDate.getMonth() + 1
      )}${pad(exportDate.getDate())}-${pad(exportDate.getHours())}${pad(
        exportDate.getMinutes()
      )}${pad(exportDate.getSeconds())}.${format === "yaml" ? "yaml" : "json"}`;
      const blob = new Blob([fileContent], {
        type: mimeType,
      });
      objectUrl = URL.createObjectURL(blob);
      tempLink = document.createElement("a");
      tempLink.href = objectUrl;
      tempLink.download = filename;
      document.body.appendChild(tempLink);
      tempLink.click();
      setSettingsNotice("巡检项导出成功，文件已下载");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "导出巡检项失败";
      logWithTimestamp("error", "导出巡检项失败: %s", message);
      setSettingsError(message);
      throw err instanceof Error ? err : new Error(message);
    } finally {
      if (tempLink && tempLink.parentNode) {
        tempLink.parentNode.removeChild(tempLink);
      }
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
      setSettingsSubmitting(false);
    }
  }, [licenseCapabilities, canViewInspectionItems]);

  const handleImportInspectionItems = useCallback(
    async (file: File) => {
      if (!canManageInspectionItems) {
        setSettingsError("当前账号无巡检项管理权限。");
        setSettingsNotice(null);
        return;
      }
      if (!licenseCapabilities.canRunInspections) {
        setSettingsError(
          licenseCapabilities.reason ?? "当前 License 不支持巡检项管理。"
        );
        setSettingsNotice(null);
        return;
      }
      setSettingsSubmitting(true);
      setSettingsNotice(null);
      setSettingsError(null);
      try {
        logWithTimestamp("info", "导入巡检项，文件: %s", file.name);
        const formData = new FormData();
        formData.append("file", file, file.name || "inspection-items.json");
        const result = await importInspectionItems(formData);
        await refreshItems();
        const summaryParts: string[] = [];
        if (result.created > 0) {
          summaryParts.push(`新增 ${result.created} 条`);
        }
        if (result.updated > 0) {
          summaryParts.push(`更新 ${result.updated} 条`);
        }
        const summaryText =
          summaryParts.length > 0 ? summaryParts.join("，") : "数据未发生变化";
        setSettingsNotice(`导入成功（共 ${result.total} 条），${summaryText}`);
        setSettingsError(null);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "导入巡检项失败";
        logWithTimestamp("error", "导入巡检项失败: %s", message);
        setSettingsError(message);
        throw err instanceof Error ? err : new Error(message);
      } finally {
        setSettingsSubmitting(false);
      }
    },
    [refreshItems, licenseCapabilities, canManageInspectionItems]
  );

  const handleSaveSchedule = useCallback(
    async (payload: {
      id?: number;
      name?: string;
      cron: string;
      clusterIds: number[];
      itemIds: number[];
      isEnabled: boolean;
    }) => {
      if (payload.id ? !canUpdateSchedule : !canCreateSchedule) {
        const message = "当前账号无定时巡检管理权限。";
        setScheduleNotice(null);
        throw new Error(message);
      }
      if (!licenseCapabilities.canRunInspections) {
        const message =
          licenseCapabilities.reason ?? "当前 License 不支持定时巡检。";
        setScheduleNotice(null);
        throw new Error(message);
      }
      const trimmedName = payload.name?.trim() ?? "";
      setScheduleSubmitting(true);
      setScheduleNotice(null);
      setScheduleError(null);
      try {
        if (payload.id) {
          logWithTimestamp("info", "更新定时巡检: %s", payload.id);
          await apiUpdateInspectionSchedule(payload.id, {
            name: trimmedName ? trimmedName : null,
            cron: payload.cron,
            cluster_ids: payload.clusterIds,
            item_ids: payload.itemIds,
            is_enabled: payload.isEnabled,
          });
          setScheduleNotice("定时巡检已更新");
        } else {
          logWithTimestamp("info", "创建定时巡检");
          await apiCreateInspectionSchedule({
            name: trimmedName || undefined,
            cron: payload.cron,
            cluster_ids: payload.clusterIds,
            item_ids: payload.itemIds,
            is_enabled: payload.isEnabled,
          });
          setScheduleNotice("定时巡检已创建");
        }
        await refreshSchedules();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "保存定时巡检失败";
        logWithTimestamp("error", "保存定时巡检失败: %s", message);
        throw err instanceof Error ? err : new Error(message);
      } finally {
        setScheduleSubmitting(false);
      }
    },
    [refreshSchedules, licenseCapabilities, canCreateSchedule, canUpdateSchedule]
  );

  const performDeleteSchedule = useCallback(
    async (schedule: InspectionSchedule) => {
      if (!canDeleteSchedule) {
        setScheduleError("当前账号无定时巡检删除权限。");
        setScheduleNotice(null);
        return;
      }
      if (!licenseCapabilities.canRunInspections) {
        setScheduleError(
          licenseCapabilities.reason ?? "当前 License 不支持定时巡检。"
        );
        setScheduleNotice(null);
        return;
      }
      setScheduleSubmitting(true);
      setScheduleNotice(null);
      setScheduleError(null);
      try {
        logWithTimestamp("info", "删除定时巡检: %s", schedule.id);
        await apiDeleteInspectionSchedule(schedule.id);
        await refreshSchedules();
        setScheduleNotice("定时巡检已删除");
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "删除定时巡检失败";
        logWithTimestamp("error", "删除定时巡检失败: %s", message);
        setScheduleError(message);
        throw err instanceof Error ? err : new Error(message);
      } finally {
        setScheduleSubmitting(false);
      }
    },
    [refreshSchedules, licenseCapabilities, canDeleteSchedule]
  );

  const handleDeleteSchedule = useCallback(
    (schedule: InspectionSchedule) => {
      if (!canDeleteSchedule) {
        setScheduleError("当前账号无定时巡检删除权限。");
        setScheduleNotice(null);
        return;
      }
      if (!licenseCapabilities.canRunInspections) {
        setScheduleError(
          licenseCapabilities.reason ?? "当前 License 不支持定时巡检。"
        );
        setScheduleNotice(null);
        return;
      }
      const label = schedule.name?.trim() || `定时巡检 #${schedule.id}`;
      setConfirmState({
        title: "删除定时巡检",
        message: `确认删除定时任务(${label})？该操作不可恢复。`,
        confirmLabel: "删除",
        variant: "danger",
        scope: "global",
        onConfirm: () => performDeleteSchedule(schedule),
      });
    },
    [performDeleteSchedule, licenseCapabilities, canDeleteSchedule]
  );

  const handleDeleteSchedulesBulk = useCallback(
    (scheduleIds: number[]): Promise<void> => {
      if (!canDeleteSchedule) {
        setScheduleError("当前账号无定时巡检删除权限。");
        setScheduleNotice(null);
        return Promise.resolve();
      }
      if (!licenseCapabilities.canRunInspections) {
        setScheduleError(
          licenseCapabilities.reason ?? "当前 License 不支持定时巡检。"
        );
        setScheduleNotice(null);
        return Promise.resolve();
      }
      const targets = schedules.filter((schedule) =>
        scheduleIds.includes(schedule.id)
      );
      if (targets.length === 0) {
        return Promise.resolve();
      }
      setConfirmState({
        title: "批量删除定时巡检",
        message: `确认删除选中的 ${targets.length} 个定时任务？该操作不可恢复。`,
        confirmLabel: "删除",
        variant: "danger",
        scope: "global",
        onConfirm: async () => {
          setScheduleSubmitting(true);
          setScheduleNotice(null);
          setScheduleError(null);
          try {
            for (const schedule of targets) {
              logWithTimestamp("info", "删除定时巡检: %s", schedule.id);
              await apiDeleteInspectionSchedule(schedule.id);
            }
            await refreshSchedules();
            setScheduleNotice(`已删除 ${targets.length} 个定时任务`);
          } catch (err) {
            const message =
              err instanceof Error ? err.message : "删除定时巡检失败";
            logWithTimestamp("error", "批量删除定时巡检失败: %s", message);
            setScheduleError(message);
            throw err instanceof Error ? err : new Error(message);
          } finally {
            setScheduleSubmitting(false);
          }
        },
      });
      return Promise.resolve();
    },
    [licenseCapabilities, schedules, refreshSchedules, canDeleteSchedule]
  );

  const handleToggleScheduleEnabled = useCallback(
    async (schedule: InspectionSchedule, enabled: boolean) => {
      if (!canUpdateSchedule) {
        setScheduleError("当前账号无定时巡检修改权限。");
        setScheduleNotice(null);
        return;
      }
      if (!licenseCapabilities.canRunInspections) {
        setScheduleError(
          licenseCapabilities.reason ?? "当前 License 不支持定时巡检。"
        );
        setScheduleNotice(null);
        return;
      }
      setScheduleSubmitting(true);
      setScheduleNotice(null);
      setScheduleError(null);
      try {
        logWithTimestamp(
          "info",
          "切换定时巡检状态: %s -> %s",
          schedule.id,
          enabled
        );
        await apiUpdateInspectionSchedule(schedule.id, {
          is_enabled: enabled,
        });
        await refreshSchedules();
        setScheduleNotice(enabled ? "定时巡检已启用" : "定时巡检已停用");
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "更新定时巡检状态失败";
        logWithTimestamp("error", "更新定时巡检状态失败: %s", message);
        setScheduleError(message);
        throw err instanceof Error ? err : new Error(message);
      } finally {
        setScheduleSubmitting(false);
      }
    },
    [refreshSchedules, licenseCapabilities, canUpdateSchedule]
  );

  const settingsTabs = useMemo<SettingsModalTab[]>(
    () => {
      const tabs: SettingsModalTab[] = [
        {
          id: "overview",
          label: "设置总览",
          render: ({ selectTab }) => (
          <SettingsOverviewPanel
            onOpenInspection={() => selectTab("inspection")}
            onOpenLicense={() => selectTab("license")}
            license={licenseCapabilities}
            canOpenInspection={canViewInspectionItems}
            canOpenLicense={canViewLicense}
          />
          ),
        },
        {
          id: "inspection",
          label: "巡检项设置",
          render: ({ close }) => (
            <InspectionSettingsPanel
              items={sortedItems}
              prometheusVersionOptions={prometheusVersionOptions}
              submitting={settingsSubmitting}
              notice={settingsNotice}
              error={settingsError}
              license={licenseCapabilities}
              canManage={canManageInspectionItems}
              onClose={close}
              onSave={handleSaveInspectionItem}
              onDelete={handleDeleteInspectionItem}
              onDeleteMany={handleDeleteInspectionItemsBulk}
              onExport={handleExportInspectionItems}
              onImport={handleImportInspectionItems}
            />
          ),
        },
        {
          id: "prometheus-version",
          label: "Prometheus 版本",
          render: () => (
          <PrometheusVersionSettingsPanel
            items={sortedItems}
            versions={prometheusVersionOptions}
            defaultVersion={DEFAULT_PROMETHEUS_VERSION}
            license={licenseCapabilities}
            canManage={canManagePrometheusVersions}
            onAddVersion={handleAddPrometheusVersion}
            onDeleteVersion={handleDeletePrometheusVersion}
          />
          ),
        },
        {
          id: "users",
          label: "用户管理",
          render: () => (
            <UserSettingsPanel
              users={users}
              roles={roles}
              loading={usersLoading}
              submitting={usersSubmitting}
              notice={usersNotice}
              error={usersError}
              license={licenseCapabilities}
              canCreate={canCreateUsers}
              canUpdate={canUpdateUsers}
              canDelete={canDeleteUsers}
              onCreate={handleCreateUser}
              onUpdate={handleUpdateUser}
              onDelete={handleDeleteUser}
              onRefresh={refreshUsers}
            />
          ),
        },
        {
          id: "license",
          label: "License 管理",
          render: () => (
            <LicenseSettingsPanel
              status={licenseCapabilities}
              uploading={licenseUploading}
              textUploading={licenseTextUploading}
              canUpload={canManageLicense}
              onUpload={handleUploadLicenseFile}
              onUploadText={handleUploadLicenseText}
              onRefresh={refreshLicenseStatus}
            />
          ),
        },
      ];
      return tabs.filter((tab) => {
        if (tab.id === "inspection") {
          return canViewInspectionItems;
        }
        if (tab.id === "prometheus-version") {
          return canViewPrometheusVersions;
        }
        if (tab.id === "users") {
          return canViewUsers;
        }
        if (tab.id === "license") {
          return canViewLicense;
        }
        return true;
      });
    },
    [
      sortedItems,
      settingsSubmitting,
      settingsNotice,
      settingsError,
      handleSaveInspectionItem,
      handleDeleteInspectionItem,
      handleDeleteInspectionItemsBulk,
      handleExportInspectionItems,
      handleImportInspectionItems,
      prometheusVersionOptions,
      handleAddPrometheusVersion,
      handleDeletePrometheusVersion,
      roles,
      rolesLoading,
      roleSubmitting,
      rolesNotice,
      rolesError,
      users,
      usersLoading,
      usersSubmitting,
      usersNotice,
      usersError,
      canCreateRoles,
      canUpdateRoles,
      canDeleteRoles,
      canCreateUsers,
      canUpdateUsers,
      canDeleteUsers,
      handleCreateRole,
      handleUpdateRole,
      handleDeleteRole,
      refreshRoles,
      handleCreateUser,
      handleUpdateUser,
      handleDeleteUser,
      refreshUsers,
      licenseCapabilities,
      licenseUploading,
      licenseTextUploading,
      handleUploadLicenseFile,
      handleUploadLicenseText,
      refreshLicenseStatus,
      canViewInspectionItems,
      canViewPrometheusVersions,
      canViewRoles,
      canViewUsers,
      canViewLicense,
      canManageInspectionItems,
      canManagePrometheusVersions,
      canManageLicense,
    ]
  );

  const handleSelectSettingsTab = useCallback(
    (tabId: string) => {
      const normalized = tabId.toLowerCase();
      const validTabIds = settingsTabs.map((tab) => tab.id);
      const nextTab = validTabIds.includes(normalized) ? normalized : "overview";
      if (nextTab !== settingsTabId) {
        setSettingsTabId(nextTab);
      }
      const targetPath =
        nextTab === "overview"
          ? SETTINGS_BASE_PATH
          : `${SETTINGS_BASE_PATH}/${nextTab}`;
      if (location.pathname !== targetPath) {
        navigate(targetPath, {
          replace: location.pathname.startsWith(SETTINGS_BASE_PATH),
        });
      }
    },
    [
      settingsTabs,
      settingsTabId,
      navigate,
      location.pathname,
    ]
  );

  useEffect(() => {
    if (!settingsTabs.length) {
      return;
    }
    if (location.pathname.startsWith(SETTINGS_BASE_PATH)) {
      setSettingsError(null);
      setSettingsNotice(null);
      const segments = location.pathname.split("/").filter(Boolean);
      const requestedTab = (segments[1] ?? "overview").toLowerCase();
      const validTabIds = settingsTabs.map((tab) => tab.id);
      const nextTab = validTabIds.includes(requestedTab)
        ? requestedTab
        : "overview";
      if (nextTab !== settingsTabId) {
        setSettingsTabId(nextTab);
      }
      if (!validTabIds.includes(requestedTab)) {
        if (
          !authChecked &&
          SETTINGS_TAB_IDS.includes(
            requestedTab as (typeof SETTINGS_TAB_IDS)[number]
          )
        ) {
          return;
        }
        const fallbackPath =
          nextTab === "overview"
            ? SETTINGS_BASE_PATH
            : `${SETTINGS_BASE_PATH}/${nextTab}`;
        if (location.pathname !== fallbackPath) {
          navigate(fallbackPath, {
            replace: true,
          });
        }
      }
    }
  }, [
    location.pathname,
    settingsTabs,
    settingsTabId,
    navigate,
    authChecked,
  ]);

  const handleSubmitClusterEdit = useCallback(
    async ({
      name,
      prometheusUrl,
      file,
      rancherUrl,
      rancherApiKey,
    }: {
      name: string;
      prometheusUrl: string;
      file: File | null;
      rancherUrl?: string;
      rancherApiKey?: string;
    }) => {
      if (!clusterEditState) {
        return;
      }
      if (!canUpdateClusterAgents) {
        setClusterEditError("当前账号无集群/Agent 修改权限。");
        return;
      }
      if (!licenseCapabilities.canManageClusters) {
        setClusterEditError(
          licenseCapabilities.reason ?? "当前 License 不支持集群管理。"
        );
        return;
      }

      const trimmedName = name.trim();
      if (!trimmedName) {
        setClusterEditError("集群名称不能为空");
        return;
      }
      const trimmedRancherUrl = rancherUrl?.trim() ?? "";
      const trimmedRancherApiKey = rancherApiKey?.trim() ?? "";
      const editIsRancherLocal = resolveClusterRancherLocal(clusterEditState);
      if (editIsRancherLocal) {
        if (!trimmedRancherUrl) {
          setClusterEditError("Rancher 地址不能为空");
          return;
        }
        if (!/^https?:\/\//i.test(trimmedRancherUrl)) {
          setClusterEditError("Rancher 地址需以 http:// 或 https:// 开头");
          return;
        }
        if (!trimmedRancherApiKey) {
          setClusterEditError("Rancher API 密钥不能为空");
          return;
        }
      }

      const formData = new FormData();
      formData.append("name", trimmedName);
      formData.append("prometheus_url", prometheusUrl.trim());
      if (editIsRancherLocal) {
        formData.append("rancherUrl", trimmedRancherUrl);
        formData.append("rancherApiKey", trimmedRancherApiKey);
      }
      if (file) {
        formData.append("file", file);
      }

      setClusterEditSubmitting(true);
      setClusterEditError(null);

      try {
        logWithTimestamp("info", "更新集群: %s", clusterEditState.id);
        await updateCluster(clusterEditState.id, formData);
        await refreshClusters();
        await refreshRuns();
        showClusterNotice(currentNoticeScope, "集群信息已更新", "success");
        setClusterEditState(null);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "更新集群失败";
        logWithTimestamp("error", "更新集群失败: %s", message);
        setClusterEditError(message);
      } finally {
        setClusterEditSubmitting(false);
      }
    },
    [
      clusterEditState,
      refreshClusters,
      refreshRuns,
      currentNoticeScope,
      showClusterNotice,
      licenseCapabilities,
      canUpdateClusterAgents,
    ]
  );

  const closeClusterEditModal = () => {
    setClusterEditState(null);
    setClusterEditError(null);
  };

  const clusterListRouteElement = (
    <OverviewView
      clusters={clusters}
      clusterUploading={clusterUploading}
      clusterNameInput={clusterNameInput}
      clusterPromInput={clusterPromInput}
      setClusterNameInput={setClusterNameInput}
      setClusterPromInput={setClusterPromInput}
      openKubeconfigModal={handleOpenKubeconfigModal}
      kubeconfigSummary={kubeconfigSummary}
      kubeconfigReady={kubeconfigReady}
      clusterDefaultAgentIdInput={clusterDefaultAgentIdInput}
      setClusterDefaultAgentIdInput={setClusterDefaultAgentIdInput}
      agents={agents}
      onUpload={handleUploadCluster}
      onEditCluster={handleEditCluster}
      onDeleteCluster={handleDeleteCluster}
      onDeleteClustersBulk={handleDeleteClustersBulk}
      clusterDisplayIds={clusterDisplayIds}
      onTestClusterConnection={handleTestClusterConnection}
      testingClusterIds={testingClusterIds}
      license={licenseCapabilities}
      canUpdateClusters={canUpdateClusterAgents}
      canDeleteClusters={canDeleteClusterAgents}
      canTestClusterAgents={canTestClusterAgents}
      canCreateClusterAgents={canCreateClusterAgents}
      canManageAgents={licenseCapabilities.canManageAgents}
      agentSubmitting={agentSubmitting}
      agentNotice={agentNotice}
      agentError={agentError}
      generatedAgentCommand={generatedAgentCommand}
      onCreateAgent={handleCreateAgent}
      onClearAgentCommand={handleClearAgentCommand}
    />
  );

  const overviewRouteElement = (
    <DashboardOverviewView
      clusters={clusters}
      runs={runs}
      clusterDisplayIds={clusterDisplayIds}
      runDisplayIds={runDisplayIds}
      canViewHistory={canViewHistory}
      overviewSummary={overviewSummary}
      overviewMetrics={overviewMetrics}
      suppressDetailLoading={effectiveSuppressDetailLoading}
    />
  );

  const loginLoadingElement = (
    <div className="login-page">
      <div className="login-card">
        <div className="login-header">
          <h1>Kubernetes 巡检中心</h1>
          <p>正在校验登录状态...</p>
        </div>
      </div>
    </div>
  );

  if (!authChecked) {
    return loginLoadingElement;
  }

  if (!authUser) {
    return (
      <Routes>
        <Route
          path="/login"
          element={
            <LoginView
              loading={authSubmitting}
              error={authError}
              onSubmit={handleLogin}
            />
          }
        />
        <Route
          path="*"
          element={
            <Navigate to="/login" replace state={loginRedirectState} />
          }
        />
      </Routes>
    );
  }

  return (
    <>
      <Helmet>
        <title>Kubernetes 巡检中心</title>
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
      </Helmet>
      <TopNavigation
        user={authUser}
        onOpenSettings={handleOpenSettings}
        onChangePassword={handleOpenPasswordModal}
        onLogout={handleLogout}
        showClusters={canViewClusterAgents}
        showAudit={canViewAudit}
        showSchedule={canViewSchedule}
        showHistory={canViewHistory}
      />
      {globalNotices.length > 0 && (
        <div className="global-notice-bar" role="status" aria-live="polite">
          {globalNotices.map((notice) => (
            <div key={notice.key} className={`feedback ${notice.type}`}>
              {notice.message}
            </div>
          ))}
        </div>
      )}
      <main className="app-shell">
        <Routes>
          <Route path="/" element={overviewRouteElement} />
          <Route
            path="/clusters"
            element={
              canViewClusterAgents ? (
                clusterListRouteElement
              ) : (
                <NoPermissionPanel title="无权限访问集群列表" />
              )
            }
          />
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route
            path="/setting/*"
            element={
              <SettingsPage
                tabs={settingsTabs}
                initialTabId="overview"
                activeTabId={settingsTabId}
                onTabChange={handleSelectSettingsTab}
                onLeave={handleLeaveSettings}
                user={authUser}
                onLogout={handleLogout}
                onChangePassword={handleOpenPasswordModal}
                confirmState={
                  confirmState && confirmState.scope === "settings"
                    ? confirmState
                    : null
                }
                onConfirmClose={() => setConfirmState(null)}
              />
            }
          />
          <Route
            path="/audit"
            element={
              canViewAudit ? (
                <AuditView />
              ) : (
                <NoPermissionPanel title="无权限访问审计日志" />
              )
            }
          />
          <Route
            path="/history"
            element={
              canViewHistory ? (
                <HistoryView
                  runs={runs}
                  onRefreshRuns={refreshRuns}
                  onDeleteRun={handleDeleteRun}
                  onDeleteRunsBulk={(ids) =>
                    handleDeleteRunsBulk(ids, "history")
                  }
                  onCancelRun={handleCancelRun}
                  clusterDisplayIds={clusterDisplayIds}
                  runDisplayIds={runDisplayIds}
                  license={licenseCapabilities}
                  canCreateHistory={canCreateHistory}
                  canUpdateHistory={canUpdateHistory}
                  canDeleteHistory={canDeleteHistory}
                />
              ) : (
                <NoPermissionPanel title="无权限访问历史巡检" />
              )
            }
          />
          <Route
            path="/schedule"
            element={
              canViewSchedule ? (
                <SchedulePage
                  schedules={schedules}
                  clusters={clusters}
                  clusterDisplayIds={clusterDisplayIds}
                  items={sortedItems}
                  prometheusVersionOptions={prometheusVersionOptions}
                  submitting={scheduleSubmitting}
                  notice={scheduleNotice}
                  error={scheduleError}
                  license={licenseCapabilities}
                  canManage={canManageSchedule}
                  onSave={handleSaveSchedule}
                  onDelete={handleDeleteSchedule}
                  onDeleteMany={handleDeleteSchedulesBulk}
                  onToggleEnabled={handleToggleScheduleEnabled}
                />
              ) : (
                <NoPermissionPanel title="无权限访问定时巡检" />
              )
            }
          />
          <Route
            path="/clusters/:clusterKey"
            element={
              <ClusterDetailView
                clusters={clusters}
                items={sortedItems}
                runs={runs}
                prometheusVersionOptions={prometheusVersionOptions}
                selectedIds={selectedItemIds}
                setSelectedIds={setSelectedItemIds}
                operator={operator}
                setOperator={setOperator}
                inspectionLoading={inspectionLoading}
                onStartInspection={handleStartInspection}
                onDeleteRun={handleDeleteRun}
                onDeleteRunsBulk={(ids) =>
                  handleDeleteRunsBulk(ids, "clusterDetail")
                }
                onCancelRun={handleCancelRun}
                onPauseRun={handlePauseRun}
                onResumeRun={handleResumeRun}
                onEditCluster={handleEditCluster}
                onDeleteCluster={handleDeleteCluster}
                clusterDisplayIds={clusterDisplayIds}
                runDisplayIds={runDisplayIds}
                onTestClusterConnection={handleTestClusterConnection}
                testingClusterIds={testingClusterIds}
                license={licenseCapabilities}
                canUpdateClusters={canUpdateClusterAgents}
                canDeleteClusters={canDeleteClusterAgents}
                canTestClusterAgents={canTestClusterAgents}
                canCreateHistory={canCreateHistory}
                canUpdateHistory={canUpdateHistory}
                canDeleteHistory={canDeleteHistory}
              />
            }
          />
          <Route
            path="/clusters/:clusterKey/nodes"
            element={
              <ClusterNodesView
                clusters={clusters}
                clusterDisplayIds={clusterDisplayIds}
                license={licenseCapabilities}
              />
            }
          />
          <Route
            path="/clusters/:clusterKey/runs/:runKey"
            element={
              <RunDetailView
                  clusters={clusters}
                  items={sortedItems}
                  runs={runs}
                  prometheusVersionOptions={prometheusVersionOptions}
                  onDeleteRun={handleDeleteRunById}
                onCancelRun={handleCancelRunById}
                onPauseRun={handlePauseRunById}
                onResumeRun={handleResumeRunById}
                clusterDisplayIds={clusterDisplayIds}
                runDisplayIds={runDisplayIds}
                license={licenseCapabilities}
                canUpdateHistory={canUpdateHistory}
                canDeleteHistory={canDeleteHistory}
              />
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      <KubeconfigModal
        open={kubeconfigModalOpen}
        text={kubeconfigText}
        fileName={kubeconfigFileName}
        hasManualContent={hasManualKubeconfig}
        onClose={handleCloseKubeconfigModal}
        onFileSelected={handleKubeconfigFileSelected}
        onTextChange={handleKubeconfigTextChange}
        onClear={handleKubeconfigClear}
      />

      <ConfirmationModal
        state={confirmState && confirmState.scope !== "settings" ? confirmState : null}
        onClose={() => setConfirmState(null)}
      />

      <PasswordModal
        open={passwordModalOpen}
        submitting={passwordSubmitting}
        error={passwordError}
        notice={passwordNotice}
        onClose={handleClosePasswordModal}
        onSubmit={handleChangePassword}
      />

      {clusterEditState && (
        <ClusterEditModal
          cluster={clusterEditState}
          submitting={clusterEditSubmitting}
          error={clusterEditError}
          onCancel={closeClusterEditModal}
          onSubmit={handleSubmitClusterEdit}
        />
      )}
    </>
  );
};

export default App;
