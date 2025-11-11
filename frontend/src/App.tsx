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
  createInspectionRun,
  deleteCluster as apiDeleteCluster,
  deleteInspectionRun as apiDeleteInspectionRun,
  getClusters,
  getInspectionItems,
  getInspectionRun,
  getInspectionRuns,
  getReportDownloadUrl,
  registerCluster,
  updateCluster,
  testClusterConnection,
  cancelInspectionRun,
  getLicenseStatus,
  uploadLicense,
  uploadLicenseText,
  createInspectionItem as apiCreateInspectionItem,
  updateInspectionItem as apiUpdateInspectionItem,
  deleteInspectionItem as apiDeleteInspectionItem,
  exportInspectionItems,
  importInspectionItems,
} from "./api";
import { appConfig } from "./config";
import {
  ClusterConfig,
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

const statusClass = (status: string) => {
  switch (status) {
    case "completed":
      return "status-pill success";
    case "incomplete":
      return "status-pill danger";
    case "passed":
      return "status-pill success";
    case "warning":
      return "status-pill warning";
    case "failed":
      return "status-pill danger";
    case "running":
      return "status-pill running";
    case "paused":
      return "status-pill paused";
    case "cancelled":
      return "status-pill cancelled";
    default:
      return "status-pill";
  }
};

const formatRunStatusLabel = (status: InspectionRunStatus) => {
  switch (status) {
    case "running":
      return "巡检中";
    case "paused":
      return "暂停中";
    case "cancelled":
      return "已取消";
    case "completed":
      return "已完成";
    case "incomplete":
      return "未完成";
    case "passed":
      return "已通过";
    case "failed":
      return "执行失败";
    case "warning":
      return "存在告警";
    default:
      return status;
  }
};

const clampProgress = (value: number | undefined) => {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round(value)));
};

const STATUS_CIRCLE_RADIUS = 16;
const STATUS_CIRCLE_CIRCUMFERENCE = 2 * Math.PI * STATUS_CIRCLE_RADIUS;

const hasRunStateChanged = (
  previous: InspectionRun | null,
  next: InspectionRun
) => {
  if (!previous) {
    return true;
  }
  if (
    previous.status !== next.status ||
    previous.report_path !== next.report_path ||
    previous.summary !== next.summary ||
    previous.completed_at !== next.completed_at ||
    previous.total_items !== next.total_items ||
    previous.processed_items !== next.processed_items ||
    previous.progress !== next.progress
  ) {
    return true;
  }
  if (previous.results.length !== next.results.length) {
    return true;
  }
  for (let index = 0; index < next.results.length; index += 1) {
    const prevResult = previous.results[index];
    const nextResult = next.results[index];
    if (
      !prevResult ||
      prevResult.status !== nextResult.status ||
      prevResult.detail !== nextResult.detail ||
      prevResult.suggestion !== nextResult.suggestion
    ) {
      return true;
    }
  }
  return false;
};

type RunProgressInfo = {
  status: InspectionRunStatus;
  progress: number;
  processed: number;
  total: number;
  pending: number;
  reportReady: boolean;
};

const buildRunProgressInfo = (run: InspectionRun): RunProgressInfo => {
  const total = Math.max(run.total_items ?? 0, run.results.length);
  const processed = Math.min(run.processed_items ?? 0, total);
  const pending = Math.max(total - processed, 0);
  const progress = clampProgress(run.progress);
  return {
    status: run.status,
    progress,
    processed,
    total,
    pending,
    reportReady: Boolean(run.report_path),
  };
};

const isProgressInfoEqual = (
  previous: RunProgressInfo | null,
  next: RunProgressInfo
) => {
  if (!previous) {
    return false;
  }
  return (
    previous.status === next.status &&
    previous.progress === next.progress &&
    previous.processed === next.processed &&
    previous.total === next.total &&
    previous.pending === next.pending &&
    previous.reportReady === next.reportReady
    );
  };

const areRunListsEqual = (
  previous: InspectionRunListItem[] | undefined,
  next: InspectionRunListItem[]
) => {
  if (!previous || previous.length !== next.length) {
    return false;
  }
  for (let index = 0; index < next.length; index += 1) {
    const prev = previous[index];
    const curr = next[index];
    if (
      prev.id !== curr.id ||
      prev.status !== curr.status ||
      prev.progress !== curr.progress ||
      prev.processed_items !== curr.processed_items ||
      prev.total_items !== curr.total_items ||
      prev.report_path !== curr.report_path
    ) {
      return false;
    }
  }
  return true;
};

const isRunStillProcessing = (
  info: RunProgressInfo | null,
  run: InspectionRun | null
) => {
  if (info) {
    return (
      info.status === "running" ||
      info.status === "paused" ||
      (!info.reportReady && info.progress >= 100)
    );
  }
  if (!run) {
    return false;
  }
  const progress = clampProgress(run.progress);
  return (
    run.status === "running" ||
    run.status === "paused" ||
    (!run.report_path && progress >= 100)
  );
};

const areResultsEqual = (
  previous: InspectionResult[] | null | undefined,
  next: InspectionResult[]
) => {
  if (!previous || previous.length !== next.length) {
    return false;
  }
  for (let index = 0; index < next.length; index += 1) {
    const prev = previous[index];
    const curr = next[index];
    if (
      prev.id !== curr.id ||
      prev.status !== curr.status ||
      prev.detail !== curr.detail ||
      prev.suggestion !== curr.suggestion
    ) {
      return false;
    }
  }
  return true;
};

