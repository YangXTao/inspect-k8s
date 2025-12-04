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
import {
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { Helmet } from "react-helmet";
import type { Location as RouterLocation } from "history";
import {
  cancelInspectionRun,
  createAgent as apiCreateAgent,
  createInspectionItem as apiCreateInspectionItem,
  createInspectionRun,
  deleteCluster as apiDeleteCluster,
  deleteInspectionItem as apiDeleteInspectionItem,
  deleteInspectionRun as apiDeleteInspectionRun,
  exportInspectionItems,
  getAgents,
  getClusters,
  getInspectionItems,
  getInspectionRun,
  getInspectionRuns,
  getLicenseStatus,
  getReportDownloadUrl,
  importInspectionItems,
  registerCluster,
  testClusterConnection,
  updateAgent as apiUpdateAgent,
  updateCluster,
  uploadLicense,
  uploadLicenseText,
  updateInspectionItem as apiUpdateInspectionItem,
} from "./api";
import { appConfig } from "./config";
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
  LicenseStatus,
} from "./types";

type NoticeType = "success" | "warning" | "error" | null;
type ConfirmVariant = "primary" | "danger";
type NoticeScope = "overview" | "clusterDetail" | "history" | "runDetail";

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

interface ConfirmDialogOption {
  id: string;
  label: string;
  description?: string;
  defaultChecked?: boolean;
}

interface ConfirmDialogState {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: ConfirmVariant;
  onConfirm: (options?: Record<string, boolean>) => Promise<void> | void;
  scope?: "global" | "settings";
  options?: ConfirmDialogOption[];
}

interface SettingsModalTabRenderContext {
  close: () => void;
  selectTab: (tabId: string) => void;
}

interface SettingsModalTab {
  id: string;
  label: string;
  render: (context: SettingsModalTabRenderContext) => ReactNode;
}

const CLUSTER_ID_STORAGE_KEY = "clusterDisplayIdMap.v1";
const CLUSTER_PAGE_SIZE_OPTIONS = [10, 20, 50];
const DEFAULT_CLUSTER_PAGE_SIZE = CLUSTER_PAGE_SIZE_OPTIONS[0];
const RUN_PAGE_SIZE_OPTIONS = [20, 50, 100] as const;

const HISTORY_STATUS_OPTIONS: {
  value: InspectionRunStatus | "all";
  label: string;
}[] = [
  { value: "all", label: "全部" },
  { value: "queued", label: "排队中" },
  { value: "running", label: "执行中" },
  { value: "finished", label: "已完成" },
  { value: "failed", label: "已失败" },
  { value: "cancelled", label: "已取消" },
];
const SETTINGS_BASE_PATH = "/setting";
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

