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

const CLUSTER_ID_STORAGE_KEY = "clusterDisplayIdMap.v1";
const CLUSTER_PAGE_SIZE = 10;
const RUN_PAGE_SIZE_OPTIONS = [20, 50, 100] as const;
const SETTINGS_BASE_PATH = "/setting";

const BEIJING_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

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

const createDeterministicClusterSlug = (
  cluster: ClusterConfig,
  current?: string | null
) => {
  if (current && typeof current === "string") {
    return current;
  }
  const idSegment = cluster.id.toString(36).toUpperCase();
  const hashSegment = hashString(cluster.name || `cluster-${cluster.id}`)
    .slice(-4)
    .padStart(4, "0");
  return `${CLUSTER_SLUG_PREFIX}${idSegment}-${hashSegment}`;
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
  const used = new Set<string>(Object.values(current));
  const assigned: Record<number, string> = {};

  clusters.forEach((cluster) => {
    let displayId = createDeterministicClusterSlug(
      cluster,
      current[cluster.id]
    );
    if (used.has(displayId)) {
      let counter = 1;
      do {
        const saltedName = `${cluster.name}-${counter}`;
        displayId = createDeterministicClusterSlug(
          {
            ...cluster,
            name: saltedName,
          },
          null
        );
        counter += 1;
      } while (used.has(displayId));
    }
    assigned[cluster.id] = displayId;
    used.add(displayId);
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
  onTestClusterConnection: (clusterId: number) => Promise<void>;
  testingClusterIds: Record<number, boolean>;
  license: LicenseCapabilities;
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
}: OverviewProps) => {
  const navigate = useNavigate();
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
    () => Math.max(1, Math.ceil(clusters.length / CLUSTER_PAGE_SIZE)),
    [clusters.length]
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
    const start = (effectivePage - 1) * CLUSTER_PAGE_SIZE;
    return clusters.slice(start, start + CLUSTER_PAGE_SIZE);
  }, [clusters, effectivePage]);

  const handlePageChange = useCallback(
    (page: number) => {
      const target = Math.min(Math.max(page, 1), totalPages);
      updatePage(target);
    },
    [totalPages, updatePage]
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
            <p>上传 kubeconfig,配置 Prometheus,一键执行巡检并生成报告。</p>
          </div>
        </div>
        <div className="header-actions">
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
            还没有集群,请上传 kubeconfig 完成注册。
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
                      <button
                        className="link-button small"
                        onClick={(event) => {
                          event.stopPropagation();
                          void onTestClusterConnection(cluster.id);
                        }}
                        disabled={isTesting}
                      >
                        {isTesting ? "测试中..." : "测试连接"}
                      </button>
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
            {clusters.length > CLUSTER_PAGE_SIZE && (
              <div className="pagination">
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

  const [executorFilter, setExecutorFilter] = useState<ExecutionMode | "all">(
    "all"
  );
  const [agentStatusFilter, setAgentStatusFilter] = useState<
    InspectionAgentStatus | "all" | "none"
  >("all");

  const [pageSize, setPageSize] = useState<number>(RUN_PAGE_SIZE_OPTIONS[0]);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("");

  const filteredRuns = useMemo(() => {
    return runs.filter((run) => {
      if (executorFilter !== "all" && run.executor !== executorFilter) {
        return false;
      }
      if (agentStatusFilter === "none") {
        return run.executor !== "agent" || !run.agent_status;
      }
      if (agentStatusFilter !== "all") {
        return run.agent_status === agentStatusFilter;
      }
      return true;
    });
  }, [runs, executorFilter, agentStatusFilter]);

  useEffect(() => {
    setPage(1);
    setPageInput("");
  }, [pageSize]);

  useEffect(() => {
    setPage(1);
    setPageInput("");
  }, [executorFilter, agentStatusFilter]);

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

  const handleExecutorFilterChange = (
    event: ChangeEvent<HTMLSelectElement>
  ) => {
    setExecutorFilter(event.target.value as ExecutionMode | "all");
  };

  const handleAgentStatusFilterChange = (
    event: ChangeEvent<HTMLSelectElement>
  ) => {
    setAgentStatusFilter(
      event.target.value as InspectionAgentStatus | "all" | "none"
    );
  };

  return (
    <section className="card history history-page">
      <div className="card-header">
        <h2>历史巡检</h2>
        <div className="card-actions">
          <div className="card-actions-group history-filter-group">
            <label>
              执行方式
              <select value={executorFilter} onChange={handleExecutorFilterChange}>
                <option value="all">全部</option>
                <option value="server">服务端</option>
                <option value="agent">Agent</option>
              </select>
            </label>
            <label>
              Agent 状态
              <select value={agentStatusFilter} onChange={handleAgentStatusFilterChange}>
                <option value="all">全部</option>
                <option value="none">非 Agent / 未上报</option>
                <option value="queued">待执行</option>
                <option value="running">执行中</option>
                <option value="finished">已完成</option>
                <option value="failed">执行失败</option>
              </select>
            </label>
          </div>
          <button type="button" className="secondary" onClick={onRefreshRuns}>
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
                <th>执行方式</th>
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
                      {describeExecutor(
                        run.executor,
                        run.agent_name,
                        run.agent_id
                      )}
                    </td>
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
  onTestClusterConnection: (clusterId: number) => Promise<void>;
  testingClusterIds: Record<number, boolean>;
  license: LicenseCapabilities;
  agents: InspectionAgent[];
  agentLoading: boolean;
  agentError: string | null;
  onRefreshAgents: () => Promise<void>;
  onUpdateClusterExecution: (
    clusterId: number,
    payload: { defaultAgentId: number | null }
  ) => Promise<void>;
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
  agents,
  agentLoading,
  agentError,
  onRefreshAgents,
  onUpdateClusterExecution,
}: ClusterDetailViewProps) => {
  const { clusterKey } = useParams<{ clusterKey?: string }>();
  const navigate = useNavigate();
  const operatorInputId = useId();
  const [selectedRunIds, setSelectedRunIds] = useState<number[]>([]);
  const [agentConfigError, setAgentConfigError] = useState<string | null>(null);
  const [agentConfigLoading, setAgentConfigLoading] = useState(false);

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

  if (!clusterKey || resolvedClusterId === null) {
    return (
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
  }

  if (!cluster) {
    return (
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
  }

  const statusMeta = getClusterStatusMeta(cluster.connection_status);
  const clusterSlug = getClusterDisplayId(clusterDisplayIds, cluster.id, cluster);
  const isTesting = Boolean(testingClusterIds[cluster.id]);
  const contexts = cluster.contexts ?? [];
  const enabledAgents = useMemo(
    () => agents.filter((agent) => agent.is_enabled),
    [agents]
  );
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
    void onStartInspection(cluster.id);
  }, [cluster.id, onStartInspection]);

  const handleAgentChange = useCallback(
    async (event: ChangeEvent<HTMLSelectElement>) => {
      if (!cluster) {
        return;
      }
      const value = event.target.value;
      const nextAgentId = value ? Number(value) : null;
      if (
        (cluster.default_agent_id ?? null) === (nextAgentId ?? null) &&
        cluster.execution_mode === "agent"
      ) {
        return;
      }
      setAgentConfigError(null);
      setAgentConfigLoading(true);
      try {
        await onUpdateClusterExecution(cluster.id, {
          defaultAgentId: nextAgentId,
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "更新默认 Agent 失败";
        setAgentConfigError(message);
      } finally {
        setAgentConfigLoading(false);
      }
    },
    [cluster, onUpdateClusterExecution]
  );

  return (
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
            <div>
              <strong>连接说明：</strong>
              {cluster.connection_message || "尚未校验连接"}
            </div>
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
              <strong>执行模式：</strong>
              {cluster.execution_mode === "agent" ? "Agent 执行" : "服务器执行"}
            </div>
            <div>
              <strong>默认 Agent：</strong>
              {cluster.default_agent_name ||
                (cluster.default_agent_id
                  ? `Agent #${cluster.default_agent_id}`
                  : "未设置")}
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
          <div className="cluster-status-line detail-actions-inline">
            <button
              type="button"
              className="secondary"
              onClick={() => void onTestClusterConnection(cluster.id)}
              disabled={isTesting}
            >
              {isTesting ? "正在校验..." : "重新校验连接"}
            </button>
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
          <div className="agent-config-panel">
            <div className="agent-config-header">
              <h3>Agent 绑定</h3>
              <button
                type="button"
                className="link-button"
                onClick={() => void onRefreshAgents()}
                disabled={agentLoading}
              >
                {agentLoading ? "刷新中..." : "刷新列表"}
              </button>
            </div>
            {!license.canManageAgents && (
              <div className="feedback warning">
                当前 License 不支持调整 Agent，请联系管理员升级授权。
              </div>
            )}
            {agentError && <div className="feedback error">{agentError}</div>}
            {agentConfigError && (
              <div className="feedback error">{agentConfigError}</div>
            )}
            <label className="agent-config-field">
              默认 Agent
              <select
                value={
                  cluster.default_agent_id !== null &&
                  typeof cluster.default_agent_id === "number"
                    ? String(cluster.default_agent_id)
                    : ""
                }
                onChange={handleAgentChange}
                disabled={
                  agentConfigLoading ||
                  !license.canManageAgents ||
                  cluster.execution_mode !== "agent"
                }
              >
                <option value="">
                  {cluster.execution_mode === "agent"
                    ? "自动分配（执行时选择 Agent）"
                    : "服务器执行模式无需设置"}
                </option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                    {!agent.is_enabled ? "（已禁用）" : ""}
                  </option>
                ))}
              </select>
            </label>
            <p className="agent-config-note">
              可用 Agent：{enabledAgents.length} / {agents.length}
            </p>
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
                  <th>执行方式</th>
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
                        {describeExecutor(
                          run.executor,
                          run.agent_name,
                          run.agent_id
                        )}
                      </td>
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

interface AgentSettingsPanelProps {
  agents: InspectionAgent[];
  loading: boolean;
  submitting: boolean;
  notice: string | null;
  error: string | null;
  generatedToken: string | null;
  onRefresh: () => Promise<void>;
  onCreate: (payload: {
    name: string;
    description?: string;
    prometheus_url?: string | null;
  }) => Promise<void>;
  onUpdate: (
    agentId: number,
    payload: {
      name?: string;
      description?: string;
      is_enabled?: boolean;
      prometheus_url?: string | null;
    }
  ) => Promise<InspectionAgent | null>;
  onClearToken: () => void;
  canManageAgents: boolean;
}

const AgentSettingsPanel = ({
  agents,
  loading,
  submitting,
  notice,
  error,
  generatedToken,
  onRefresh,
  onCreate,
  onUpdate,
  onClearToken,
  canManageAgents,
}: AgentSettingsPanelProps) => {
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formPrometheusUrl, setFormPrometheusUrl] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedName = formName.trim();
    if (!trimmedName) {
      setFormError("Agent 名称不能为空");
      return;
    }
    setFormError(null);
    try {
      await onCreate({
        name: trimmedName,
        description: formDescription.trim() || undefined,
        prometheus_url: formPrometheusUrl.trim() || undefined,
      });
      setFormName("");
      setFormDescription("");
      setFormPrometheusUrl("");
    } catch (err) {
      const message = err instanceof Error ? err.message : "创建 Agent 失败";
      setFormError(message);
    }
  };

  const handleToggleAgent = async (agent: InspectionAgent) => {
    try {
      await onUpdate(agent.id, { is_enabled: !agent.is_enabled });
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="agent-settings-panel">
      <div className="agent-settings-header">
        <h3>Agent 管理</h3>
        <button
          type="button"
          className="secondary"
          onClick={() => void onRefresh()}
          disabled={loading || submitting}
        >
          {loading ? "刷新中..." : "刷新列表"}
        </button>
      </div>
      {notice && <div className="feedback success">{notice}</div>}
      {error && <div className="feedback error">{error}</div>}
      {!canManageAgents && (
        <div className="feedback warning">
          当前 License 不支持 Agent 管理，相关操作已禁用。
        </div>
      )}
      <section className="agent-create-section">
        <h4>新增 Agent</h4>
        <form className="agent-create-form" onSubmit={handleSubmit}>
          <label>
            Agent 名称
            <input
              type="text"
              value={formName}
              onChange={(event) => setFormName(event.target.value)}
              disabled={submitting || !canManageAgents}
              placeholder="例如：beijing-agent-01"
            />
          </label>
          <label>
            描述
            <input
              type="text"
              value={formDescription}
              onChange={(event) => setFormDescription(event.target.value)}
              disabled={submitting || !canManageAgents}
              placeholder="可选，说明用途或位置"
            />
          </label>
          <label>
            Agent Prometheus 地址
            <input
              type="text"
              value={formPrometheusUrl}
              onChange={(event) => setFormPrometheusUrl(event.target.value)}
              disabled={submitting || !canManageAgents}
              placeholder="可选，填写该 Agent 采集的 Prometheus 地址"
            />
          </label>
          {formError && <div className="feedback error">{formError}</div>}
          <div className="agent-create-actions">
            <button
              type="submit"
              className="primary"
              disabled={submitting || !canManageAgents}
            >
              {submitting ? "创建中..." : "创建 Agent"}
            </button>
          </div>
        </form>
        {generatedToken && (
          <div className="agent-token-box">
            <p>创建成功！请妥善保存 Token，页面关闭后将无法再次查看。</p>
            <code>{generatedToken}</code>
            <button
              type="button"
              className="secondary"
              onClick={onClearToken}
            >
              我已保存 Token
            </button>
          </div>
        )}
      </section>
      <section className="agent-list-section">
        <h4>已注册 Agent</h4>
        <div className="table-wrapper">
          {agents.length === 0 ? (
            <div className="placeholder">
              {loading ? "Agent 列表加载中..." : "暂无 Agent，请先创建。"}
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>名称</th>
                  <th>状态</th>
                  <th>最后上报</th>
                  <th>Prometheus</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => (
                  <tr key={agent.id}>
                    <td>
                      <div className="agent-name">{agent.name}</div>
                      {agent.description && (
                        <div className="agent-desc">{agent.description}</div>
                      )}
                    </td>
                    <td>
                      <span
                        className={`status-pill ${
                          agent.is_enabled ? "success" : "cancelled"
                        }`}
                      >
                        {agent.is_enabled ? "启用" : "已禁用"}
                      </span>
                    </td>
                    <td>{formatDate(agent.last_seen_at)}</td>
                    <td>{agent.prometheus_url || "-"}</td>
                    <td className="actions">
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => void handleToggleAgent(agent)}
                        disabled={submitting || !canManageAgents}
                      >
                        {agent.is_enabled ? "禁用" : "启用"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
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
    const fileForSubmit = resolveFileToUpload();
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
            onChange={(event) => setName(event.target.value)}
            disabled={submitting}
            required
          />
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
      <KubeconfigModal
        open={kubeconfigModalOpen}
        text={kubeconfigText}
        fileName={kubeconfigFileName}
        hasManualContent={hasManualKubeconfig}
        title="更新 kubeconfig"
        description="重新上传文件或粘贴最新的 kubeconfig 内容。"
        confirmLabel="完成"
        fileButtonLabel="选择文件"
        fileInputId={modalFileInputId}
        onClose={handleCloseModal}
        onFileSelected={handleFileSelected}
        onTextChange={handleTextChange}
        onClear={handleClear}
      />
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
  const [agentLoading, setAgentLoading] = useState(false);
  const [agentNotice, setAgentNotice] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [agentSubmitting, setAgentSubmitting] = useState(false);
  const [generatedAgentToken, setGeneratedAgentToken] = useState<string | null>(
    null
  );

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
    setAgentLoading(true);
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
    } finally {
      setAgentLoading(false);
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
      const isActive = Boolean(prev[clusterId]);
      if (isActive === value) {
        return prev;
      }
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

  const handleTestClusterConnection = useCallback(
    async (clusterId: number) => {
      clearClusterNotice();
      setClusterError(null);
      setClusterTesting(clusterId, true);
      try {
        logWithTimestamp("info", "开始测试集群连接: %s", clusterId);
        const updated = await testClusterConnection(clusterId);
        setClusters((prev) =>
          prev.map((item) => (item.id === updated.id ? updated : item))
        );
        const statusMeta = getClusterStatusMeta(updated.connection_status);
        const versionLabel =
          updated.kubernetes_version && updated.kubernetes_version.trim().length > 0
            ? updated.kubernetes_version.trim()
            : "未知";
        const nodeCountLabel =
          typeof updated.node_count === "number"
            ? String(updated.node_count)
            : "未知";
        let noticeType: NoticeType = "success";
        let noticeMessage: string;
        if (updated.connection_status === "connected") {
          noticeMessage = `集群(${updated.name}) 连接成功，版本：${versionLabel}，节点数：${nodeCountLabel}`;
        } else {
          if (updated.connection_status === "warning") {
            noticeType = "warning";
          } else if (updated.connection_status === "failed") {
            noticeType = "error";
          }
          const detailMessage = updated.connection_message
            ? `，详情：${updated.connection_message}`
            : "";
          noticeMessage = `集群(${updated.name}) ${statusMeta.label}${detailMessage}`;
        }
        showClusterNotice(currentNoticeScope, noticeMessage, noticeType);
        logWithTimestamp(
          "info",
          "集群连接测试完成: %s -> %s",
          clusterId,
          updated.connection_status
        );
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "测试集群连接失败";
        logWithTimestamp("error", "测试集群连接失败: %s", message);
        showClusterNotice(currentNoticeScope, message, "error");
      } finally {
        setClusterTesting(clusterId, false);
      }
    },
    [clearClusterNotice, currentNoticeScope, setClusterTesting, showClusterNotice]
  );

  const refreshClusters = useCallback(async () => {
    try {
      logWithTimestamp("info", "开始获取集群信息");
      const data = await getClusters();
      setClusters(data);
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

  const refreshRuns = useCallback(async () => {
    try {
      logWithTimestamp("info", "开始获取巡检历史");
      const data = await getInspectionRuns();
      setRuns((previous) =>
        areRunListsEqual(previous, data) ? previous ?? data : data
      );
      logWithTimestamp("info", "巡检历史获取成功,数量: %d", data.length);
      return data;
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
      setAgentSubmitting(true);
      setAgentNotice(null);
      setAgentError(null);
      try {
        const response = await apiCreateAgent(payload);
        setGeneratedAgentToken(response.token);
        setAgentNotice(
          `Agent ${response.name} 创建成功，请妥善保存 Token。`
        );
        await refreshAgents();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "创建 Agent 失败";
        setAgentError(message);
        throw err instanceof Error ? err : new Error(message);
      } finally {
        setAgentSubmitting(false);
      }
    },
    [licenseCapabilities, refreshAgents]
  );

  const handleUpdateAgent = useCallback(
    async (
      agentId: number,
      payload: {
        name?: string;
        description?: string;
        is_enabled?: boolean;
        prometheus_url?: string | null;
      }
    ) => {
      if (!licenseCapabilities.canManageAgents) {
        setAgentError(
          licenseCapabilities.reason ?? "当前 License 不支持 Agent 管理。"
        );
        return null;
      }
      setAgentSubmitting(true);
      setAgentNotice(null);
      setAgentError(null);
      try {
        const updated = await apiUpdateAgent(agentId, payload);
        setAgents((prev) =>
          prev.map((agent) => (agent.id === updated.id ? updated : agent))
        );
        if (payload.is_enabled !== undefined) {
          setAgentNotice(
            payload.is_enabled
              ? `Agent ${updated.name} 已启用`
              : `Agent ${updated.name} 已禁用`
          );
        } else {
          setAgentNotice(`Agent ${updated.name} 信息已更新`);
        }
        return updated;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "更新 Agent 失败";
        setAgentError(message);
        throw err instanceof Error ? err : new Error(message);
      } finally {
        setAgentSubmitting(false);
      }
    },
    [licenseCapabilities]
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
        id: "agents",
        label: "Agent 管理",
        render: () => (
          <AgentSettingsPanel
            agents={agents}
            loading={agentLoading}
            submitting={agentSubmitting}
            notice={agentNotice}
            error={agentError}
            generatedToken={generatedAgentToken}
            onRefresh={refreshAgents}
            onCreate={handleCreateAgent}
            onUpdate={handleUpdateAgent}
            onClearToken={handleClearAgentToken}
            canManageAgents={licenseCapabilities.canManageAgents}
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
      agents,
      clusters,
      agentLoading,
      agentSubmitting,
      agentNotice,
      agentError,
      generatedAgentToken,
      refreshAgents,
      handleCreateAgent,
      handleUpdateAgent,
      handleClearAgentToken,
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
                agents={agents}
                agentLoading={agentLoading}
                agentError={agentError}
                onRefreshAgents={refreshAgents}
                onUpdateClusterExecution={handleUpdateClusterExecution}
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