const renderRunStatusBadge = (
  status: InspectionRunStatus,
  progress?: number
) => {
  if (status === "running" || status === "paused" || status === "cancelled") {
    const clamped = clampProgress(progress);
    const progressClassName = [
      "status-progress status-progress-circle",
      status === "paused"
        ? "paused"
        : status === "cancelled"
        ? "cancelled"
        : null,
    ]
      .filter(Boolean)
      .join(" ");
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
        <span className={statusClass(status)}>
          {formatRunStatusLabel(status)}
        </span>
      </div>
    );
  }

  return (
    <span className={statusClass(status)}>{formatRunStatusLabel(status)}</span>
  );
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
              type="button"
              className={`cluster-upload-trigger${
                kubeconfigReady ? " ready" : ""
              }`}
              onClick={openKubeconfigModal}
              disabled={!license.canManageClusters}
            >
              {kubeconfigReady ? "查看 / 更新 kubeconfig" : "导入 kubeconfig"}
            </button>
            <div className="cluster-upload-hint">
              {kubeconfigSummary ?? "支持上传文件或粘贴 YAML 内容"}
            </div>
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

  const [pageSize, setPageSize] = useState<number>(RUN_PAGE_SIZE_OPTIONS[0]);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("");

  useEffect(() => {
    setPage(1);
    setPageInput("");
  }, [pageSize]);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(runs.length / Math.max(pageSize, 1))),
    [runs.length, pageSize]
  );

  useEffect(() => {
    setPage((prev) => Math.min(Math.max(prev, 1), totalPages));
  }, [totalPages]);

  const [selectedRunIds, setSelectedRunIds] = useState<number[]>([]);

  useEffect(() => {
    setSelectedRunIds((prev) =>
      prev.filter((id) => runs.some((run) => run.id === id))
    );
  }, [runs]);

  const pagedRuns = useMemo(() => {
    const start = (page - 1) * pageSize;
    return runs.slice(start, start + pageSize);
  }, [runs, page, pageSize]);

  const allSelected =
    runs.length > 0 && selectedRunIds.length === runs.length;

  const handleToggleRun = useCallback((runId: number) => {
    setSelectedRunIds((prev) =>
      prev.includes(runId)
        ? prev.filter((id) => id !== runId)
        : [...prev, runId]
    );
  }, []);

  const handleToggleAllRuns = useCallback(() => {
    setSelectedRunIds((prev) => {
      if (runs.length === 0) {
        return [];
      }
      if (prev.length === runs.length) {
        return [];
      }
      return runs.map((run) => run.id);
    });
  }, [runs]);

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

  return (
    <section className="card history history-page">
      <div className="card-header">
          <h2>历史巡检</h2>
          <div className="card-actions">
            {runs.length > 0 && (
              <>
                <div className="card-actions-group">
                <span className="selection-hint">
                  已选 {selectedRunIds.length} / {runs.length}
                </span>
                <button
                  type="button"
                  className="secondary"
                  onClick={handleToggleAllRuns}
                >
                  {allSelected ? "取消全选" : "全选"}
                </button>
                <button
                  type="button"
                  className="secondary danger"
                    onClick={handleDeleteSelectedRuns}
                    disabled={selectedRunIds.length === 0}
                  >
                    删除选中
                  </button>
                </div>
              </>
            )}
            <button
              type="button"
              className="secondary"
            onClick={() => void onRefreshRuns()}
          >
            刷新
          </button>
        </div>
      </div>
      {shouldShowNotice && (
        <div className={`feedback ${noticeType}`}>{notice}</div>
      )}
      {!license.canDownloadReports && (
        <div className="feedback warning">
          {license.reason ?? "当前 License 不支持下载巡检报告。"}
        </div>
      )}
      {runs.length === 0 ? (
        <div className="placeholder">暂无巡检记录，请稍后再查看。</div>
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th className="selection-cell">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={handleToggleAllRuns}
                  />
                </th>
                <th>巡检编号</th>
                <th>集群</th>
                <th>巡检人</th>
                <th>状态</th>
                <th>开始时间</th>
                <th>结束时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {pagedRuns.map((run) => {
                const clusterSlug = getClusterDisplayId(
                  clusterDisplayIds,
                  run.cluster_id
                );
                const runSlug = runDisplayIds[run.id] ?? String(run.id);
                const isSelected = selectedRunIds.includes(run.id);
                return (
                  <tr
                    key={run.id}
                    className={isSelected ? "selected-row" : undefined}
                  >
                    <td className="selection-cell">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => handleToggleRun(run.id)}
                      />
                    </td>
                    <td>{runSlug}</td>
                    <td>
                      {run.cluster_name}({clusterSlug})
                    </td>
                    <td>{run.operator || "-"}</td>
                    <td>
                      {renderRunStatusBadge(run.status, run.progress)}
                    </td>
                    <td>{formatDate(run.created_at)}</td>
                    <td>{formatDate(run.completed_at)}</td>
                    <td className="actions">
                      <button
                        className="link-button"
                        onClick={() =>
                          navigate(`/clusters/${clusterSlug}/runs/${runSlug}`)
                        }
                      >
                        查看详情
                      </button>
                      {(run.status === "running" || run.status === "paused") && (
                        <button
                          className="link-button danger"
                          onClick={async () => await onCancelRun(run)}
                        >
                          取消
                        </button>
                      )}
                      {license.canDownloadReports && run.report_path && (
                        <>
                          <a
                            className="link-button"
                            href={getReportDownloadUrl(run.id, "pdf")}
                            target="_blank"
                            rel="noreferrer"
                          >
                            下载PDF
                          </a>
                          <a
                            className="link-button"
                            href={getReportDownloadUrl(run.id, "md")}
                            target="_blank"
                            rel="noreferrer"
                          >
                            下载Markdown
                          </a>
                        </>
                      )}
                      <button
                        className="link-button danger"
                        onClick={async () => await onDeleteRun(run)}
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {runs.length > 0 && (
        <div className="table-pagination">
          <label className="page-size-control">
            每页
            <select
              className="page-size-select"
              value={pageSize}
              onChange={(event) =>
                handlePageSizeChange(Number(event.target.value))
              }
            >
              {RUN_PAGE_SIZE_OPTIONS.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <span className="page-indicator">
            第 {page} / {totalPages} 页
          </span>
          <button
            type="button"
            className="pagination-nav"
            onClick={() => handlePageChange(-1)}
            disabled={page <= 1}
          >
            上一页
          </button>
          <button
            type="button"
            className="pagination-nav"
            onClick={() => handlePageChange(1)}
            disabled={page >= totalPages}
          >
            下一页
          </button>
          <div className="page-jump">
            <input
              type="number"
              min={1}
              max={totalPages}
              value={pageInput}
              onChange={(event) => setPageInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handlePageJump();
                }
              }}
              className="page-jump-input"
              placeholder="页码"
            />
            <button
              type="button"
              className="secondary"
              onClick={handlePageJump}
              disabled={totalPages === 0}
            >
              跳转
            </button>
          </div>
        </div>
      )}
    </section>
  );
};

interface ClusterDetailProps {
  clusters: ClusterConfig[];
  items: InspectionItem[];
  runs: InspectionRunListItem[];
  selectedIds: number[];
  setSelectedIds: (updater: (prev: number[]) => number[]) => void;
  operator: string;
  setOperator: (value: string) => void;
  inspectionLoading: boolean;
  notice: string | null;
  noticeType: NoticeType | null;
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
}

interface ClusterDetailContentProps {
  cluster: ClusterConfig;
  clusterSlug: string;
  items: InspectionItem[];
  runs: InspectionRunListItem[];
  selectedIds: number[];
  setSelectedIds: (updater: (prev: number[]) => number[]) => void;
  operator: string;
  setOperator: (value: string) => void;
  inspectionLoading: boolean;
  notice: string | null;
  noticeType: NoticeType | null;
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
}

const ClusterDetailContent = ({
  cluster,
  clusterSlug,
  items,
  runs,
  selectedIds,
  setSelectedIds,
  operator,
  setOperator,
  inspectionLoading,
  notice,
  noticeType,
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
}: ClusterDetailContentProps) => {
  const navigate = useNavigate();

  const shouldShowNotice =
    notice && noticeType && clusterNoticeScope === "clusterDetail";

  useEffect(() => {
    setSelectedIds(() => []);
  }, [cluster.id, setSelectedIds]);

  const clusterRuns = useMemo(
    () => runs.filter((run) => run.cluster_id === cluster.id),
    [runs, cluster.id]
  );

  const [runPageSize, setRunPageSize] = useState<number>(
    RUN_PAGE_SIZE_OPTIONS[0]
  );
  const [runPage, setRunPage] = useState(1);
  const [runPageInput, setRunPageInput] = useState("");

  useEffect(() => {
    setRunPage(1);
    setRunPageInput("");
  }, [cluster.id]);

  useEffect(() => {
    setRunPage(1);
    setRunPageInput("");
  }, [runPageSize]);

  const totalRunPages = useMemo(
    () =>
      Math.max(
        1,
        Math.ceil(clusterRuns.length / Math.max(runPageSize, 1))
      ),
    [clusterRuns.length, runPageSize]
  );

  useEffect(() => {
    setRunPage((prev) => Math.min(Math.max(prev, 1), totalRunPages));
  }, [totalRunPages]);

  const pagedClusterRuns = useMemo(() => {
    const start = (runPage - 1) * runPageSize;
    return clusterRuns.slice(start, start + runPageSize);
  }, [clusterRuns, runPage, runPageSize]);

  const [selectedRunIds, setSelectedRunIds] = useState<number[]>([]);

  useEffect(() => {
    setSelectedRunIds((prev) =>
      prev.filter((id) => clusterRuns.some((run) => run.id === id))
    );
  }, [clusterRuns]);

  useEffect(() => {
    setSelectedRunIds([]);
  }, [cluster.id]);

  const allRunsSelected =
    clusterRuns.length > 0 && selectedRunIds.length === clusterRuns.length;

  const handleToggleClusterRun = useCallback((runId: number) => {
    setSelectedRunIds((prev) =>
      prev.includes(runId)
        ? prev.filter((id) => id !== runId)
        : [...prev, runId]
    );
  }, []);

  const handleToggleAllClusterRuns = useCallback(() => {
    setSelectedRunIds((prev) => {
      if (clusterRuns.length === 0) {
        return [];
      }
      if (prev.length === clusterRuns.length) {
        return [];
      }
      return clusterRuns.map((run) => run.id);
    });
  }, [clusterRuns]);

  const handleDeleteSelectedClusterRuns = useCallback(() => {
    if (selectedRunIds.length === 0) {
      return;
    }
    void onDeleteRunsBulk(selectedRunIds);
  }, [onDeleteRunsBulk, selectedRunIds]);

  const PAGE_SIZE = 10;
  const [itemPage, setItemPage] = useState(0);

  useEffect(() => {
    setItemPage(0);
  }, [cluster.id]);

  const totalItemPages = useMemo(
    () => Math.max(1, Math.ceil(items.length / PAGE_SIZE)),
    [items.length]
  );

  useEffect(() => {
    setItemPage(0);
  }, [items.length]);

  useEffect(() => {
    if (itemPage >= totalItemPages) {
      setItemPage(totalItemPages - 1);
    }
  }, [itemPage, totalItemPages]);

  const pagedItems = useMemo(
    () =>
      items.slice(
        itemPage * PAGE_SIZE,
        Math.min(items.length, (itemPage + 1) * PAGE_SIZE)
      ),
    [items, itemPage]
  );

  const statusMeta = getClusterStatusMeta(cluster.connection_status);
  const isTesting = Boolean(testingClusterIds[cluster.id]);

  const resolvedClusterSlug =
    clusterSlug ??
    getClusterDisplayId(clusterDisplayIds, cluster.id, cluster);

  const versionLabel =
    cluster.kubernetes_version && cluster.kubernetes_version.trim().length > 0
      ? cluster.kubernetes_version.trim()
      : "未知";
  const nodeCountLabel =
    typeof cluster.node_count === "number"
      ? String(cluster.node_count)
      : "未知";

  const handleToggleItem = (id: number) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const handleToggleAll = () => {
    setSelectedIds((prev) =>
      prev.length === items.length ? [] : items.map((item) => item.id)
    );
  };

  const handleRunPageChange = useCallback(
    (offset: number) => {
      setRunPage((prev) => {
        const next = prev + offset;
        if (next < 1) {
          return 1;
        }
        if (next > totalRunPages) {
          return totalRunPages;
        }
        return next;
      });
    },
    [totalRunPages]
  );

  const handleRunPageSizeChange = useCallback((value: number) => {
    setRunPageSize(value);
  }, []);

  const handleRunPageJump = useCallback(() => {
    const trimmed = runPageInput.trim();
    if (!trimmed) {
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isNaN(parsed) && Number.isInteger(parsed)) {
      const clamped = Math.min(Math.max(parsed, 1), totalRunPages);
      setRunPage(clamped);
    }
    setRunPageInput("");
  }, [runPageInput, totalRunPages]);

  const handleChangePage = (offset: number) => {
    setItemPage((prev) => {
      const next = prev + offset;
      if (next < 0) {
        return 0;
      }
      if (next >= totalItemPages) {
        return totalItemPages - 1;
      }
      return next;
    });
  };

  return (
    <>
      <div className="detail-header">
        <button className="link-button" onClick={() => navigate("/")}>
          返回上一页
        </button>
        <div className="detail-header-actions">
          <button
            className="secondary"
            onClick={() => void onTestClusterConnection(cluster.id)}
            disabled={isTesting}
          >
            {isTesting ? "测试中..." : "测试连接"}
          </button>
          <button className="secondary" onClick={() => onEditCluster(cluster)}>
            编辑集群
          </button>
          <button
            className="secondary danger"
            onClick={async () => await onDeleteCluster(cluster)}
          >
            删除集群
          </button>
        </div>
      </div>

      {clusterError && <div className="feedback error">{clusterError}</div>}
      {clusterNotice &&
        clusterNoticeType &&
        clusterNoticeScope === "clusterDetail" && (
          <div className={`feedback ${clusterNoticeType}`}>{clusterNotice}</div>
        )}
      {error && <div className="feedback error">{error}</div>}
      {notice && <div className="feedback success">{notice}</div>}

      <section className="detail-grid">
        <div className="detail-card">
          <h2>集群概览</h2>
          <div className="cluster-summary">
            <div>
              <strong>名称: </strong>
              {cluster.name}
            </div>
            <div>
              <strong>集群编号: </strong>
              {resolvedClusterSlug}
            </div>
            <div>
              <strong>连接状态: </strong>
              <span className={`status-chip ${statusMeta.className}`}>
                {statusMeta.label}
              </span>
            </div>
            <div>
              <strong>集群版本: </strong>
              {versionLabel}
            </div>
            <div>
              <strong>节点数: </strong>
              {nodeCountLabel}
            </div>
            <div>
              <strong>最近校验: </strong>
              {formatDate(cluster.last_checked_at)}
            </div>
            <div>
              <strong>Prometheus: </strong>
              {cluster.prometheus_url || "未配置"}
            </div>
            <div>
              <strong>创建时间: </strong>
              {formatDate(cluster.created_at)}
            </div>
            <div>
              <strong>更新时间: </strong>
              {formatDate(cluster.updated_at)}
            </div>
          </div>
          <div className="cluster-contexts detail-contexts">
            {cluster.contexts.length > 0 ? (
              cluster.contexts.map((ctx) => (
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
          <div className="operator-inline">
            <label htmlFor="operator-detail">巡检人</label>
            <input
              id="operator-detail"
              placeholder="输入巡检人姓名(可选)"
              value={operator}
              onChange={(event) => setOperator(event.target.value)}
            />
          </div>
          <p className="card-caption">
            已选择 {selectedIds.length} / {items.length} 个巡检项
          </p>
          <ul className="item-list">
            {pagedItems.map((item) => (
              <li key={item.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(item.id)}
                    onChange={() => handleToggleItem(item.id)}
                  />
                  <div>
                    <div className="item-name">{item.name}</div>
                    <div className="item-desc">{item.description || "-"}</div>
                  </div>
                </label>
              </li>
            ))}
          </ul>
          {items.length > PAGE_SIZE && (
            <div className="item-pagination">
              <button
                type="button"
                className="pagination-nav"
                onClick={() => handleChangePage(-1)}
                disabled={itemPage === 0}
              >
                上一页
              </button>
              <span className="item-pagination-status">
                第 {itemPage + 1} / {totalItemPages} 页
              </span>
              <button
                type="button"
                className="pagination-nav"
                onClick={() => handleChangePage(1)}
                disabled={itemPage + 1 >= totalItemPages}
              >
                下一页
              </button>
            </div>
          )}
          <div className="detail-actions">
      <button className="secondary" onClick={handleToggleAll}>
        {selectedIds.length === items.length ? "清除选择" : "全选"}
      </button>
      <button
        className="primary"
        onClick={() => onStartInspection(cluster.id)}
        disabled={inspectionLoading || !license.canRunInspections}
      >
        {inspectionLoading ? "巡检中..." : "开始巡检"}
      </button>
      {!license.canRunInspections && (
        <span className="card-caption">
          {license.reason ?? "当前 License 不支持巡检功能。"}
        </span>
      )}
          </div>
        </div>
      </section>

      <section className="card history">
        <div className="card-header">
          <h2>{cluster.name} · 巡检记录</h2>
          {clusterRuns.length > 0 && (
            <div className="card-actions">
              <div className="card-actions-group">
                <span className="selection-hint">
                  已选 {selectedRunIds.length} / {clusterRuns.length}
                </span>
                <button
                  type="button"
                  className="secondary"
                  onClick={handleToggleAllClusterRuns}
                >
                  {allRunsSelected ? "取消全选" : "全选"}
                </button>
                <button
                  type="button"
                  className="secondary danger"
                  onClick={handleDeleteSelectedClusterRuns}
                  disabled={selectedRunIds.length === 0}
                >
                  删除选中
                </button>
              </div>
            </div>
          )}
        </div>
        {!license.canDownloadReports && (
          <div className="feedback warning">
            {license.reason ?? "当前 License 不支持下载巡检报告。"}
          </div>
        )}
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th className="selection-cell">
                  <input
                    type="checkbox"
                    checked={allRunsSelected}
                    onChange={handleToggleAllClusterRuns}
                  />
                </th>
                <th>巡检编号</th>
                <th>巡检人</th>
                <th>状态</th>
                <th>开始时间</th>
                <th>结束时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {pagedClusterRuns.map((run) => {
                const runSlug = runDisplayIds[run.id] ?? String(run.id);
                const isSelected = selectedRunIds.includes(run.id);
                return (
                  <tr
                    key={run.id}
                    className={isSelected ? "selected-row" : undefined}
                  >
                    <td className="selection-cell">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => handleToggleClusterRun(run.id)}
                      />
                    </td>
                    <td>{runSlug}</td>
                    <td>{run.operator || "-"}</td>
                    <td>
                      {renderRunStatusBadge(run.status, run.progress)}
                    </td>
                    <td>{formatDate(run.created_at)}</td>
                    <td>{formatDate(run.completed_at)}</td>
                    <td className="actions">
                      <button
                        className="link-button"
                        onClick={() =>
                          navigate(
                            `/clusters/${resolvedClusterSlug}/runs/${runSlug}`
                          )
                        }
                      >
                        查看详情
                      </button>
                      {(run.status === "running" || run.status === "paused") && (
                        <button
                          className="link-button danger"
                          onClick={async (event) => {
                            event.stopPropagation();
                            await onCancelRun(run);
                          }}
                        >
                          取消
                        </button>
                      )}
                      {license.canDownloadReports && run.report_path && (
                        <>
                          <a
                            className="link-button"
                            href={getReportDownloadUrl(run.id, "pdf")}
                            target="_blank"
                            rel="noreferrer"
                          >
                            下载PDF
                          </a>
                          <a
                            className="link-button"
                            href={getReportDownloadUrl(run.id, "md")}
                            target="_blank"
                            rel="noreferrer"
                          >
                            下载Markdown
                          </a>
                        </>
                      )}
                      <button
                        className="link-button danger"
                        onClick={async () => await onDeleteRun(run)}
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {clusterRuns.length > 0 && (
          <div className="table-pagination">
            <label className="page-size-control">
              每页
              <select
                className="page-size-select"
                value={runPageSize}
                onChange={(event) =>
                  handleRunPageSizeChange(Number(event.target.value))
                }
              >
                {RUN_PAGE_SIZE_OPTIONS.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>
            <span className="page-indicator">
              第 {runPage} / {totalRunPages} 页
            </span>
            <button
              type="button"
              className="pagination-nav"
              onClick={() => handleRunPageChange(-1)}
              disabled={runPage <= 1}
            >
              上一页
            </button>
            <button
              type="button"
              className="pagination-nav"
              onClick={() => handleRunPageChange(1)}
              disabled={runPage >= totalRunPages}
            >
              下一页
            </button>
            <div className="page-jump">
              <input
                type="number"
                min={1}
                max={totalRunPages}
                value={runPageInput}
                onChange={(event) => setRunPageInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    handleRunPageJump();
                  }
                }}
                className="page-jump-input"
                placeholder="页码"
              />
              <button
                type="button"
                className="secondary"
                onClick={handleRunPageJump}
                disabled={totalRunPages === 0}
              >
                跳转
              </button>
            </div>
          </div>
        )}
      </section>
    </>
  );
};

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
  noticeType,
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
}: ClusterDetailProps) => {
  const { clusterKey } = useParams<{ clusterKey?: string }>();
  const navigate = useNavigate();

  const numericId = useMemo(() => {
    if (!clusterKey) {
      return Number.NaN;
    }
    const decoded = decodeClusterKeyToId(
      clusterKey,
      clusterDisplayIds,
      clusters
    );
    return decoded ?? Number.NaN;
  }, [clusterKey, clusterDisplayIds, clusters]);

  useEffect(() => {
    setSelectedIds(() => []);
  }, [numericId, setSelectedIds]);

  if (Number.isNaN(numericId)) {
    return (
      <div className="detail-empty">
        <p>集群信息加载中...</p>
        <button className="secondary" onClick={() => navigate("/")}>
          返回集群列表
        </button>
      </div>
    );
  }

  const cluster = useMemo(
    () => clusters.find((item) => item.id === numericId) ?? null,
    [clusters, numericId]
  );

  if (!cluster) {
    if (clusters.length === 0) {
      return (
        <div className="detail-empty">
          <p>集群信息加载中...</p>
          <button className="secondary" onClick={() => navigate("/")}>
            返回集群列表
          </button>
        </div>
      );
    }
    return (
      <div className="detail-empty">
        <p>未找到集群。</p>
        <button className="secondary" onClick={() => navigate("/")}>
          返回集群列表
        </button>
      </div>
    );
  }

  const clusterSlug = getClusterDisplayId(
    clusterDisplayIds,
    cluster.id,
    cluster
  );

  return (
      <ClusterDetailContent
        cluster={cluster}
        clusterSlug={clusterSlug}
        items={items}
        runs={runs}
      selectedIds={selectedIds}
      setSelectedIds={setSelectedIds}
      operator={operator}
      setOperator={setOperator}
      inspectionLoading={inspectionLoading}
      notice={notice}
      noticeType={noticeType}
      error={error}
      clusterNotice={clusterNotice}
      clusterNoticeType={clusterNoticeType}
      clusterNoticeScope={clusterNoticeScope}
      clusterError={clusterError}
      onStartInspection={onStartInspection}
      onDeleteRun={onDeleteRun}
      onDeleteRunsBulk={onDeleteRunsBulk}
      onCancelRun={onCancelRun}
      onEditCluster={onEditCluster}
      onDeleteCluster={onDeleteCluster}
        clusterDisplayIds={clusterDisplayIds}
        runDisplayIds={runDisplayIds}
        onTestClusterConnection={onTestClusterConnection}
        testingClusterIds={testingClusterIds}
        license={license}
      />
  );
};

interface RunDetailProps {
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
}: RunDetailProps) => {
  const { clusterKey, runKey } = useParams<{
    clusterKey?: string;
    runKey?: string;
  }>();
  const navigate = useNavigate();
  const shouldShowNotice =
    notice && noticeType && noticeScope === "runDetail";

  const numericClusterId = useMemo(() => {
    if (!clusterKey) {
      return Number.NaN;
    }
    const decoded = decodeClusterKeyToId(
      clusterKey,
      clusterDisplayIds,
      clusters
    );
    return decoded ?? Number.NaN;
  }, [clusterKey, clusterDisplayIds, clusters]);

  const numericRunId = useMemo(() => {
    if (!runKey) return Number.NaN;
    const direct = Number(runKey);
    if (!Number.isNaN(direct)) {
      return direct;
    }
    const match = Object.entries(runDisplayIds).find(
      ([, display]) => display === runKey
    );
    return match ? Number(match[0]) : Number.NaN;
  }, [runKey, runDisplayIds]);

  const [run, setRun] = useState<InspectionRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cluster = useMemo(() => {
    if (Number.isNaN(numericClusterId)) {
      return null;
    }
    return (
      clusters.find(
        (item) => item.id === (run?.cluster_id ?? numericClusterId)
      ) ?? null
    );
  }, [clusters, run, numericClusterId]);

  const clusterSlug = useMemo(() => {
    if (Number.isNaN(numericClusterId) || !cluster) {
      return null;
    }
    return getClusterDisplayId(clusterDisplayIds, numericClusterId, cluster);
  }, [clusterDisplayIds, cluster, numericClusterId]);
  const clusterPath =
    clusterSlug ?? (clusterKey ? `/clusters/${clusterKey}` : "/");

  const isClusterIdInvalid = Number.isNaN(numericClusterId);
  const isDisplayLookupReady = useMemo(() => {
    if (!runKey) {
      return false;
    }
    if (!Number.isNaN(Number(runKey))) {
      return true;
    }
    if (runs.length === 0) {
      return false;
    }
    return Object.keys(runDisplayIds).length > 0;
  }, [runKey, runs.length, runDisplayIds]);
  const isRunIdInvalid =
    Number.isNaN(numericRunId) && isDisplayLookupReady;

  useEffect(() => {
    if (!isDisplayLookupReady) {
      return;
    }
    if (isRunIdInvalid) {
      setRun(null);
      setLoading(false);
      setError("巡检编号无效");
      logWithTimestamp("error", "巡检编号无效: %s", runKey ?? "");
      return;
    }
    setError(null);
    setLoading(true);
    const runLabel = runDisplayIds[numericRunId] ?? numericRunId;
    logWithTimestamp("info", "开始获取巡检详情: %s", runLabel);
    let cancelled = false;
    getInspectionRun(numericRunId)
      .then((data) => {
        if (cancelled) {
          return;
        }
        setRun(data);
        logWithTimestamp("info", "巡检详情获取成功: %s", runLabel);
      })
      .catch((err) => {
        const message =
          err instanceof Error ? err.message : "获取巡检详情失败";
        logWithTimestamp("error", "获取巡检详情失败: %s", message);
        if (!cancelled) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numericRunId, isRunIdInvalid, isDisplayLookupReady]);


  const resolvedClusterSlug =
    clusterSlug ??
    (cluster ? getClusterDisplayId(clusterDisplayIds, cluster.id, cluster) : "");

  const fallbackRunDisplayId = run
    ? `${normaliseClusterName(run.cluster_name || cluster?.name || "run")}-${String(
        run.id
      ).padStart(2, "0")}`
    : `${normaliseClusterName(cluster?.name || "run")}-${String(
        numericRunId
      ).padStart(2, "0")}`;
  const runDisplayId = runDisplayIds[numericRunId] ?? fallbackRunDisplayId;

  const handleDownloadReport = useCallback(
    (reportFormat: "pdf" | "md" = "pdf") => {
      if (!run?.report_path || !run?.id) {
        return;
      }
      if (!license.canDownloadReports) {
        setError(license.reason ?? "当前 License 不支持下载巡检报告。");
        return;
      }
      const url = getReportDownloadUrl(run.id, reportFormat);
      if (typeof window !== "undefined") {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    },
    [run, license.canDownloadReports, license.reason]
  );

  const itemOrderMap = useMemo(() => {
    const map = new Map<number, number>();
    items.forEach((item, index) => {
      map.set(item.id, index);
    });
    return map;
  }, [items]);

  const orderedResults = useMemo(() => {
    if (!run?.results?.length) {
      return [];
    }
    return run.results
      .slice()
      .sort((a, b) => {
        const orderA =
          a.item_id != null
            ? itemOrderMap.get(a.item_id) ?? Number.MAX_SAFE_INTEGER
            : Number.MAX_SAFE_INTEGER;
        const orderB =
          b.item_id != null
            ? itemOrderMap.get(b.item_id) ?? Number.MAX_SAFE_INTEGER
            : Number.MAX_SAFE_INTEGER;
        if (orderA !== orderB) {
          return orderA - orderB;
        }
        return a.id - b.id;
      });
  }, [run, itemOrderMap]);

  const [resultPageSize, setResultPageSize] = useState<number>(
    RUN_PAGE_SIZE_OPTIONS[0]
  );
  const [resultPage, setResultPage] = useState(1);
  const [resultPageInput, setResultPageInput] = useState("");

  useEffect(() => {
    setResultPage(1);
    setResultPageInput("");
  }, [resultPageSize]);

  useEffect(() => {
    setResultPage(1);
    setResultPageInput("");
    setResultFilterQuery("");
    setResultFilterStatus("all");
  }, [run?.id]);

  const totalResultPages = useMemo(
    () =>
      Math.max(
        1,
        Math.ceil(filteredResults.length / Math.max(resultPageSize, 1))
      ),
    [filteredResults.length, resultPageSize]
  );

  useEffect(() => {
    setResultPage((prev) => Math.min(Math.max(prev, 1), totalResultPages));
  }, [totalResultPages]);

  type InspectionResultStatusFilter = InspectionResultStatus | "all";

  const [resultFilterQuery, setResultFilterQuery] = useState("");
  const [resultFilterStatus, setResultFilterStatus] =
    useState<InspectionResultStatusFilter>("all");

  const filteredResults = useMemo(() => {
    if (orderedResults.length === 0) {
      return [];
    }
    const query = resultFilterQuery.trim().toLowerCase();
    const byStatus =
      resultFilterStatus === "all"
        ? orderedResults
        : orderedResults.filter((item) => item.status === resultFilterStatus);
    if (!query) {
      return byStatus;
    }
    return byStatus.filter((item) => {
      const name = item.item_name?.toLowerCase() ?? "";
      const detail = item.detail?.toLowerCase() ?? "";
      const suggestion = item.suggestion?.toLowerCase() ?? "";
      return (
        name.includes(query) || detail.includes(query) || suggestion.includes(query)
      );
    });
  }, [orderedResults, resultFilterQuery, resultFilterStatus]);

  const paginatedResults = useMemo(() => {
    if (filteredResults.length === 0) {
      return [];
    }
    const start = (resultPage - 1) * resultPageSize;
    return filteredResults.slice(start, start + resultPageSize);
  }, [filteredResults, resultPage, resultPageSize]);

  const handleResultPageChange = useCallback(
    (offset: number) => {
      setResultPage((prev) => {
        const next = prev + offset;
        if (next < 1) {
          return 1;
        }
        if (next > totalResultPages) {
          return totalResultPages;
        }
        return next;
      });
    },
    [totalResultPages]
  );

  const handleResultPageSizeChange = useCallback((value: number) => {
    setResultPageSize(value);
  }, []);

  const handleResultPageJump = useCallback(() => {
    const trimmed = resultPageInput.trim();
    if (!trimmed) {
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isNaN(parsed) && Number.isInteger(parsed)) {
      const target = Math.min(Math.max(parsed, 1), totalResultPages);
      setResultPage(target);
    }
    setResultPageInput("");
  }, [resultPageInput, totalResultPages]);

  const progressInfo = useMemo(
    () => (run ? buildRunProgressInfo(run) : null),
    [run]
  );

  const canCancelRun = useMemo(() => {
    if (!run) {
      return false;
    }
    return run.status === "running" || run.status === "paused";
  }, [run]);

  useEffect(() => {
    if (!run?.id || run.status !== "running") {
      return;
    }
    let cancelled = false;
    let timeoutId: number | null = null;

    const scheduleNext = (delay: number) => {
      if (cancelled) {
        return;
      }
      timeoutId = window.setTimeout(() => {
        timeoutId = null;
        void poll();
      }, delay);
    };

    const poll = async () => {
      try {
        const refreshed = await getInspectionRun(run.id);
        if (cancelled) {
          return;
        }
        setRun((previous) => {
          if (!previous || previous.id !== refreshed.id) {
            return refreshed;
          }
          if (hasRunStateChanged(previous, refreshed)) {
            return refreshed;
          }
          const prevInfo = buildRunProgressInfo(previous);
          const nextInfo = buildRunProgressInfo(refreshed);
          if (!isProgressInfoEqual(prevInfo, nextInfo)) {
            return refreshed;
          }
          return previous;
        });
        setError(null);
        if (refreshed.status === "running") {
          scheduleNext(800);
        }
      } catch (err) {
        if (cancelled) {
          return;
        }
        const message =
          err instanceof Error ? err.message : "获取巡检详情失败";
        logWithTimestamp("error", "获取巡检详情失败: %s", message);
        setError(message);
        scheduleNext(2000);
      }
    };

    scheduleNext(400);

    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.id, run?.status]);

  const handleCancelRunDetail = useCallback(() => {
    if (!run || !(run.status === "running" || run.status === "paused")) {
      return;
    }
    void onCancelRun(run.id, clusterPath);
  }, [run, onCancelRun, clusterPath]);

  if (isClusterIdInvalid) {
    return (
      <div className="detail-empty">
        <p>集群信息加载中...</p>
        <button className="secondary" onClick={() => navigate("/")}>
          返回集群列表
        </button>
      </div>
    );
  }

  if (isRunIdInvalid) {
    return (
      <div className="detail-empty">
        <p>巡检信息加载中...</p>
        <button className="secondary" onClick={() => navigate(clusterPath)}>
          返回上一页
        </button>
      </div>
    );
  }

  if (!cluster) {
    if (clusters.length === 0) {
      return (
        <div className="detail-empty">
          <p>集群信息加载中...</p>
          <button className="secondary" onClick={() => navigate("/")}>
            返回集群列表
          </button>
        </div>
      );
    }
    return (
      <div className="detail-empty">
        <p>未找到集群。</p>
        <button className="secondary" onClick={() => navigate("/")}>
          返回集群列表
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="detail-header">
        <button className="link-button" onClick={() => navigate(clusterPath)}>
          返回上一页
        </button>
        <div className="detail-header-actions">
          {run?.report_path && license.canDownloadReports ? (
            <>
              <button
                type="button"
                className="secondary"
                onClick={() => handleDownloadReport("pdf")}
              >
                下载PDF
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => handleDownloadReport("md")}
              >
                下载Markdown
              </button>
            </>
          ) : null}
          {canCancelRun ? (
            <button
              type="button"
              className="secondary danger"
              onClick={handleCancelRunDetail}
            >
              取消
            </button>
          ) : null}
      </div>
    </div>

    {shouldShowNotice && (
      <div className={`feedback ${noticeType}`}>{notice}</div>
    )}

    {!license.canDownloadReports && (
      <p className="card-caption">
        {license.reason ?? "当前 License 不支持下载巡检报告。"}
      </p>
    )}

    {error && <div className="feedback error">{error}</div>}

      {loading ? (
        <div className="detail-empty">
          <p>巡检详情加载中...</p>
        </div>
      ) : !run ? (
        <div className="detail-empty">
          <p>未找到巡检记录。</p>
          <button className="secondary" onClick={() => navigate(clusterPath)}>
            返回
          </button>
        </div>
      ) : (
        <>
          <section className="detail-grid">
            <div className="detail-card">
              <h2>巡检概览</h2>
              <div className="inspection-summary">
                <div>
                  <strong>巡检编号: </strong>
                  {runDisplayId}
                </div>
                <div>
                  <strong>所属集群: </strong>
                  {`${cluster.name}(${resolvedClusterSlug})`}
                </div>
                <div>
                  <strong>巡检人: </strong>
                  {run.operator || "-"}
                </div>
                <div className="inspection-summary-status">
                  <strong>状态: </strong>
                  {renderRunStatusBadge(
                    run.status,
                    progressInfo?.progress ?? run.progress
                  )}
                </div>
                <div>
                  <strong>进度: </strong>
                  {progressInfo
                    ? progressInfo.total > 0
                      ? `${progressInfo.processed} / ${progressInfo.total}`
                      : "-"
                    : "-"}
                </div>
            <div>
              <strong>开始时间: </strong>
              {formatDate(run.created_at)}
            </div>
                <div>
                  <strong>完成时间: </strong>
                  {formatDate(run.completed_at)}
                </div>
              </div>
            </div>
            {run.summary && (
              <div className="detail-card">
                <h2>巡检总结</h2>
                <div className="inspection-summary">{run.summary}</div>
              </div>
            )}
          </section>

          <section className="card history">
            <div className="card-header">
              <h2>巡检结果</h2>
            </div>
            <div className="inspection-results-toolbar">
              <div />
              <div className="inspection-results-filters">
                <input
                  type="text"
                  placeholder="按名称、详情或建议搜索"
                  value={resultFilterQuery}
                  onChange={(event) => setResultFilterQuery(event.target.value)}
                />
                <select
                  value={resultFilterStatus}
                  onChange={(event) =>
                    setResultFilterStatus(event.target.value as InspectionResultStatusFilter)
                  }
                >
                  <option value="all">全部状态</option>
                  <option value="passed">通过</option>
                  <option value="warning">告警</option>
                  <option value="failed">失败</option>
                </select>
              </div>
            </div>
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>检查项</th>
                    <th>状态</th>
                    <th>详情</th>
                    <th>建议</th>
                  </tr>
                </thead>
                <tbody>
                  {orderedResults.length === 0 ? (
                    <tr>
                      <td colSpan={4}>暂无巡检结果</td>
                    </tr>
                  ) : (
                    paginatedResults.map((result: InspectionResult) => (
                      <tr key={result.id}>
                        <td>{result.item_name}</td>
                        <td>
                          <span className={statusClass(result.status)}>
                            {result.status}
                          </span>
                        </td>
                        <td>{result.detail || "-"}</td>
                        <td>{result.suggestion || "-"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {orderedResults.length > 0 && (
              <div className="table-pagination">
                <label className="page-size-control">
                  每页
                  <select
                    className="page-size-select"
                    value={resultPageSize}
                    onChange={(event) =>
                      handleResultPageSizeChange(Number(event.target.value))
                    }
                  >
                    {RUN_PAGE_SIZE_OPTIONS.map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="page-indicator">
                  第 {resultPage} / {totalResultPages} 页
                </span>
                <button
                  type="button"
                  className="pagination-nav"
                  onClick={() => handleResultPageChange(-1)}
                  disabled={resultPage <= 1}
                >
                  上一页
                </button>
                <button
                  type="button"
                  className="pagination-nav"
                  onClick={() => handleResultPageChange(1)}
                  disabled={resultPage >= totalResultPages}
                >
                  下一页
                </button>
                <div className="page-jump">
                  <input
                    type="number"
                    min={1}
                    max={totalResultPages}
                    value={resultPageInput}
                    onChange={(event) => setResultPageInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        handleResultPageJump();
                      }
                    }}
                    className="page-jump-input"
                    placeholder="页码"
                  />
                  <button
                    type="button"
                    className="secondary"
                    onClick={handleResultPageJump}
                    disabled={orderedResults.length === 0}
                  >
                    跳转
                  </button>
                </div>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
};

interface ConfirmationModalProps {
  state: ConfirmDialogState | null;
  onClose: () => void;
  nested?: boolean;
}

const ConfirmationModal = ({
  state,
  onClose,
  nested = false,
}: ConfirmationModalProps) => {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [optionValues, setOptionValues] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!state?.options?.length) {
      setOptionValues({});
      return;
    }
    const defaults: Record<string, boolean> = {};
    for (const option of state.options) {
      defaults[option.id] = option.defaultChecked ?? false;
    }
    setOptionValues(defaults);
  }, [state]);

  if (!state) {
    return null;
  }

  const confirmLabel = state.confirmLabel ?? "确定";
  const cancelLabel = state.cancelLabel ?? "取消";
  const variantClass =
    state.variant === "danger" ? "primary danger" : "primary";

  const handleConfirm = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const payload = state.options?.length ? optionValues : undefined;
      await state.onConfirm(payload);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const backdropClassName = nested
    ? "modal-backdrop nested settings-confirm-backdrop"
    : "modal-backdrop";

  return (
    <div className={backdropClassName} role="dialog" aria-modal="true">
      <div className="modal">
        <h3>{state.title}</h3>
        <p>{state.message}</p>
        {state.options?.length ? (
          <div className="confirmation-options">
            {state.options.map((option) => {
              const checked = optionValues[option.id] ?? false;
              return (
                <label key={option.id} className="confirmation-option">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => {
                      const { checked: nextChecked } = event.currentTarget;
                      setOptionValues((prev) => ({
                        ...prev,
                        [option.id]: nextChecked,
                      }));
                    }}
                  />
                  <div className="confirmation-option-text">
                    <span className="confirmation-option-label">
                      {option.label}
                    </span>
                    {option.description && (
                      <span className="confirmation-option-description">
                        {option.description}
                      </span>
                    )}
                  </div>
                </label>
              );
            })}
          </div>
        ) : null}
        {error && <div className="feedback error">{error}</div>}
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
            className={variantClass}
            onClick={handleConfirm}
            disabled={submitting}
          >
            {submitting ? "处理中..." : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};


interface SettingsModalTab {
  id: string;
  label: string;
  render: (context: {
    close: () => void;
    selectTab: (tabId: string) => void;
    activeTabId: string;
  }) => ReactNode;
}

interface SettingsModalProps {
  open: boolean;
  tabs: SettingsModalTab[];
  initialTabId?: string;
  onClose: () => void;
  confirmState: ConfirmDialogState | null;
  onConfirmClose: () => void;
  activeTabId: string;
  onTabChange: (tabId: string) => void;
}

const SettingsModal = ({
  open,
  tabs,
  initialTabId,
  onClose,
  confirmState,
  onConfirmClose,
  activeTabId,
  onTabChange,
}: SettingsModalProps) => {
  const fallbackTabId = tabs[0]?.id ?? "";
  const resolvedActiveTab =
    tabs.find((tab) => tab.id === activeTabId)?.id ??
    (initialTabId && tabs.some((tab) => tab.id === initialTabId)
      ? initialTabId
      : fallbackTabId);

  useEffect(() => {
    if (!open || tabs.length === 0 || !resolvedActiveTab) {
      return;
    }
    if (resolvedActiveTab !== activeTabId) {
      onTabChange(resolvedActiveTab);
    }
  }, [open, tabs.length, resolvedActiveTab, activeTabId, onTabChange]);

  if (!open || tabs.length === 0) {
    return null;
  }

  const activeTabConfig =
    tabs.find((tab) => tab.id === resolvedActiveTab) ?? tabs[0];

  const handleTabChange = (tabId: string) => {
    onTabChange(tabId);
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal large settings-modal">
        <div className="settings-modal-header">
          <h3>系统设置</h3>
          <button
            type="button"
            className="link-button small"
            onClick={onClose}
            aria-label="关闭设置"
          >
            关闭
          </button>
        </div>
        <div className="settings-modal-shell">
          <nav className="settings-modal-nav" aria-label="设置类别">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`settings-nav-button${
                  tab.id === activeTabConfig.id ? " active" : ""
                }`}
                onClick={() => handleTabChange(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </nav>
          <section className="settings-modal-main">
            {activeTabConfig.render({
              close: onClose,
              selectTab: handleTabChange,
              activeTabId: activeTabConfig.id,
            })}
          </section>
        </div>
        <ConfirmationModal
          state={confirmState}
          onClose={onConfirmClose}
          nested
        />
      </div>
    </div>
  );
};

const SettingsOverviewPanel = ({
  onOpenInspection,
  onOpenLicense,
  license,
}: {
  onOpenInspection: () => void;
  onOpenLicense: () => void;
  license: LicenseCapabilities;
}) => {
  const featureLabelMap: Record<string, string> = {
    clusters: "集群管理",
    inspections: "巡检执行",
    reports: "报告下载",
  };
  const featureSummary =
    license.features.length > 0
      ? license.features
          .map((feature) => featureLabelMap[feature] ?? feature)
          .join("、")
      : "暂无功能";

  return (
    <div className="settings-overview">
      <h4>快速开始</h4>
      <p>
        根据业务需求组合不同的巡检策略。请选择左侧的类别进入对应的配置页。
      </p>
      <div className="settings-overview-actions">
        <button type="button" className="primary" onClick={onOpenInspection}>
          管理巡检项
        </button>
        <button type="button" className="secondary" onClick={onOpenLicense}>
          License 管理
        </button>
      </div>
      <div className="settings-overview-license">
        <h5>当前 License 状态</h5>
        <p>
          状态：
          <strong>
            {license.loading
              ? "加载中..."
              : license.valid
              ? "已激活"
              : "未激活"}
          </strong>
        </p>
        {!license.valid && !license.loading && license.reason && (
          <p>{license.reason}</p>
        )}
        {license.status?.expires_at && (
          <p>到期时间：{formatDate(license.status.expires_at)}</p>
        )}
        <p>功能权限：{featureSummary}</p>
      </div>
      <p className="settings-overview-hint">
        更多设置选项（通知策略、巡检计划等）即将开放，敬请期待。
      </p>
    </div>
  );
};

interface LicenseSettingsPanelProps {
  status: LicenseCapabilities;
  uploading: boolean;
  textUploading: boolean;
  onUpload: (file: File) => Promise<unknown>;
  onUploadText: (content: string) => Promise<unknown>;
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [licenseText, setLicenseText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const featureLabelMap: Record<string, string> = {
    clusters: "集群管理",
    inspections: "巡检执行",
    reports: "报告下载",
  };

  const featureText =
    status.features.length > 0
      ? status.features
          .map((feature) => featureLabelMap[feature] ?? feature)
          .join("、")
      : "暂无功能";

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    setSelectedFile(file);
    setNotice(null);
    setError(null);
  };

  const handleUploadClick = async () => {
    const file = selectedFile;
    const trimmed = licenseText.trim();
    if (!file && !trimmed) {
      setError("请先选择文件或粘贴 License 内容");
      return;
    }
    setError(null);
    setNotice(null);
    try {
      if (file) {
        await onUpload(file);
        setSelectedFile(null);
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
      }
      if (trimmed) {
        await onUploadText(trimmed);
        setLicenseText("");
      }
      await onRefresh();
      if (file && trimmed) {
        setNotice("License 文件与文本已全部导入");
      } else if (file) {
        setNotice("License 上传成功");
      } else {
        setNotice("License 文本导入成功");
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "导入 License 失败";
      setError(message);
    }
  };

  const handleRefreshClick = async () => {
    setRefreshing(true);
    setError(null);
    setNotice(null);
    try {
      const refreshed = await onRefresh();
      if (refreshed?.valid) {
        setNotice("License 状态已刷新。");
      } else if (refreshed?.reason) {
        setError(refreshed.reason);
      } else if (status.reason) {
        setError(status.reason);
      } else {
        setNotice("License 状态已刷新。");
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "刷新 License 状态失败";
      setError(message);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (!notice && !error) {
      return;
    }
    const timer = window.setTimeout(() => {
      setNotice(null);
      setError(null);
    }, 5000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [notice, error]);

  return (
    <div className="settings-license-panel">
      <h4>License 信息</h4>
      <div className="license-status-card">
        <p>
          <strong>授权状态：</strong>
          {status.loading
            ? "加载中..."
            : status.valid
            ? "已激活"
            : "未激活"}
        </p>
        {status.status?.licensee && (
          <p>
            <strong>公司：</strong>
            {status.status.licensee}
          </p>
        )}
        {status.status?.product && (
          <p>
            <strong>产品：</strong>
            {status.status.product}
          </p>
        )}
        {status.status?.issued_at && (
          <p>
            <strong>签发时间：</strong>
            {formatDate(status.status.issued_at)}
          </p>
        )}
        {status.status?.expires_at && (
          <p>
            <strong>到期时间：</strong>
            {formatDate(status.status.expires_at)}
          </p>
        )}
        <p>
          <strong>功能权限：</strong>
          {featureText}
        </p>
        {!status.valid && status.reason && (
          <p>
            <strong>原因：</strong>
            {status.reason}
          </p>
        )}
      </div>
      <div className="license-upload-section">
        <p className="card-caption">
          支持上传License文件或直接粘贴License内容。
        </p>
        <label className="license-upload-label">
          选择 License 文件
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,.lic,.license"
            onChange={handleFileChange}
          />
        </label>
        {selectedFile && (
          <p className="license-file-name">已选择：{selectedFile.name}</p>
        )}
        <label className="license-upload-label" htmlFor="license-text-content">
          或粘贴 License 内容
        </label>
        <textarea
          id="license-text-content"
          className="license-textarea"
          value={licenseText}
          onChange={(event) => {
            setLicenseText(event.target.value);
            setError(null);
            setNotice(null);
          }}
          placeholder="在此粘贴 License 内容，例如 ENC-LICENSE-V1:..."
          rows={5}
        />
        <div className="license-actions">
          <button
            type="button"
            className="primary"
            onClick={handleUploadClick}
            disabled={uploading || textUploading}
          >
            {uploading || textUploading ? "导入中..." : "导入 License"}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={handleRefreshClick}
            disabled={refreshing || status.loading}
          >
            {refreshing ? "刷新中..." : "刷新状态"}
          </button>
        </div>
      </div>
      {notice && <div className="feedback success">{notice}</div>}
      {error && <div className="feedback error">{error}</div>}
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
  onDeleteMany: (itemIds: number[]) => void;
  onExport: () => Promise<void>;
  onImport: (file: File) => Promise<void>;
}

type InspectionCheckType = "command" | "promql";

const comparisonOptions = [
  { label: "大于", value: ">" },
  { label: "小于", value: "<" },
  { label: "等于", value: "==" },
  { label: "大于等于", value: ">=" },
  { label: "小于等于", value: "<=" },
  { label: "不等于", value: "!=" },
];

const defaultInspectionForm = {
  id: undefined as number | undefined,
  name: "",
  description: "",
  checkType: "command" as InspectionCheckType,
  command: "",
  expression: "",
  comparison: ">=",
  threshold: "",
  suggestion: "",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parseCommandString = (raw: unknown): string => {
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item)).join(" ");
  }
  if (typeof raw === "string") {
    return raw;
  }
  return "";
};

const extractThreshold = (raw: unknown): string => {
  if (raw === null || raw === undefined) {
    return "";
  }
  const value = Number(raw);
  return Number.isNaN(value) ? "" : String(value);
};

const deriveFormFromItem = (item: InspectionItem) => {
  const base = { ...defaultInspectionForm, id: item.id, name: item.name, description: item.description ?? "" };
  const config = isRecord(item.config) ? item.config : {};
  if (item.check_type === "promql") {
    return {
      ...base,
      checkType: "promql" as InspectionCheckType,
      expression: typeof config.expression === "string" ? config.expression : "",
      comparison: typeof config.comparison === "string" ? config.comparison : ">=",
      threshold: extractThreshold(config.fail_threshold ?? config.warn_threshold ?? config.threshold),
      suggestion: typeof config.suggestion_on_fail === "string" ? config.suggestion_on_fail : "",
    };
  }

  return {
    ...base,
    checkType: "command" as InspectionCheckType,
    command: parseCommandString(config.command),
    suggestion: typeof config.suggestion_on_fail === "string" ? config.suggestion_on_fail : "",
  };
};

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
  const [formState, setFormState] = useState(defaultInspectionForm);
  const [formError, setFormError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedItemIds, setSelectedItemIds] = useState<number[]>([]);

  useEffect(() => {
    setSelectedItemIds((prev) =>
      prev.filter((id) => items.some((item) => item.id === id))
    );
  }, [items]);

  const allItemsSelected =
    items.length > 0 && selectedItemIds.length === items.length;

  const handleToggleItemSelection = (itemId: number) => {
    setSelectedItemIds((prev) =>
      prev.includes(itemId)
        ? prev.filter((id) => id !== itemId)
        : [...prev, itemId]
    );
  };

  const handleToggleAllItems = () => {
    setSelectedItemIds((prev) => {
      if (items.length === 0) {
        return [];
      }
      if (prev.length === items.length) {
        return [];
      }
      return items.map((item) => item.id);
    });
  };

  const handleDeleteSelectedItems = () => {
    if (selectedItemIds.length === 0) {
      return;
    }
    onDeleteMany(selectedItemIds);
  };

  const handleResetForm = () => {
    setFormState(defaultInspectionForm);
    setFormError(null);
  };

  const handleEdit = (item: InspectionItem) => {
    setFormState(deriveFormFromItem(item));
    setFormError(null);
  };

  const handleTypeChange = (value: InspectionCheckType) => {
    setFormState((prev) => ({
      ...prev,
      checkType: value,
      command: value === "command" ? prev.command : "",
      expression: value === "promql" ? prev.expression : "",
    }));
  };

  const handleExportClick = async () => {
    setFormError(null);
    try {
      await onExport();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "导出巡检项失败";
      setFormError(message);
    }
  };

  const handleTriggerImport = () => {
    if (submitting) {
      return;
    }
    setFormError(null);
    fileInputRef.current?.click();
  };

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!file || submitting) {
      return;
    }
    setFormError(null);
    try {
      await onImport(file);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "导入巡检项失败";
      setFormError(message);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);

    const { id, name, description, checkType, command, expression, threshold, comparison, suggestion } =
      formState;

    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError("巡检名称不能为空");
      return;
    }

    let config: Record<string, unknown> = {};

    if (checkType === "command") {
      const commandText = command.trim();
      if (!commandText) {
        setFormError("请输入要执行的命令");
        return;
      }
      config = {
        command: commandText,
        shell: true,
        timeout: 30,
        success_message: "Command executed successfully.",
        failure_message: "Command returned non-zero exit code.",
        suggestion_on_fail: suggestion.trim() || "",
        suggestion_on_success: "",
      };
    } else {
      const expr = expression.trim();
      if (!expr) {
        setFormError("请输入 Prometheus 表达式");
        return;
      }
      const numericThreshold = Number(threshold);
      if (!threshold || Number.isNaN(numericThreshold)) {
        setFormError("请提供有效的告警阈值");
        return;
      }
      config = {
        expression: expr,
        comparison,
        fail_threshold: numericThreshold,
        detail_template: "{expression} value: {value}",
        suggestion_on_fail: suggestion.trim() || "",
        empty_message: "Prometheus returned no samples.",
        suggestion_if_empty: suggestion.trim() || "",
      };
    }

    try {
      await onSave({
        id,
        name: trimmedName,
        description: description?.trim() || undefined,
        check_type: checkType,
        config,
      });
      setFormState((prev) => ({
        ...defaultInspectionForm,
        checkType: prev.checkType,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setFormError(message);
    }
  };

  const activeItems = useMemo(() => items.slice(), [items]);

  return (
    <div className="inspection-settings-panel">
      <div className="settings-header">
        <h3>巡检项设置</h3>
        <div className="settings-actions">
          {items.length > 0 && (
            <div className="selection-actions">
              <span className="selection-hint">
                已选 {selectedItemIds.length} / {items.length}
              </span>
              <button
                type="button"
                className="link-button"
                onClick={handleToggleAllItems}
                disabled={submitting}
              >
                {allItemsSelected ? "取消全选" : "全选"}
              </button>
              <button
                type="button"
                className="link-button danger"
                onClick={handleDeleteSelectedItems}
                disabled={selectedItemIds.length === 0 || submitting}
              >
                删除
              </button>
            </div>
          )}
          <button
            type="button"
            className="link-button"
            onClick={handleExportClick}
            disabled={submitting}
          >
            导出 JSON
          </button>
          <button
            type="button"
            className="link-button"
            onClick={handleTriggerImport}
            disabled={submitting}
          >
            导入 JSON
          </button>
          <button
            type="button"
            className="link-button"
            onClick={() => handleResetForm()}
            disabled={submitting}
          >
            新建巡检项
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json"
            onChange={handleFileChange}
            style={{ display: "none" }}
          />
        </div>
      </div>
        {notice && <div className="feedback success">{notice}</div>}
        {(error || formError) && (
          <div className="feedback error">{formError ?? error}</div>
        )}
        <div className="settings-content">
          <div className="settings-list">
            <table>
              <thead>
                <tr>
                  <th className="selection-cell">
                    <input
                      type="checkbox"
                      checked={allItemsSelected}
                      onChange={handleToggleAllItems}
                      disabled={submitting}
                    />
                  </th>
                  <th>序号</th>
                  <th>名称</th>
                  <th>类型</th>
                  <th>描述</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {activeItems.length === 0 ? (
                  <tr>
                    <td colSpan={6}>暂无巡检项</td>
                  </tr>
                ) : (
                  activeItems.map((item, index) => (
                    <tr
                      key={item.id}
                      className={
                        selectedItemIds.includes(item.id)
                          ? "selected-row"
                          : undefined
                      }
                    >
                      <td className="selection-cell">
                        <input
                          type="checkbox"
                          checked={selectedItemIds.includes(item.id)}
                          onChange={() => handleToggleItemSelection(item.id)}
                          disabled={submitting}
                        />
                      </td>
                      <td>{index + 1}</td>
                      <td>{item.name}</td>
                      <td>{item.check_type}</td>
                      <td>{item.description || "-"}</td>
                      <td>
                        <div className="table-actions">
                          <button
                            className="link-button small"
                            onClick={() => handleEdit(item)}
                          >
                            编辑
                          </button>
                          <button
                            className="link-button small danger"
                            onClick={() => {
                              setFormError(null);
                              onDelete(item);
                            }}
                            disabled={submitting}
                          >
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <form className="settings-form" onSubmit={handleSubmit}>
            <h4>{formState.id ? "编辑巡检项" : "新建巡检项"}</h4>
            <label>
              巡检名称
              <input
                type="text"
                value={formState.name}
                onChange={(event) =>
                  setFormState((prev) => ({
                    ...prev,
                    name: event.target.value,
                  }))
                }
                required
                disabled={submitting}
              />
            </label>
            <label>
              描述
              <textarea
                value={formState.description}
                onChange={(event) =>
                  setFormState((prev) => ({
                    ...prev,
                    description: event.target.value,
                  }))
                }
                rows={2}
                disabled={submitting}
              />
            </label>
            <label>
              巡检类型
              <select
                value={formState.checkType}
                onChange={(event) =>
                  handleTypeChange(event.target.value as InspectionCheckType)
                }
                disabled={submitting}
              >
                <option value="command">命令行</option>
                <option value="promql">PromQL 表达式</option>
              </select>
            </label>

            {formState.checkType === "command" ? (
              <label>
                命令（可使用 {"{{kubeconfig}}"} 占位符）
                <textarea
                  value={formState.command}
                  onChange={(event) =>
                    setFormState((prev) => ({
                      ...prev,
                      command: event.target.value,
                    }))
                  }
                  rows={4}
                  placeholder="例如：kubectl --kubeconfig {{kubeconfig}} cluster-info"
                  disabled={submitting}
                />
              </label>
            ) : (
              <>
                <label>
                  Prometheus 表达式
                  <textarea
                    value={formState.expression}
                    onChange={(event) =>
                      setFormState((prev) => ({
                        ...prev,
                        expression: event.target.value,
                      }))
                    }
                    rows={3}
                    placeholder="例如：max(up{job='apiserver'})"
                    disabled={submitting}
                  />
                </label>
                <div className="field-row">
                  <label>
                    告警阈值
                    <input
                      type="number"
                      value={formState.threshold}
                      onChange={(event) =>
                        setFormState((prev) => ({
                          ...prev,
                          threshold: event.target.value,
                        }))
                      }
                      placeholder="数值"
                      disabled={submitting}
                    />
                  </label>
                  <label>
                    比较方式
                    <select
                      value={formState.comparison}
                      onChange={(event) =>
                        setFormState((prev) => ({
                          ...prev,
                          comparison: event.target.value,
                        }))
                      }
                      disabled={submitting}
                    >
                      {comparisonOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </>
            )}

            <label>
              处理建议
              <textarea
                value={formState.suggestion}
                onChange={(event) =>
                  setFormState((prev) => ({
                    ...prev,
                    suggestion: event.target.value,
                  }))
                }
                rows={3}
                placeholder="建议描述（可选）"
                disabled={submitting}
              />
            </label>

            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                onClick={handleResetForm}
                disabled={submitting}
              >
                清空
              </button>
              <button type="submit" className="primary" disabled={submitting}>
                {submitting ? "保存中..." : formState.id ? "更新" : "保存"}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={onClose}
                disabled={submitting}
              >
                关闭
              </button>
            </div>
          </form>
        </div>
    </div>
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

  const hasRunningRuns = useMemo(
    () =>
      runs.some(
        (run) =>
          run.status === "running" ||
          run.status === "paused" ||
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
            run.status === "paused" ||
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
    kubeconfigEdited,
    kubeconfigFile,
    kubeconfigFileName,
    kubeconfigText,
    refreshClusters,
    refreshRuns,
    clearClusterNotice,
    currentNoticeScope,
    showClusterNotice,
    licenseCapabilities,
  ]);

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