const statusClass = (status: InspectionRunStatus) => {
  switch (status) {
    case "queued":
      return "status-pill queued";
    case "running":
      return "status-pill running";
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
  if (status === "running") {
    const clamped = clampProgress(progress);
    return (
      <div className="status-progress status-progress-circle">
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
      JSON.stringify(map, null, 0)
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
  failed: { label: "失败", className: "danger" },
} as const;

const getInspectionResultStatusMeta = (status: InspectionResultStatus) =>
  inspectionResultStatusMeta[status as keyof typeof inspectionResultStatusMeta] ??
  inspectionResultStatusMeta.failed;

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

const TopNavigation = ({ onOpenSettings }: { onOpenSettings: () => void }) => {
  const navigate = useNavigate();

  return (
    <header className="top-navigation">
      <button
        type="button"
        className="top-navigation-brand"
        onClick={() => navigate("/")}
        aria-label="返回首页"
      >
        <span className="top-navigation-home-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" focusable="false">
            <path
              d="M20.25 9.52 12.6 3.46a.75.75 0 0 0-.93 0L3.75 9.52a.75.75 0 0 0-.27.57V20a.75.75 0 0 0 .75.75h4.5a.75.75 0 0 0 .75-.75v-4.5h4.5V20a.75.75 0 0 0 .75.75h4.5A.75.75 0 0 0 21 20V10.09a.75.75 0 0 0-.27-.57Z"
              fill="currentColor"
            />
          </svg>
        </span>
        <span className="top-navigation-title">Kubernetes 巡检中心</span>
      </button>
      <nav className="top-navigation-links">
        <NavLink
          to="/history"
          className={({ isActive }) =>
            `top-navigation-link${isActive ? " active" : ""}`
          }
        >
          <span className="top-navigation-link-inner">
            <span className="top-navigation-link-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">
                <path
                  d="M12 6a.75.75 0 0 1 .75.75v4.19l3 1.8a.75.75 0 0 1-.75 1.3l-3.37-2.02a.75.75 0 0 1-.38-.65V6.75A.75.75 0 0 1 12 6Z"
                  fill="currentColor"
                />
                <path
                  d="M12 3.25A8.75 8.75 0 1 0 20.75 12 8.76 8.76 0 0 0 12 3.25Zm0 16a7.25 7.25 0 1 1 7.25-7.25A7.26 7.26 0 0 1 12 19.25Z"
                  fill="currentColor"
                />
              </svg>
            </span>
            <span>历史巡检</span>
          </span>
        </NavLink>
        <button
          type="button"
          className="top-navigation-link"
          onClick={onOpenSettings}
        >
          <span className="top-navigation-link-inner">
            <span className="top-navigation-link-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">
                <path
                  d="M12 7.5a4.5 4.5 0 1 0 4.5 4.5A4.51 4.51 0 0 0 12 7.5Zm8.94 3.15-1.81-.26a7 7 0 0 0-.66-1.6l1.06-1.49a1 1 0 0 0-.12-1.29l-1.41-1.41a1 1 0 0 0-1.29-.12l-1.49 1.06a7 7 0 0 0-1.6-.66l-.26-1.81A1 1 0 0 0 12.06 3h-2.12a1 1 0 0 0-1 .87l-.26 1.81a7 7 0 0 0-1.6.66L5.59 5.28a1 1 0 0 0-1.29.12L2.89 6.81a1 1 0 0 0-.12 1.29l1.06 1.49a7 7 0 0 0-.66 1.6l-1.81.26a1 1 0 0 0-.87 1v2.12a1 1 0 0 0 .87 1l1.81.26a7 7 0 0 0 .66 1.6l-1.06 1.49a1 1 0 0 0 .12 1.29l1.41 1.41a1 1 0 0 0 1.29.12l1.49-1.06a7 7 0 0 0 1.6.66l.26 1.81a1 1 0 0 0 1 .87h2.12a1 1 0 0 0 1-.87l.26-1.81a7 7 0 0 0 1.6-.66l1.49 1.06a1 1 0 0 0 1.29-.12l1.41-1.41a1 1 0 0 0 .12-1.29l-1.06-1.49a7 7 0 0 0 .66-1.6l1.81-.26a1 1 0 0 0 .87-1v-2.12a1 1 0 0 0-.87-1Zm-8.94 4.35a3 3 0 1 1 3-3 3 3 0 0 1-3 3Z"
                  fill="currentColor"
                />
              </svg>
            </span>
            <span>设置</span>
          </span>
        </button>
      </nav>
    </header>
  );
};

interface AgentQuickCreateProps {
  clusters: ClusterConfig[];
  agents: InspectionAgent[];
  canManageAgents: boolean;
  submitting: boolean;
  notice: string | null;
  error: string | null;
  generatedToken: string | null;
  onCreate: (payload: {
    name: string;
    description?: string;
    prometheus_url?: string | null;
  }) => Promise<void>;
  onClearToken: () => void;
}

const AgentQuickCreate = ({
  clusters,
  agents,
  canManageAgents,
  submitting,
  notice,
  error,
  generatedToken,
  onCreate,
  onClearToken,
}: AgentQuickCreateProps) => {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prometheusUrl, setPrometheusUrl] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const trimmedName = name.trim();
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

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedName = name.trim();
    if (!normalizedName) {
      setFormError("Agent 名称不能为空");
      return;
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
      await onCreate({
        name: normalizedName,
        description: description.trim() || undefined,
        prometheus_url: prometheusUrl.trim() || undefined,
      });
      setName("");
      setDescription("");
      setPrometheusUrl("");
    } catch (err) {
      const message = err instanceof Error ? err.message : "创建 Agent 失败";
      setFormError(message);
    }
  };

  return (
    <div className="agent-inline-form">
      <div className="agent-inline-form-header">
        <strong>快速创建 Agent</strong>
        {!canManageAgents && (
          <span className="agent-inline-hint">当前 License 不支持 Agent 管理</span>
        )}
      </div>
      <p className="agent-inline-copy">
        Agent 名称必须与计划接入的集群名称保持一致，注册后不可修改。
      </p>
      <form className="agent-inline-form-body" onSubmit={handleSubmit}>
        <input
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Agent / 集群名称"
          disabled={submitting || !canManageAgents}
        />
        <input
          type="text"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="描述（可选）"
          disabled={submitting || !canManageAgents}
        />
        <input
          type="text"
          value={prometheusUrl}
          onChange={(event) => setPrometheusUrl(event.target.value)}
          placeholder="Prometheus 地址（可选）"
          disabled={submitting || !canManageAgents}
        />
        <button
          type="submit"
          className="secondary"
          disabled={submitting || !canManageAgents}
        >
          {submitting ? "创建中..." : "创建 Agent"}
        </button>
      </form>
      {formError && <div className="feedback error">{formError}</div>}
      {error && !formError && <div className="feedback error">{error}</div>}
      {notice && <div className="feedback success">{notice}</div>}
      {generatedToken && (
        <div className="agent-token-box">
          <p>创建成功，请妥善保存 Token，页面关闭后无法再次查看。</p>
          <code>{generatedToken}</code>
          <button type="button" className="secondary" onClick={onClearToken}>
            我已保存 Token
          </button>
        </div>
      )}
    </div>
  );
};

interface OverviewProps {
  clusters: ClusterConfig[];
  clusterError: string | null;
  clusterNotice: string | null;
  clusterNoticeType: NoticeType;
  clusterNoticeScope: NoticeScope | null;
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
  canManageAgents: boolean;
  agentSubmitting: boolean;
  agentNotice: string | null;
  agentError: string | null;
  generatedAgentToken: string | null;
  onCreateAgent: (payload: {
    name: string;
    description?: string;
    prometheus_url?: string | null;
  }) => Promise<void>;
  onClearAgentToken: () => void;
}

const OverviewView = ({
  clusters,
  clusterError,
  clusterNotice,
  clusterNoticeType,
  clusterNoticeScope,
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
  canManageAgents,
  agentSubmitting,
  agentNotice,
  agentError,
  generatedAgentToken,
  onCreateAgent,
  onClearAgentToken,
}: OverviewProps) => {
  const enableServerClusterUpload = false;
  const enableServerConnectionTest = true;
  const navigate = useNavigate();
  const [clusterPageSize, setClusterPageSize] = useState(
    DEFAULT_CLUSTER_PAGE_SIZE
  );
  const [pageJumpInput, setPageJumpInput] = useState("");
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
  const [searchParams, setSearchParams] = useSearchParams();

  const pageFromSearch = useMemo(() => {
    const raw = searchParams.get("page");
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
    return 1;
  }, [searchParams]);

  const [currentPage, setCurrentPage] = useState(pageFromSearch);

  useEffect(() => {
    setCurrentPage(pageFromSearch);
  }, [pageFromSearch]);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(clusters.length / clusterPageSize)),
    [clusters.length, clusterPageSize]
  );

  const updatePage = useCallback(
    (page: number, options?: { replace?: boolean }) => {
      const boundedPage = Math.max(page, 1);
      setCurrentPage(boundedPage);
      const nextParams = new URLSearchParams(searchParams);
      if (boundedPage <= 1) {
        nextParams.delete("page");
      } else {
        nextParams.set("page", String(boundedPage));
      }
      if (nextParams.toString() === searchParams.toString()) {
        return;
      }
      setSearchParams(nextParams, { replace: options?.replace ?? false });
    },
    [searchParams, setSearchParams]
  );

  useEffect(() => {
    const maxPage = Math.max(
      1,
      Math.ceil(clusters.length / clusterPageSize) || 1
    );
    if (currentPage > maxPage) {
      updatePage(maxPage, { replace: true });
    }
  }, [clusters.length, clusterPageSize, currentPage, updatePage]);

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
    return clusters.slice(start, start + clusterPageSize);
  }, [clusters, effectivePage, clusterPageSize]);

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

  const allSelected =
    clusters.length > 0 && selectedClusterIds.length === clusters.length;

  const handleToggleCluster = useCallback((clusterId: number) => {
    setSelectedClusterIds((prev) =>
      prev.includes(clusterId)
        ? prev.filter((id) => id !== clusterId)
        : [...prev, clusterId]
    );
  }, []);

  const handleToggleAllClusters = useCallback(() => {
    setSelectedClusterIds((prev) => {
      if (clusters.length === 0) {
        return [];
      }
      if (prev.length === clusters.length) {
        return [];
      }
      return clusters.map((cluster) => cluster.id);
    });
  }, [clusters]);

  const handleDeleteSelectedClusters = useCallback(() => {
    if (selectedClusterIds.length === 0) {
      return;
    }
    void onDeleteClustersBulk(selectedClusterIds);
  }, [onDeleteClustersBulk, selectedClusterIds]);

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
          ) : (
            <div className="branding-fallback">
              {appConfig.branding.logoText}
            </div>
          )}
          <div>
            <h1>Kubernetes 巡检中心</h1>
            <p>通过 Agent 托管集群连接，Server 统一管理巡检项和结果。</p>
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
              canManageAgents={canManageAgents}
              submitting={agentSubmitting}
              notice={agentNotice}
              error={agentError}
              generatedToken={generatedAgentToken}
              onCreate={onCreateAgent}
              onClearToken={onClearAgentToken}
            />
          )}
        </div>
      </header>

      <section className="card cluster-panel">
        <div className="card-header">
          <h2>集群列表</h2>
          {clusters.length > 0 && (
            <div className="card-actions">
              <span className="selection-hint">
                已选 {selectedClusterIds.length} / {clusters.length}
              </span>
              <button
                type="button"
                className="secondary"
                onClick={handleToggleAllClusters}
              >
                {allSelected ? "取消全选" : "全选"}
              </button>
              <button
                type="button"
                className="secondary danger"
                onClick={handleDeleteSelectedClusters}
                disabled={selectedClusterIds.length === 0}
              >
                删除
              </button>
            </div>
          )}
        </div>
        {clusterError && <div className="feedback error">{clusterError}</div>}
        {clusterNotice &&
          clusterNoticeType &&
          clusterNoticeScope === "overview" && (
            <div className={`feedback ${clusterNoticeType}`}>
              {clusterNotice}
            </div>
          )}
        {clusters.length === 0 ? (
          <p className="placeholder">
            暂无集群，请在 Agent 端完成注册后刷新本页面。
          </p>
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
                const handleNavigate = () => navigate(`/clusters/${displayId}`);
                const versionLabel =
                  cluster.kubernetes_version &&
                  cluster.kubernetes_version.trim().length > 0
                    ? cluster.kubernetes_version.trim()
                    : null;
                const nodeCountLabel =
                  typeof cluster.node_count === "number"
                    ? String(cluster.node_count)
                    : null;
                const summaryText =
                  versionLabel || nodeCountLabel
                    ? `版本 ${versionLabel ?? "未知"} · 节点数 ${nodeCountLabel ?? "未知"}`
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
                    role="button"
                    tabIndex={0}
                    onClick={handleNavigate}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        handleNavigate();
                      }
                    }}
                  >
                    <div className="cluster-card-top">
                      <div className="cluster-name-row">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={(event) => {
                            event.stopPropagation();
                            handleToggleCluster(cluster.id);
                          }}
                          onClick={(event) => event.stopPropagation()}
                        />
                        <span className="cluster-id-badge">{displayId}</span>
                        <div className="cluster-name">{cluster.name}</div>
                      </div>
                      <div className="cluster-actions">
                        <button
                          className="link-button small"
                          onClick={(event) => {
                            event.stopPropagation();
                            onEditCluster(cluster);
                          }}
                        >
                          编辑
                        </button>
                        <button
                          className="link-button small danger"
                          onClick={async (event) => {
                            event.stopPropagation();
                            await onDeleteCluster(cluster);
                          }}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                    <div className="cluster-status-line">
                      {enableServerConnectionTest && (
                        <button
                          type="button"
                          className="secondary"
                          onClick={(event) => {
                            event.stopPropagation();
                            void onTestClusterConnection(cluster.id, {
                              quiet: true,
                            });
                          }}
                          disabled={isTesting}
                        >
                          {isTesting ? "诊断中..." : "连接测试"}
                        </button>
                      )}
                      <span className={`status-chip ${statusMeta.className}`}>
                        {statusMeta.label}
                      </span>
                      <span
                        className="cluster-status-message"
                        title={summaryText}
                      >
                        {summaryText}
                      </span>
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
  notice?: string | null;
  noticeType?: NoticeType;
  noticeScope?: NoticeScope | null;
  license: LicenseCapabilities;
}

const HistoryView = ({
  runs,
  onRefreshRuns,
  onDeleteRun,
  onDeleteRunsBulk,
  onCancelRun,
  clusterDisplayIds,
  runDisplayIds,
  notice,
  noticeType,
  noticeScope,
  license,
}: HistoryViewProps) => {
  const navigate = useNavigate();
  const shouldShowNotice =
    notice && noticeType && noticeScope === "history";

  const [historyStatusFilter, setHistoryStatusFilter] = useState<
    InspectionRunStatus | "all"
  >("all");
  const [historyKeyword, setHistoryKeyword] = useState("");

  const [pageSize, setPageSize] = useState<number>(RUN_PAGE_SIZE_OPTIONS[0]);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("");

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

  const pagedRuns = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredRuns.slice(start, start + pageSize);
  }, [filteredRuns, page, pageSize]);

  const visibleSelectedCount = useMemo(
    () =>
      selectedRunIds.filter((id) =>
        filteredRuns.some((run) => run.id === id)
      ).length,
    [selectedRunIds, filteredRuns]
  );

  const allSelected =
    filteredRuns.length > 0 &&
    filteredRuns.every((run) => selectedRunIds.includes(run.id));

  const handleToggleRun = useCallback((runId: number) => {
    setSelectedRunIds((prev) =>
      prev.includes(runId)
        ? prev.filter((id) => id !== runId)
        : [...prev, runId]
    );
  }, []);

  const handleToggleAllRuns = useCallback(() => {
    setSelectedRunIds((prev) => {
      if (filteredRuns.length === 0) {
        return prev;
      }
      const visibleIds = filteredRuns.map((run) => run.id);
      const allVisibleSelected = visibleIds.every((id) => prev.includes(id));
      if (allVisibleSelected) {
        return prev.filter((id) => !visibleIds.includes(id));
      }
      const merged = new Set(prev);
      visibleIds.forEach((id) => merged.add(id));
      return Array.from(merged);
    });
  }, [filteredRuns]);

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
    if (selectedRunIds.length === 0) {
      return;
    }
    void onDeleteRunsBulk(selectedRunIds);
  }, [onDeleteRunsBulk, selectedRunIds]);

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
        <div className="history-header-controls">
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
          <button
            type="button"
            className="secondary ghost"
            onClick={onRefreshRuns}
          >
            刷新
          </button>
        </div>
      </div>
      {shouldShowNotice && noticeType && (
        <div className={`feedback ${noticeType}`}>
          {notice}
        </div>
      )}
      <div className="history-toolbar">
        <div className="history-selection">
          <label className="table-checkbox">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={handleToggleAllRuns}
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
            disabled={selectedRunIds.length === 0}
          >
            删除所选
          </button>
        </div>
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
                const isSelected = selectedRunIds.includes(run.id);
                return (
                  <tr key={run.id}>
                    <td>
                      <label className="table-checkbox">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => handleToggleRun(run.id)}
                        />
                        <span>{runSlug}</span>
                      </label>
                    </td>
                    <td>{clusterSlug}</td>
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
                          navigate(`/clusters/${clusterSlug}/runs/${runSlug}`)
                        }
                      >
                        查看详情
                      </button>
                      {run.report_path && (
                        <a
                          className="link-button"
                          href={run.report_path}
                          target="_blank"
                          rel="noreferrer"
                        >
                          下载报告
                        </a>
                      )}
                      {run.status === "running" && (
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => void onCancelRun(run)}
                        >
                          取消
                        </button>
                      )}
                      <button
                        type="button"
                        className="link-button danger"
                        onClick={() => void onDeleteRun(run)}
                      >
                        删除
                      </button>
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

interface ClusterDetailViewProps {
  clusters: ClusterConfig[];
  items: InspectionItem[];
  runs: InspectionRunListItem[];
  selectedIds: number[];
  setSelectedIds: (updater: (prev: number[]) => number[]) => void;
  operator: string;
  setOperator: (value: string) => void;
  inspectionLoading: boolean;
  notice: string | null;
  error: string | null;
  clusterNotice: string | null;
  clusterNoticeType: NoticeType;
  clusterNoticeScope: NoticeScope | null;
  clusterError: string | null;
  onStartInspection: (clusterId: number) => Promise<void>;
  onDeleteRun: (run: InspectionRunListItem) => Promise<void>;
  onDeleteRunsBulk: (runIds: number[]) => Promise<void>;
  onCancelRun: (run: InspectionRunListItem) => Promise<void>;
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
}

const ClusterDetailView = ({
  clusters,
  items,
  runs,
  selectedIds,
  setSelectedIds,
  operator,
  setOperator,
  inspectionLoading,
  notice,
  error,
  clusterNotice,
  clusterNoticeType,
  clusterNoticeScope,
  clusterError,
  onStartInspection,
  onDeleteRun,
  onDeleteRunsBulk,
  onCancelRun,
  onEditCluster,
  onDeleteCluster,
  clusterDisplayIds,
  runDisplayIds,
  onTestClusterConnection,
  testingClusterIds,
  license,
}: ClusterDetailViewProps) => {
  const enableServerConnectionTest = true;
  const { clusterKey } = useParams<{ clusterKey?: string }>();
  const navigate = useNavigate();
  const operatorInputId = useId();
  const [selectedRunIds, setSelectedRunIds] = useState<number[]>([]);

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
    setSelectedRunIds((prev) =>
      prev.filter((id) => clusterRuns.some((run) => run.id === id))
    );
  }, [clusterRuns]);

  const statusMeta = useMemo(
    () => (cluster ? getClusterStatusMeta(cluster.connection_status) : null),
    [cluster]
  );
  const clusterSlug = useMemo(
    () =>
      cluster
        ? getClusterDisplayId(clusterDisplayIds, cluster.id, cluster)
        : null,
    [cluster, clusterDisplayIds]
  );
  const isTesting = enableServerConnectionTest
    ? Boolean(cluster && testingClusterIds[cluster.id])
    : false;
  const contexts = cluster?.contexts ?? [];
  const allItemsSelected =
    items.length > 0 && selectedIds.length === items.length;
  const shouldShowClusterNotice =
    clusterNotice &&
    clusterNoticeType &&
    clusterNoticeScope === "clusterDetail";

  const handleToggleItem = useCallback(
    (itemId: number) => {
      setSelectedIds((prev) =>
        prev.includes(itemId)
          ? prev.filter((id) => id !== itemId)
          : [...prev, itemId]
      );
    },
    [setSelectedIds]
  );

  const handleToggleAllItems = useCallback(() => {
    setSelectedIds((prev) => {
      if (items.length === 0) {
        return prev;
      }
      if (prev.length === items.length) {
        return [];
      }
      return items.map((item) => item.id);
    });
  }, [items, setSelectedIds]);

  const handleToggleRunSelection = useCallback((runId: number) => {
    setSelectedRunIds((prev) =>
      prev.includes(runId)
        ? prev.filter((id) => id !== runId)
        : [...prev, runId]
    );
  }, []);

  const handleToggleAllRuns = useCallback(() => {
    setSelectedRunIds((prev) => {
      if (clusterRuns.length === 0) {
        return prev;
      }
      const visibleIds = clusterRuns.map((run) => run.id);
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
  }, [clusterRuns]);

  const handleDeleteSelectedRuns = useCallback(() => {
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
  }, [clusterRuns, onDeleteRunsBulk, selectedRunIds]);

  const handleStart = useCallback(() => {
    if (!cluster) {
      return;
    }
    void onStartInspection(cluster.id);
  }, [cluster, onStartInspection]);

  let detailContent: ReactNode;

  if (!clusterKey || resolvedClusterId === null) {
    detailContent = (
      <div className="detail-empty">
        <p>未找到对应的集群标识。</p>
        <button
          type="button"
          className="secondary"
          onClick={() => navigate("/")}
        >
          返回集群列表
        </button>
      </div>
    );
  } else if (!cluster) {
    detailContent = (
      <div className="detail-empty">
        <p>该集群暂不可用或已被删除。</p>
        <button
          type="button"
          className="secondary"
          onClick={() => navigate("/")}
        >
          返回集群列表
        </button>
      </div>
    );
  } else {
    detailContent = (
      <>
        <div className="detail-header">
          <button
            type="button"
            className="link-button"
            onClick={() => navigate("/")}
          >
            ← 返回集群列表
        </button>
        <div className="detail-header-actions">
          {enableServerConnectionTest && (
            <button
              type="button"
              className="secondary"
              onClick={() => void onTestClusterConnection(cluster.id)}
              disabled={isTesting}
            >
              {isTesting ? "测试中..." : "连接测试"}
            </button>
          )}
          <button
            type="button"
            className="secondary"
            onClick={() => onEditCluster(cluster)}
            disabled={!license.canManageClusters}
          >
            编辑集群
          </button>
          <button
            type="button"
            className="secondary danger"
            onClick={() => void onDeleteCluster(cluster)}
            disabled={!license.canManageClusters}
          >
            删除集群
          </button>
        </div>
      </div>

      {clusterError && <div className="feedback error">{clusterError}</div>}
      {shouldShowClusterNotice && (
        <div className={`feedback ${clusterNoticeType}`}>{clusterNotice}</div>
      )}
      {error && <div className="feedback error">{error}</div>}
      {notice && <div className="feedback success">{notice}</div>}

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
          <div className="cluster-contexts detail-contexts">
            {contexts.length > 0 ? (
              contexts.map((ctx) => (
                <span key={ctx} className="chip">
                  {ctx}
                </span>
              ))
            ) : (
              <span className="chip muted">未检测到上下文</span>
            )}
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
            />
          </label>
          <div className="selection-hint">
            已选择 {selectedIds.length} / {items.length} 个巡检项
          </div>
          <button
            type="button"
            className="secondary"
            onClick={handleToggleAllItems}
          >
            {allItemsSelected ? "清除选择" : "全选"}
          </button>
          <ul className="item-list">
            {items.length === 0 ? (
              <li className="placeholder">暂无巡检项，请在设置中添加。</li>
            ) : (
              items.map((item) => (
                <li key={item.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(item.id)}
                      onChange={() => handleToggleItem(item.id)}
                    />
                    <div>
                      <div className="item-name">{item.name}</div>
                      <div className="item-desc">
                        {item.description || "未提供描述"}
                      </div>
                    </div>
                  </label>
                </li>
              ))
            )}
          </ul>
          {!license.canRunInspections && (
            <div className="feedback warning">
              {license.reason ?? "当前 License 不支持发起巡检。"}
            </div>
          )}
          {inspectionLoading && (
            <div className="feedback info">正在创建巡检任务...</div>
          )}
          <div className="detail-actions">
            <button
              type="button"
              className="primary"
              onClick={handleStart}
              disabled={
                inspectionLoading ||
                selectedIds.length === 0 ||
                !license.canRunInspections
              }
            >
              {inspectionLoading ? "巡检中..." : "开始巡检"}
            </button>
          </div>
        </div>
      </section>

      <section className="card history">
        <div className="card-header">
          <h2>{cluster.name} · 巡检记录</h2>
          <div className="card-actions">
            <label className="table-checkbox">
              <input
                type="checkbox"
                checked={
                  clusterRuns.length > 0 &&
                  clusterRuns.every((run) => selectedRunIds.includes(run.id))
                }
                onChange={handleToggleAllRuns}
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
              disabled={selectedRunIds.length === 0}
            >
              删除所选
            </button>
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
                {clusterRuns.map((run) => {
                  const isSelected = selectedRunIds.includes(run.id);
                  const runSlug = runDisplayIds[run.id] ?? `#${run.id}`;
                  return (
                    <tr key={run.id}>
                      <td>
                        <label className="table-checkbox">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => handleToggleRunSelection(run.id)}
                          />
                          <span>{runSlug}</span>
                        </label>
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
                        {run.report_path && (
                          <a
                            className="link-button"
                            href={run.report_path}
                            target="_blank"
                            rel="noreferrer"
                          >
                            下载报告
                          </a>
                        )}
                        {run.status === "running" && (
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => void onCancelRun(run)}
                          >
                            取消
                          </button>
                        )}
                        <button
                          type="button"
                          className="link-button danger"
                          onClick={() => void onDeleteRun(run)}
                        >
                          删除
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>
      </>
    );
  }

  return detailContent;
};

interface ConfirmationModalProps {
  state: ConfirmDialogState | null;
  onClose: () => void;
}

const ConfirmationModal = ({ state, onClose }: ConfirmationModalProps) => {
  const [optionsMap, setOptionsMap] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  useEffect(() => {
    if (!state) {
      setOptionsMap({});
      setSubmitting(false);
      setConfirmError(null);
      return;
    }
    const initial: Record<string, boolean> = {};
    state.options?.forEach((option) => {
      initial[option.id] = Boolean(option.defaultChecked);
    });
    setOptionsMap(initial);
    setSubmitting(false);
    setConfirmError(null);
  }, [state]);

  if (!state) {
    return null;
  }

  const handleToggleOption = (optionId: string) => {
    setOptionsMap((prev) => ({
      ...prev,
      [optionId]: !prev[optionId],
    }));
  };

  const handleConfirm = async () => {
    setConfirmError(null);
    setSubmitting(true);
    try {
      await state.onConfirm(optionsMap);
      onClose();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "操作失败，请稍后重试。";
      setConfirmError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const confirmClassName =
    state.variant === "danger" ? "primary danger" : "primary";
  const confirmLabel = submitting
    ? "处理中..."
    : state.confirmLabel ?? "确定";
  const cancelLabel = state.cancelLabel ?? "取消";

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal confirmation-modal">
        <div className="modal-header">
          <h3>{state.title}</h3>
        </div>
        <p className="modal-message">{state.message}</p>
        {state.options && state.options.length > 0 && (
          <div className="confirmation-options">
            {state.options.map((option) => (
              <label key={option.id} className="confirmation-option">
                <input
                  type="checkbox"
                  checked={optionsMap[option.id] ?? Boolean(option.defaultChecked)}
                  onChange={() => handleToggleOption(option.id)}
                />
                <div>
                  <div className="option-label">{option.label}</div>
                  {option.description && (
                    <div className="option-description">
                      {option.description}
                    </div>
                  )}
                </div>
              </label>
            ))}
          </div>
        )}
        {confirmError && <div className="feedback error">{confirmError}</div>}
        <div className="modal-actions">
          <button
            type="button"
            className="secondary"
            onClick={onClose}
            disabled={submitting}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={confirmClassName}
            onClick={() => void handleConfirm()}
            disabled={submitting}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

interface SettingsModalProps {
  open: boolean;
  tabs: SettingsModalTab[];
  initialTabId?: string;
  activeTabId: string;
  onTabChange: (tabId: string) => void;
  onClose: () => void;
  confirmState?: ConfirmDialogState | null;
  onConfirmClose?: () => void;
}

const SettingsModal = ({
  open,
  tabs,
  initialTabId,
  activeTabId,
  onTabChange,
  onClose,
  confirmState,
  onConfirmClose,
}: SettingsModalProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const hasTabs = tabs.length > 0;
  const fallbackTabId =
    tabs.find((tab) => tab.id === (initialTabId ?? ""))?.id ??
    tabs[0]?.id ??
    "overview";
  const effectiveTabId = tabs.some((tab) => tab.id === activeTabId)
    ? activeTabId
    : fallbackTabId;
  const currentTab =
    tabs.find((tab) => tab.id === effectiveTabId) ?? tabs[0] ?? null;

  useEffect(() => {
    if (!open) {
      return;
    }
    const handleKeyDown = (event: { key: string }) => {
      if (event.key === "Escape") {
        if (confirmState && onConfirmClose) {
          onConfirmClose();
        } else {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, confirmState, onClose, onConfirmClose]);

  useEffect(() => {
    if (!open || !containerRef.current) {
      return;
    }
    const previouslyFocused = document.activeElement as HTMLElement | null;
    containerRef.current.focus();
    return () => {
      previouslyFocused?.focus?.();
    };
  }, [open]);

  if (!open || !hasTabs || !currentTab) {
    return null;
  }

  const selectTab = (tabId: string) => {
    onTabChange(tabId);
  };

  return (
    <div className="modal-backdrop settings-confirm-backdrop" aria-modal="true">
      <div
        className="settings-modal"
        role="dialog"
        aria-label="系统设置"
        ref={containerRef}
        tabIndex={-1}
      >
        <div className="settings-modal-header">
          <div>
            <h2>系统设置</h2>
            <p>统一管理巡检项、Agent 节点以及 License 授权。</p>
          </div>
          <button
            type="button"
            className="link-button"
            onClick={onClose}
            aria-label="关闭设置"
          >
            关闭
          </button>
        </div>
        <div className="settings-modal-shell">
          <nav className="settings-modal-nav">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`settings-nav-button${
                  tab.id === effectiveTabId ? " active" : ""
                }`}
                onClick={() => selectTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </nav>
          <section className="settings-modal-main">
            {currentTab.render({
              close: onClose,
              selectTab,
            })}
          </section>
        </div>
      </div>
      {confirmState && (
        <ConfirmationModal
          state={confirmState}
          onClose={onConfirmClose ?? onClose}
        />
      )}
    </div>
  );
};

interface SettingsOverviewPanelProps {
  onOpenInspection: () => void;
  onOpenLicense: () => void;
  license: LicenseCapabilities;
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
            <p>统一管理巡检项、Agent 节点以及 License 授权。</p>
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
          <button type="button" className="primary" onClick={onOpenInspection}>
            管理巡检项
          </button>
          <button type="button" className="secondary" onClick={onOpenLicense}>
            查看 License
          </button>
        </div>
      </div>
      <div className="settings-overview-card">
        <h4>License 详情</h4>
        <div className="settings-overview-status">
          <span className={`status-pill ${licenseStatusClass}`}>
            {licenseStatusLabel}
          </span>
          {licenseHint && (
            <span className="settings-overview-hint">{licenseHint}</span>
          )}
        </div>
        <div className="settings-overview-list">
          <strong>功能列表</strong>
          {featureList.length === 0 ? (
            <span className="settings-overview-hint">暂无启用功能</span>
          ) : (
            <div className="chip-group settings-overview-badges">
              {featureList.map((feature) => (
                <span key={`license-${feature}`}  className="chip">
                  {feature}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

interface InspectionSettingsPanelProps {
  items: InspectionItem[];
  submitting: boolean;
  notice: string | null;
  error: string | null;
  onClose: () => void;
  onSave: (payload: {
    id?: number;
    name: string;
    description?: string;
    check_type: string;
    config: Record<string, unknown>;
  }) => Promise<void>;
  onDelete: (item: InspectionItem) => void;
  onDeleteMany: (ids: number[]) => void;
  onExport: () => Promise<void> | void;
  onImport: (file: File) => Promise<void>;
}

const InspectionSettingsPanel = ({
  items,
  submitting,
  notice,
  error,
  onClose,
  onSave,
  onDelete,
  onDeleteMany,
  onExport,
  onImport,
}: InspectionSettingsPanelProps) => {
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [editingItem, setEditingItem] = useState<InspectionItem | null>(null);
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formCheckType, setFormCheckType] = useState("custom");
  const [configText, setConfigText] = useState("{}");
  const [formError, setFormError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editingItem) {
      setFormName("");
      setFormDescription("");
      setFormCheckType("custom");
      setConfigText("{}");
      setFormError(null);
    }
  }, [editingItem]);

  const startEdit = (item: InspectionItem) => {
    setEditingItem(item);
    setFormName(item.name ?? "");
    setFormDescription(item.description ?? "");
    setFormCheckType(item.check_type ?? "custom");
    setConfigText(
      item.config ? JSON.stringify(item.config, null, 2) : "{}"
    );
  };

  const resetForm = () => {
    setEditingItem(null);
    setFormName("");
    setFormDescription("");
    setFormCheckType("custom");
    setConfigText("{}");
    setFormError(null);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!formName.trim()) {
      setFormError("巡检项名称不能为空");
      return;
    }
    let parsedConfig: Record<string, unknown> = {};
    if (configText.trim()) {
      try {
        parsedConfig = JSON.parse(configText);
      } catch (err) {
        setFormError("Config 必须是合法的 JSON");
        return;
      }
    }
    setFormError(null);
    await onSave({
      id: editingItem?.id,
      name: formName.trim(),
      description: formDescription.trim() || undefined,
      check_type: formCheckType.trim() || "custom",
      config: parsedConfig,
    });
    resetForm();
  };

  const toggleSelection = (id: number) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((itemId) => itemId !== id) : [...prev, id]
    );
  };

  const toggleSelectAll = () => {
    if (selectedIds.length === items.length) {
      setSelectedIds([]);
      return;
    }
    setSelectedIds(items.map((item) => item.id));
  };

  const handleDeleteSelected = () => {
    if (selectedIds.length === 0) {
      return;
    }
    onDeleteMany(selectedIds);
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

  const currentSummary = editingItem
    ? `正在编辑：${editingItem.name}`
    : "新增巡检项";

  return (
    <div className="settings-content inspection-settings-panel">
      <div className="settings-header">
        <div>
          <h3>巡检项管理</h3>
          <p>{currentSummary}</p>
        </div>
        <div className="settings-actions">
          <button type="button" className="secondary" onClick={onClose}>
            关闭
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => onExport()}
            disabled={submitting}
          >
            导出
          </button>
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
            accept=".json"
            hidden
            onChange={handleImportChange}
          />
        </div>
      </div>
      {notice && <div className="feedback success">{notice}</div>}
      {error && <div className="feedback error">{error}</div>}
      {formError && <div className="feedback error">{formError}</div>}
      <div className="settings-content grid">
        <div className="settings-list">
          <div className="settings-actions">
            <label className="table-checkbox">
              <input
                type="checkbox"
                checked={selectedIds.length === items.length && items.length > 0}
                onChange={toggleSelectAll}
              />
              <span>全选</span>
            </label>
            <span>已选 {selectedIds.length} / {items.length}</span>
            <button
              type="button"
              className="link-button danger"
              onClick={handleDeleteSelected}
              disabled={selectedIds.length === 0}
            >
              批量删除
            </button>
          </div>
          <div className="table-wrapper">
            {items.length === 0 ? (
              <div className="placeholder">暂无巡检项</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>类型</th>
                    <th>更新时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <label className="table-checkbox">
                          <input
                            type="checkbox"
                            checked={selectedIds.includes(item.id)}
                            onChange={() => toggleSelection(item.id)}
                          />
                          <span>{item.name}</span>
                        </label>
                      </td>
                      <td>{item.check_type}</td>
                      <td>{formatDate(item.updated_at)}</td>
                      <td className="actions">
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
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
        <form className="settings-form" onSubmit={handleSubmit}>
          <h4>{editingItem ? "编辑巡检项" : "新增巡检项"}</h4>
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
          <label>
            类型
            <input
              type="text"
              value={formCheckType}
              onChange={(event) => setFormCheckType(event.target.value)}
              disabled={submitting}
              placeholder="custom"
            />
          </label>
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
          <label>
            Config (JSON)
            <textarea
              value={configText}
              onChange={(event) => setConfigText(event.target.value)}
              rows={6}
              disabled={submitting}
            />
          </label>
          <div className="settings-actions">
            <button
              type="button"
              className="secondary"
              onClick={resetForm}
              disabled={submitting}
            >
              重置
            </button>
            <button type="submit" className="primary" disabled={submitting}>
              {editingItem ? "保存修改" : "新增"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

interface LicenseSettingsPanelProps {
  status: LicenseCapabilities;
  uploading: boolean;
  textUploading: boolean;
  onUpload: (file: File) => Promise<LicenseStatus | null>;
  onUploadText: (value: string) => Promise<LicenseStatus | null>;
  onRefresh: () => Promise<LicenseStatus | null>;
}

const LicenseSettingsPanel = ({
  status,
  uploading,
  textUploading,
  onUpload,
  onUploadText,
  onRefresh,
}: LicenseSettingsPanelProps) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [textValue, setTextValue] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const handleFileChange = async (
    event: ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) {
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
      setLocalError(null);
      await onRefresh();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "刷新 License 状态失败";
      setLocalError(message);
    }
  };

  const licenseStatus = status.status;

  return (
    <div className="settings-content">
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
          >
            刷新状态
          </button>
        </div>
      </div>
      {status.reason && !status.valid && (
        <div className="feedback warning">{status.reason}</div>
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
      <section className="settings-form">
        <h4>License 详情</h4>
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
      <section className="settings-form">
        <h4>License 详情</h4>
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
  );
};

interface RunDetailViewProps {
  clusters: ClusterConfig[];
  items: InspectionItem[];
  runs: InspectionRunListItem[];
  onDeleteRun: (runId: number, redirectPath?: string) => Promise<void>;
  onCancelRun: (runId: number, redirectPath?: string) => Promise<void>;
  clusterDisplayIds: Record<number, string>;
  runDisplayIds: Record<number, string>;
  notice?: string | null;
  noticeType?: NoticeType;
  noticeScope?: NoticeScope | null;
  license: LicenseCapabilities;
}

const RunDetailView = ({
  clusters,
  items,
  runs,
  onDeleteRun,
  onCancelRun,
  clusterDisplayIds,
  runDisplayIds,
  notice,
  noticeType,
  noticeScope,
  license,
}: RunDetailViewProps) => {
  const { clusterKey, runKey } = useParams<{
    clusterKey?: string;
    runKey?: string;
  }>();
  const navigate = useNavigate();
  const [run, setRun] = useState<InspectionRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<
    InspectionResultStatus | "all"
  >("all");
  const [keyword, setKeyword] = useState("");
  const [refreshIndex, setRefreshIndex] = useState(0);

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
  const backTarget = cluster ? `/clusters/${clusterSlug}` : "/history";
  const summaryRun = run ?? fallbackRun;

  const shouldShowNotice =
    notice && noticeType && noticeScope === "runDetail";

  const resultStats = useMemo(() => {
    const stats = {
      passed: 0,
      warning: 0,
      failed: 0,
    };
    (run?.results ?? []).forEach((result) => {
      if (result.status === "passed") {
        stats.passed += 1;
      } else if (result.status === "warning") {
        stats.warning += 1;
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

  const totalItems =
    run?.total_items ?? summaryRun?.total_items ?? items.length ?? 0;
  const processedItems =
    run?.processed_items ?? summaryRun?.processed_items ?? 0;
  const progressValue =
    run?.progress ?? summaryRun?.progress ??
    (totalItems > 0 ? Math.round((processedItems / totalItems) * 100) : 0);
  const statusLabel =
    summaryRun?.status_label ?? summaryRun?.status ?? "未知状态";
  const statusValue = summaryRun?.status ?? "queued";
  const agentStatusLabel =
    summaryRun?.agent_status_label ??
    (summaryRun?.agent_status
      ? describeAgentStatus(summaryRun.agent_status)
      : null);
  const reportUrl = run?.report_path ?? summaryRun?.report_path ?? null;

  const handleRefresh = () => {
    setRefreshIndex((prev) => prev + 1);
  };

  const handleDelete = () => {
    if (resolvedRunId === null) {
      return;
    }
    void onDeleteRun(resolvedRunId, backTarget);
  };

  const handleCancel = () => {
    if (resolvedRunId === null) {
      return;
    }
    void onCancelRun(resolvedRunId);
  };

  return (
    <>
      <div className="detail-header">
        <button
          type="button"
          className="link-button"
          onClick={() => navigate(backTarget)}
        >
          ← 返回 {cluster ? `${cluster.name}` : "历史记录"}
        </button>
        <div className="detail-header-actions">
          <button
            type="button"
            className="secondary"
            onClick={handleRefresh}
            disabled={loading}
          >
            {loading ? "刷新中..." : "刷新"}
          </button>
          {summaryRun?.status === "running" && (
            <button
              type="button"
              className="secondary"
              onClick={handleCancel}
            >
              取消任务
            </button>
          )}
          <button
            type="button"
            className="secondary danger"
            onClick={handleDelete}
          >
            删除
          </button>
        </div>
      </div>

      {shouldShowNotice && noticeType && (
        <div className={`feedback ${noticeType}`}>{notice}</div>
      )}
      {error && <div className="feedback error">{error}</div>}
      {loading && <div className="feedback info">正在加载巡检详情...</div>}

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
            <strong>执行方式：</strong>
            {summaryRun
              ? describeExecutor(
                  summaryRun.executor,
                  summaryRun.agent_name,
                  summaryRun.agent_id
                )
              : "-"}
          </div>
          <div>
            <strong>Agent 状态：</strong>
            {summaryRun?.agent_status ? (
              <span className={agentStatusClassName(summaryRun.agent_status)}>
                {agentStatusLabel}
              </span>
            ) : (
              "-"
            )}
          </div>
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
        <div className="run-detail-actions">
          {reportUrl && license.canDownloadReports ? (
            <a
              className="primary"
              href={reportUrl}
              target="_blank"
              rel="noreferrer"
            >
              下载报告
            </a>
          ) : reportUrl ? (
            <button type="button" className="secondary" disabled>
              License 未授权下载报告
            </button>
          ) : (
            <span className="muted">暂未生成报告</span>
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
                {filteredResults.map((result) => {
                  const meta = getInspectionResultStatusMeta(result.status);
                  return (
                    <tr key={result.id}>
                      <td>{result.item_name}</td>
                      <td>
                        <span className={`status-pill ${meta.className}`}>
                          {meta.label}
                        </span>
                      </td>
                      <td>
                        <div className="result-detail">
                          {result.detail || "未提供详情"}
                        </div>
                      </td>
                      <td>
                        <div className="result-actions">
                          {result.suggestion || "未提供建议"}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
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
    setKubeconfigModalOpen(false);
    setKubeconfigText("");
    setKubeconfigFile(null);
    setKubeconfigFileName(null);
    setKubeconfigEdited(false);
    setFileError(null);
  }, [cluster]);

  const nameInputId = `cluster-edit-name-${cluster.id}`;
  const promInputId = `cluster-edit-prom-${cluster.id}`;
  const modalFileInputId = `cluster-edit-file-${cluster.id}`;

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
    await onSubmit({ name, prometheusUrl, file: fileForSubmit });
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
        ) : (
          <div className="modal-field">
            <span className="modal-field-label">kubeconfig</span>
            <div className="modal-kubeconfig-summary">
              kubeconfig 由 Agent 托管，如需更新请在 Agent 端处理。
            </div>
          </div>
        )}
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

const App = () => {
  const [clusters, setClusters] = useState<ClusterConfig[]>([]);
  const [agents, setAgents] = useState<InspectionAgent[]>([]);
  const [runs, setRuns] = useState<InspectionRunListItem[]>([]);
  const [items, setItems] = useState<InspectionItem[]>([]);

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

  const [selectedItemIds, setSelectedItemIdsState] = useState<number[]>([]);
  const [operator, setOperator] = useState("");

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
const [generatedAgentToken, setGeneratedAgentToken] = useState<string | null>(
  null
);
const [pendingRefreshTargets, setPendingRefreshTargets] = useState<
  Record<number, number>
>({});

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSubmitting, setSettingsSubmitting] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);
  const [settingsTabId, setSettingsTabId] = useState<string>("overview");
  const previousSettingsPathRef = useRef<string>("/");
  const backgroundLocationRef = useRef<RouterLocation | null>(null);
  const [licenseStatus, setLicenseStatus] = useState<LicenseStatus | null>(null);
  const [licenseError, setLicenseError] = useState<string | null>(null);
  const [licenseLoading, setLicenseLoading] = useState(false);
  const [licenseUploading, setLicenseUploading] = useState(false);
  const [licenseTextUploading, setLicenseTextUploading] = useState(false);

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
    licenseValid && licenseFeatureSet.has("reports");
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
    void refreshLicenseStatus();
  }, [refreshLicenseStatus]);

  const refreshAgents = useCallback(async () => {
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
  }, []);

  useEffect(() => {
    void refreshAgents();
  }, [refreshAgents]);

  const handleUploadLicenseFile = useCallback(
    async (file: File) => {
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
    []
  );

  const handleUploadLicenseText = useCallback(
    async (content: string) => {
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
    []
  );

  const sortedItems = useMemo(
    () => items.slice().sort(compareInspectionItemByName),
    [items]
  );

const location = useLocation();
const navigate = useNavigate();
const currentNoticeScope = useMemo(
  () => resolveNoticeScope(location.pathname),
  [location.pathname]
);
const backgroundLocation =
    (
      location.state as
        | {
            backgroundLocation?: RouterLocation;
          }
        | undefined
    )?.backgroundLocation ?? null;

  useEffect(() => {
    if (backgroundLocation) {
      backgroundLocationRef.current = backgroundLocation;
    }
  }, [backgroundLocation]);

  const routesLocation =
    location.pathname.startsWith(SETTINGS_BASE_PATH) && backgroundLocation
      ? backgroundLocation
      : location;

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
    if (!settingsOpen) {
      setConfirmState((prev) =>
        prev && prev.scope === "settings" ? null : prev
      );
    }
  }, [settingsOpen]);

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
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "获取集群信息失败";
      logWithTimestamp("error", "获取集群信息失败: %s", message);
      setClusterError(message);
    }
  }, []);

  const handleTestClusterConnection = useCallback(
    async (
      clusterId: number,
      options?: { quiet?: boolean }
    ) => {
      const { quiet } = options ?? {};
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
    ]
  );

  const refreshRuns = useCallback(async () => {
    try {
      logWithTimestamp("info", "开始获取巡检历史");
      const data = await getInspectionRuns();
      const filtered = data.filter(
        (run) => run.operator !== CONNECTION_TEST_OPERATOR
      );
      setRuns((previous) =>
        areRunListsEqual(previous, filtered) ? previous ?? filtered : filtered
      );
      logWithTimestamp("info", "巡检历史获取成功,数量: %d", filtered.length);
      return filtered;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "获取巡检历史失败";
      logWithTimestamp("error", "获取巡检历史失败: %s", message);
      showClusterNotice(currentNoticeScope, message, "error");
      return null;
    }
  }, [currentNoticeScope, showClusterNotice]);

  const handleCreateAgent = useCallback(
    async (payload: {
      name: string;
      description?: string;
      prometheus_url?: string | null;
    }) => {
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
      setAgentSubmitting(true);
      setAgentNotice(null);
      setAgentError(null);
      try {
        const response = await apiCreateAgent({
          ...payload,
          name: normalizedName,
        });
        setGeneratedAgentToken(response.token);
        setAgentNotice(
          `Agent ${response.name} 创建成功，请妥善保存 Token。`
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
    [licenseCapabilities, agents, refreshAgents, refreshClusters]
  );

  const handleClearAgentToken = useCallback(() => {
    setGeneratedAgentToken(null);
  }, []);

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
    if (!hasRunningRuns) {
      return;
    }
    let cancelled = false;

    const poll = async () => {
      const data = await refreshRuns();
      if (cancelled) {
        return;
      }
      const shouldContinue =
        data?.some(
          (run) =>
            run.status === "running" ||
            run.status === "queued" ||
            (!run.report_path && run.progress >= 100)
        ) ?? false;
      if (shouldContinue && !cancelled) {
        window.setTimeout(() => {
          if (!cancelled) {
            void poll();
          }
        }, 400);
      }
    };

    void poll();
    return () => {
      cancelled = true;
    };
  }, [hasRunningRuns, refreshRuns]);

  const refreshItems = useCallback(async () => {
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
  }, []);

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

  const handleOpenSettings = useCallback(() => {
    setSettingsError(null);
    setSettingsNotice(null);

    if (location.pathname.startsWith(SETTINGS_BASE_PATH)) {
      setSettingsOpen(true);
      return;
    }

    const currentPath = `${location.pathname}${location.search}${location.hash}`;
    previousSettingsPathRef.current =
      currentPath.length > 0 ? currentPath : "/";
    backgroundLocationRef.current = location;
    setSettingsTabId("overview");
    setSettingsOpen(true);
    navigate(SETTINGS_BASE_PATH, {
      state: { backgroundLocation: location },
    });
  }, [location, navigate]);

  const handleCloseSettings = useCallback(() => {
    const background = backgroundLocationRef.current;
    const target =
      (background
        ? `${background.pathname}${background.search}${background.hash}`
        : previousSettingsPathRef.current) || "/";
    setSettingsOpen(false);
    setConfirmState((prev) =>
      prev && prev.scope === "settings" ? null : prev
    );
    backgroundLocationRef.current = null;
    navigate(target, { replace: true });
  }, [navigate]);

  useEffect(() => {
    void refreshClusters();
    void refreshRuns();
    void refreshItems();
  }, [refreshClusters, refreshRuns, refreshItems]);

  useEffect(() => {
    if (pendingClusterIds.length === 0 || typeof window === "undefined") {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshClusters();
    }, 5000);
    return () => {
      window.clearInterval(timer);
    };
  }, [pendingClusterIds, refreshClusters]);

  useEffect(() => {
    setPendingRefreshTargets((prev) => {
      if (!Object.keys(prev).length) {
        return prev;
      }
      const next: Record<number, number> = {};
      clusters.forEach((cluster) => {
        const shouldKeep =
          prev[cluster.id] &&
          (cluster.connection_status === "pending" ||
            (cluster.connection_status === "warning" &&
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
  }, [pendingRefreshTargets, refreshClusters]);

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
    if (!licenseCapabilities.canManageClusters) {
      setClusterError(
        licenseCapabilities.reason ?? "当前 License 不支持集群管理。"
      );
      return;
    }
    setKubeconfigModalOpen(true);
  }, [licenseCapabilities, setClusterError]);

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
  ]);

  const handleUpdateClusterExecution = useCallback(
    async (clusterId: number, payload: { defaultAgentId: number | null }) => {
      if (!licenseCapabilities.canManageClusters) {
        const reason =
          licenseCapabilities.reason ?? "?? License ????????";
        setClusterError(reason);
        throw new Error(reason);
      }
      if (!licenseCapabilities.canManageAgents) {
        const reason =
          licenseCapabilities.reason ?? "?? License ??? Agent ???";
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
    async (clusterId: number) => {
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
          operatorName || undefined
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
  [selectedItemIds, operator, refreshRuns, refreshClusters, licenseCapabilities]
);

  const handleDeleteClustersBulk = useCallback(
    (clusterIds: number[]): Promise<void> => {
      const targets = clusters.filter((cluster) =>
        clusterIds.includes(cluster.id)
      );
      if (targets.length === 0) {
        return Promise.resolve();
      }
      setConfirmState({
        title: "批量删除集群",
        message: `确认删除选中的 ${targets.length} 个集群？该操作不可恢复。`,
        confirmLabel: "删除",
        variant: "danger",
        options: [
          {
            id: "deleteLocalFiles",
            label: "同时删除本地 kubeconfig 及关联巡检报告文件",
          },
        ],
        onConfirm: async (optionsMap) => {
          try {
            const deleteFiles = Boolean(optionsMap?.deleteLocalFiles);
            for (const cluster of targets) {
              logWithTimestamp("info", "删除集群: %s", cluster.id);
              await apiDeleteCluster(cluster.id, { deleteFiles });
            }
            await refreshClusters();
            await refreshRuns();
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
    [clusters, refreshClusters, refreshRuns, showClusterNotice]
  );

  const handleDeleteCluster = useCallback(
    (cluster: ClusterConfig): Promise<void> => {
      setConfirmState({
        title: "删除集群",
        message: `确认删除集群(${cluster.name})？该操作不可恢复。`,
        confirmLabel: "删除",
        variant: "danger",
        options: [
          {
            id: "deleteLocalFiles",
            label: "同时删除本地 kubeconfig 及关联巡检报告文件",
          },
        ],
          onConfirm: async (optionsMap) => {
            try {
              logWithTimestamp("info", "删除集群: %s", cluster.id);
              const deleteFiles = Boolean(optionsMap?.deleteLocalFiles);
              await apiDeleteCluster(cluster.id, { deleteFiles });
              await refreshClusters();
              await refreshRuns();
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
    [refreshClusters, refreshRuns, location.pathname, navigate, currentNoticeScope, showClusterNotice]
  );

  const handleDeleteRunsBulk = useCallback(
    (runIds: number[], scope: NoticeScope): Promise<void> => {
      const targets = runs.filter((run) => runIds.includes(run.id));
      if (targets.length === 0) {
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
            for (const run of targets) {
              logWithTimestamp("info", "删除巡检记录: %s", run.id);
              await apiDeleteInspectionRun(run.id, { deleteFiles });
            }
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
    [runs, refreshRuns, refreshClusters, showClusterNotice]
  );

  const handleDeleteRun = useCallback(
    (run: InspectionRunListItem): Promise<void> => {
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
    [runDisplayIds, refreshRuns, refreshClusters, currentNoticeScope, showClusterNotice]
  );

  const handleDeleteRunById = useCallback(
    (runId: number, redirectPath?: string): Promise<void> => {
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
    ]
  );

  const handleCancelRun = useCallback(
    (run: InspectionRunListItem): Promise<void> => {
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
    [runDisplayIds, refreshRuns, refreshClusters, currentNoticeScope, showClusterNotice]
  );

  const handleCancelRunById = useCallback(
    (runId: number, redirectPath?: string): Promise<void> => {
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
    ]
  );

  const handleEditCluster = useCallback((cluster: ClusterConfig) => {
    setClusterEditState(cluster);
    setClusterEditError(null);
  }, []);

  const handleSaveInspectionItem = useCallback(
    async ({
      id,
      name,
      description,
      check_type,
      config,
    }: {
      id?: number;
      name: string;
      description?: string;
      check_type: string;
      config: Record<string, unknown>;
    }) => {
      setSettingsSubmitting(true);
      try {
        if (id) {
          logWithTimestamp("info", "更新巡检项: %s", id);
          await apiUpdateInspectionItem(id, {
            name,
            description,
            check_type,
            config,
          });
          setSettingsNotice("巡检项已更新");
        } else {
          logWithTimestamp("info", "创建巡检项: %s", name);
          await apiCreateInspectionItem({
            name,
            description,
            check_type,
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
    [refreshItems]
  );

  const deleteInspectionItemsBatch = useCallback(
    async (ids: number[], successMessage: string) => {
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
    [refreshItems]
  );

  const performDeleteInspectionItem = useCallback(
    (item: InspectionItem) =>
      deleteInspectionItemsBatch([item.id], "巡检项已删除"),
    [deleteInspectionItemsBatch]
  );

  const handleDeleteInspectionItem = useCallback(
    (item: InspectionItem) => {
      setConfirmState({
        title: "删除巡检项",
        message: `确认删除巡检项(${item.name})？该操作不可恢复。`,
        confirmLabel: "删除",
        variant: "danger",
        scope: "settings",
        onConfirm: () => performDeleteInspectionItem(item),
      });
    },
    [performDeleteInspectionItem]
  );

  const handleDeleteInspectionItemsBulk = useCallback(
    (itemIds: number[]) => {
      const targetIds = items
        .filter((item) => itemIds.includes(item.id))
        .map((item) => item.id);
      if (targetIds.length === 0) {
        return;
      }
      setConfirmState({
        title: "批量删除巡检项",
        message: `确认删除选中的 ${targetIds.length} 条巡检项？该操作不可恢复。`,
        confirmLabel: "删除",
        variant: "danger",
        scope: "settings",
        onConfirm: () =>
          deleteInspectionItemsBatch(
            targetIds,
            `已删除 ${targetIds.length} 个巡检项`
          ),
      });
    },
    [items, deleteInspectionItemsBatch]
  );

  const handleExportInspectionItems = useCallback(async () => {
    setSettingsSubmitting(true);
    setSettingsNotice(null);
    setSettingsError(null);
    let objectUrl: string | null = null;
    let tempLink: HTMLAnchorElement | null = null;
    try {
      logWithTimestamp("info", "导出巡检项");
      const payload = await exportInspectionItems();
      const rawTimestamp = payload.exported_at ?? new Date().toISOString();
      let exportDate = new Date(rawTimestamp);
      if (Number.isNaN(exportDate.getTime())) {
        exportDate = new Date();
      }
      const pad = (value: number) => value.toString().padStart(2, "0");
      const filename = `inspection-items-${exportDate.getFullYear()}${pad(
        exportDate.getMonth() + 1
      )}${pad(exportDate.getDate())}-${pad(exportDate.getHours())}${pad(
        exportDate.getMinutes()
      )}${pad(exportDate.getSeconds())}.json`;

      const exportPayload = {
        exported_at: exportDate.toISOString(),
        items: payload.items,
      };
      const fileContent = JSON.stringify(exportPayload, null, 2);
      const blob = new Blob([fileContent], {
        type: "application/json;charset=utf-8",
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
  }, []);

  const handleImportInspectionItems = useCallback(
    async (file: File) => {
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
    [refreshItems]
  );

  const settingsTabs = useMemo<SettingsModalTab[]>(
    () => [
      {
        id: "overview",
        label: "设置总览",
        render: ({ selectTab }) => (
          <SettingsOverviewPanel
            onOpenInspection={() => selectTab("inspection")}
            onOpenLicense={() => selectTab("license")}
            license={licenseCapabilities}
          />
        ),
      },
      {
        id: "inspection",
        label: "巡检项设置",
        render: ({ close }) => (
          <InspectionSettingsPanel
            items={sortedItems}
            submitting={settingsSubmitting}
            notice={settingsNotice}
            error={settingsError}
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
        id: "license",
        label: "License 管理",
        render: () => (
          <LicenseSettingsPanel
            status={licenseCapabilities}
            uploading={licenseUploading}
            textUploading={licenseTextUploading}
            onUpload={handleUploadLicenseFile}
            onUploadText={handleUploadLicenseText}
            onRefresh={refreshLicenseStatus}
          />
        ),
      },
    ],
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
      licenseCapabilities,
      licenseUploading,
      licenseTextUploading,
      handleUploadLicenseFile,
      handleUploadLicenseText,
      refreshLicenseStatus,
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
        const baseBackground = backgroundLocation ?? backgroundLocationRef.current;
        navigate(targetPath, {
          replace: location.pathname.startsWith(SETTINGS_BASE_PATH),
          state: baseBackground ? { backgroundLocation: baseBackground } : undefined,
        });
      }
    },
    [
      settingsTabs,
      settingsTabId,
      navigate,
      location.pathname,
      backgroundLocation,
    ]
  );

  useEffect(() => {
    if (!settingsTabs.length) {
      return;
    }
    if (location.pathname.startsWith(SETTINGS_BASE_PATH)) {
      setSettingsOpen(true);
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
        const fallbackPath =
          nextTab === "overview"
            ? SETTINGS_BASE_PATH
            : `${SETTINGS_BASE_PATH}/${nextTab}`;
        if (location.pathname !== fallbackPath) {
          const baseBackground =
            backgroundLocation ?? backgroundLocationRef.current;
          navigate(fallbackPath, {
            replace: true,
            state: baseBackground ? { backgroundLocation: baseBackground } : undefined,
          });
        }
      }
    } else {
      setSettingsOpen(false);
      backgroundLocationRef.current = null;
    }
  }, [
    location.pathname,
    settingsTabs,
    settingsTabId,
    navigate,
    backgroundLocation,
  ]);

  const handleSubmitClusterEdit = useCallback(
    async ({
      name,
      prometheusUrl,
      file,
    }: {
      name: string;
      prometheusUrl: string;
      file: File | null;
    }) => {
      if (!clusterEditState) {
        return;
      }

      const trimmedName = name.trim();
      if (!trimmedName) {
        setClusterEditError("集群名称不能为空");
        return;
      }

      const formData = new FormData();
      formData.append("name", trimmedName);
      formData.append("prometheus_url", prometheusUrl.trim());
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
    ]
  );

  const closeClusterEditModal = () => {
    setClusterEditState(null);
    setClusterEditError(null);
  };

  const overviewRouteElement = (
    <OverviewView
      clusters={clusters}
      clusterError={clusterError}
      clusterNotice={clusterNotice}
      clusterNoticeType={clusterNoticeType}
      clusterNoticeScope={clusterNoticeScope}
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
      canManageAgents={licenseCapabilities.canManageAgents}
      agentSubmitting={agentSubmitting}
      agentNotice={agentNotice}
      agentError={agentError}
      generatedAgentToken={generatedAgentToken}
      onCreateAgent={handleCreateAgent}
      onClearAgentToken={handleClearAgentToken}
    />
  );

  return (
    <>
      <Helmet>
        <title>K8s Inspection Center</title>
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
      </Helmet>
      <TopNavigation onOpenSettings={handleOpenSettings} />
      <main className="app-shell">
        <Routes location={routesLocation}>
          <Route path="/" element={overviewRouteElement} />
          <Route path="/setting/*" element={overviewRouteElement} />
          <Route
            path="/history"
            element={
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
                notice={clusterNotice}
                noticeType={clusterNoticeType}
                noticeScope={clusterNoticeScope}
                license={licenseCapabilities}
              />
            }
          />
          <Route
            path="/clusters/:clusterKey"
            element={
              <ClusterDetailView
                clusters={clusters}
                items={sortedItems}
                runs={runs}
                selectedIds={selectedItemIds}
                setSelectedIds={setSelectedItemIds}
                operator={operator}
                setOperator={setOperator}
                inspectionLoading={inspectionLoading}
                notice={inspectionNotice}
                error={inspectionError}
                clusterNotice={clusterNotice}
                clusterNoticeType={clusterNoticeType}
                clusterNoticeScope={clusterNoticeScope}
                clusterError={clusterError}
                onStartInspection={handleStartInspection}
                onDeleteRun={handleDeleteRun}
                onDeleteRunsBulk={(ids) =>
                  handleDeleteRunsBulk(ids, "clusterDetail")
                }
                onCancelRun={handleCancelRun}
                onEditCluster={handleEditCluster}
                onDeleteCluster={handleDeleteCluster}
                clusterDisplayIds={clusterDisplayIds}
                runDisplayIds={runDisplayIds}
                onTestClusterConnection={handleTestClusterConnection}
                testingClusterIds={testingClusterIds}
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
                  onDeleteRun={handleDeleteRunById}
                onCancelRun={handleCancelRunById}
                clusterDisplayIds={clusterDisplayIds}
                runDisplayIds={runDisplayIds}
                notice={clusterNotice}
                noticeType={clusterNoticeType}
                noticeScope={clusterNoticeScope}
                license={licenseCapabilities}
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

      <SettingsModal
        open={settingsOpen}
        tabs={settingsTabs}
        initialTabId="overview"
        onClose={handleCloseSettings}
        confirmState={
          confirmState && confirmState.scope === "settings"
            ? confirmState
            : null
        }
        onConfirmClose={() => setConfirmState(null)}
        activeTabId={settingsTabId}
        onTabChange={handleSelectSettingsTab}
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









