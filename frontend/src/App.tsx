import {
  ChangeEvent,
  FormEvent,
  type RefObject,
  type CSSProperties,
  useCallback,
  useEffect,
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
} from "./api";
import { appConfig } from "./config";
import {
  ClusterConfig,
  InspectionItem,
  InspectionResult,
  InspectionRun,
  InspectionRunListItem,
} from "./types";

type NoticeType = "success" | "warning" | "error" | null;
type ConfirmVariant = "primary" | "danger";

interface ConfirmDialogState {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: ConfirmVariant;
  onConfirm: () => Promise<void> | void;
}

const CLUSTER_ID_STORAGE_KEY = "clusterDisplayIdMap.v1";
const CLUSTER_PAGE_SIZE = 10;

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
    case "passed":
      return "status-pill success";
    case "warning":
      return "status-pill warning";
    case "failed":
      return "status-pill danger";
    default:
      return "status-pill";
  }
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

const generateClusterDisplayId = () =>
  `C-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

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
  clusterId: number
) => map[clusterId] ?? `cluster-${clusterId}`;

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
    let displayId = current[cluster.id];
    if (!displayId) {
      do {
        displayId = generateClusterDisplayId();
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

const TopNavigation = () => {
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
      </nav>
    </header>
  );
};

interface OverviewProps {
  clusters: ClusterConfig[];
  clusterError: string | null;
  clusterNotice: string | null;
  clusterNoticeType: NoticeType;
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
  clusterDisplayIds: Record<number, string>;
}

const OverviewView = ({
  clusters,
  clusterError,
  clusterNotice,
  clusterNoticeType,
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
  clusterDisplayIds,
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
            <label>上传 kubeconfig</label>
            <input
              type="text"
              placeholder="自定义集群名称(可选)"
              value={clusterNameInput}
              onChange={(event) => setClusterNameInput(event.target.value)}
            />
            <input
              type="text"
              placeholder="Prometheus 地址(可选)"
              value={clusterPromInput}
              onChange={(event) => setClusterPromInput(event.target.value)}
            />
            <button
              type="button"
              className={`cluster-upload-trigger${
                kubeconfigReady ? " ready" : ""
              }`}
              onClick={openKubeconfigModal}
            >
              {kubeconfigReady ? "查看 / 更新 kubeconfig" : "导入 kubeconfig"}
            </button>
            <div className="cluster-upload-hint">
              {kubeconfigSummary ?? "支持上传文件或粘贴 YAML 内容"}
            </div>
            <button
              className="secondary"
              onClick={() => void onUpload()}
              disabled={clusterUploading}
            >
              {clusterUploading ? "上传中..." : "上传集群"}
            </button>
          </div>
        </div>
      </header>

      <section className="card cluster-panel">
        <div className="card-header">
          <h2>集群列表</h2>
        </div>
        {clusterError && <div className="feedback error">{clusterError}</div>}
        {clusterNotice && clusterNoticeType && (
          <div className={`feedback ${clusterNoticeType}`}>{clusterNotice}</div>
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
                  cluster.id
                );
                return (
                  <button
                    key={cluster.id}
                    className="cluster-card"
                    onClick={() => navigate(`/clusters/${displayId}`)}
                  >
                    <div className="cluster-card-top">
                      <div className="cluster-name-row">
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
                      <span className={`status-chip ${statusMeta.className}`}>
                        {statusMeta.label}
                      </span>
                      <span
                        className="cluster-status-message"
                        title={cluster.connection_message || "未校验"}
                      >
                        {cluster.connection_message || "未校验"}
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
                  </button>
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
  onClose,
  onFileSelected,
  onTextChange,
  onClear,
}: KubeconfigModalProps) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileInputId = "kubeconfig-file-input";

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
          <h3>导入 kubeconfig</h3>
          <p>上传文件或粘贴 YAML 内容，提交集群时将一并上传。</p>
        </div>
        <div className="kubeconfig-modal-upload">
          <label htmlFor={fileInputId} className="kubeconfig-file-trigger">
            上传文件
          </label>
          <input
            id={fileInputId}
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
            完成
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
  clusterDisplayIds: Record<number, string>;
  runDisplayIds: Record<number, string>;
}

const HistoryView = ({
  runs,
  onRefreshRuns,
  onDeleteRun,
  clusterDisplayIds,
  runDisplayIds,
}: HistoryViewProps) => {
  const navigate = useNavigate();

  return (
    <section className="card history history-page">
      <div className="card-header">
        <h2>历史巡检</h2>
        <button className="secondary" onClick={() => void onRefreshRuns()}>
          刷新
        </button>
      </div>
      {runs.length === 0 ? (
        <div className="placeholder">暂无巡检记录，请稍后再查看。</div>
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
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
              {runs.map((run) => {
                const clusterSlug = getClusterDisplayId(
                  clusterDisplayIds,
                  run.cluster_id
                );
                const runSlug = runDisplayIds[run.id] ?? String(run.id);
                return (
                  <tr key={run.id}>
                    <td>{runSlug}</td>
                    <td>
                      {run.cluster_name}({clusterSlug})
                    </td>
                    <td>{run.operator || "-"}</td>
                    <td>
                      <span className={statusClass(run.status)}>
                        {run.status}
                      </span>
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
                      {run.report_path && (
                        <a
                          className="link-button"
                          href={getReportDownloadUrl(run.id)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          下载报告
                        </a>
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
  error: string | null;
  clusterNotice: string | null;
  clusterNoticeType: NoticeType;
  clusterError: string | null;
  onStartInspection: (clusterId: number) => Promise<void>;
  onDeleteRun: (run: InspectionRunListItem) => Promise<void>;
  onEditCluster: (cluster: ClusterConfig) => void;
  onDeleteCluster: (cluster: ClusterConfig) => Promise<void>;
  clusterDisplayIds: Record<number, string>;
  runDisplayIds: Record<number, string>;
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
  clusterError,
  onStartInspection,
  onDeleteRun,
  onEditCluster,
  onDeleteCluster,
  clusterDisplayIds,
  runDisplayIds,
}: ClusterDetailProps) => {
  const { clusterKey } = useParams<{ clusterKey?: string }>();
  const navigate = useNavigate();

  const numericId = useMemo(() => {
    if (!clusterKey) return Number.NaN;
    const direct = Number(clusterKey);
    if (!Number.isNaN(direct) && clusters.some((item) => item.id === direct)) {
      return direct;
    }
    const match = Object.entries(clusterDisplayIds).find(
      ([, display]) => display === clusterKey
    );
    return match ? Number(match[0]) : Number.NaN;
  }, [clusterKey, clusters, clusterDisplayIds]);

  useEffect(() => {
    setSelectedIds(() => []);
  }, [numericId, setSelectedIds]);

  if (Number.isNaN(numericId)) {
    if (clusters.length === 0 && Object.keys(clusterDisplayIds).length === 0) {
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
        <p>集群编号无效。</p>
        <button className="secondary" onClick={() => navigate("/")}>
          返回集群列表
        </button>
      </div>
    );
  }

  const cluster = clusters.find((item) => item.id === numericId);
  if (!cluster) {
    return (
      <div className="detail-empty">
        <p>未找到集群。</p>
        <button className="secondary" onClick={() => navigate("/")}>
          返回集群列表
        </button>
      </div>
    );
  }

  const clusterSlug = getClusterDisplayId(clusterDisplayIds, cluster.id);
  const statusMeta = getClusterStatusMeta(cluster.connection_status);
  const clusterRuns = useMemo(
    () => runs.filter((run) => run.cluster_id === cluster.id),
    [runs, cluster.id]
  );

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

  return (
    <>
      <div className="detail-header">
        <button className="link-button" onClick={() => navigate("/")}>
          返回上一页
        </button>
        <div className="detail-header-actions">
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
      {clusterNotice && clusterNoticeType && (
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
              {clusterSlug}
            </div>
            <div>
              <strong>连接状态: </strong>
              <span className={`status-chip ${statusMeta.className}`}>
                {statusMeta.label}
              </span>
            </div>
            <div>
              <strong>连接说明: </strong>
              {cluster.connection_message || "尚未校验连接"}
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
            {items.map((item) => (
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
          <div className="detail-actions">
            <button className="secondary" onClick={handleToggleAll}>
              {selectedIds.length === items.length ? "清除选择" : "全选"}
            </button>
            <button
              className="primary"
              onClick={() => onStartInspection(cluster.id)}
              disabled={inspectionLoading}
            >
              {inspectionLoading ? "巡检中..." : "开始巡检"}
            </button>
          </div>
        </div>
      </section>

      <section className="card history">
        <div className="card-header">
          <h2>{cluster.name} · 巡检记录</h2>
        </div>
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>巡检编号</th>
                <th>巡检人</th>
                <th>状态</th>
                <th>开始时间</th>
                <th>结束时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {clusterRuns.map((run) => {
                const runSlug = runDisplayIds[run.id] ?? String(run.id);
                return (
                  <tr key={run.id}>
                    <td>{runSlug}</td>
                    <td>{run.operator || "-"}</td>
                    <td>
                      <span className={statusClass(run.status)}>
                        {run.status}
                      </span>
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
                      {run.report_path && (
                        <a
                          className="link-button"
                          href={getReportDownloadUrl(run.id)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          下载报告
                        </a>
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
      </section>
    </>
  );
};

interface RunDetailProps {
  clusters: ClusterConfig[];
  onDeleteRun: (runId: number, redirectPath?: string) => Promise<void>;
  clusterDisplayIds: Record<number, string>;
  runDisplayIds: Record<number, string>;
}

const RunDetailView = ({
  clusters,
  onDeleteRun,
  clusterDisplayIds,
  runDisplayIds,
}: RunDetailProps) => {
  const { clusterKey, runKey } = useParams<{
    clusterKey?: string;
    runKey?: string;
  }>();
  const navigate = useNavigate();

  const numericClusterId = useMemo(() => {
    if (!clusterKey) return Number.NaN;
    const direct = Number(clusterKey);
    if (!Number.isNaN(direct) && clusters.some((item) => item.id === direct)) {
      return direct;
    }
    const match = Object.entries(clusterDisplayIds).find(
      ([, display]) => display === clusterKey
    );
    return match ? Number(match[0]) : Number.NaN;
  }, [clusterKey, clusters, clusterDisplayIds]);

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

  const cluster = useMemo(
    () =>
      clusters.find(
        (item) => item.id === (run?.cluster_id ?? numericClusterId)
      ),
    [clusters, run, numericClusterId]
  );

  const clusterPath = cluster
    ? `/clusters/${getClusterDisplayId(clusterDisplayIds, cluster.id)}`
    : "/";

  if (Number.isNaN(numericClusterId)) {
    if (clusters.length === 0 && Object.keys(clusterDisplayIds).length === 0) {
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
        <p>集群编号无效。</p>
        <button className="secondary" onClick={() => navigate("/")}>
          返回集群列表
        </button>
      </div>
    );
  }

  if (Number.isNaN(numericRunId)) {
    if (Object.keys(runDisplayIds).length === 0) {
      return (
        <div className="detail-empty">
          <p>巡检信息加载中...</p>
          <button className="secondary" onClick={() => navigate(clusterPath)}>
            返回上一页
          </button>
        </div>
      );
    }
    return (
      <div className="detail-empty">
        <p>巡检编号无效。</p>
        <button className="secondary" onClick={() => navigate(clusterPath)}>
          返回上一页
        </button>
      </div>
    );
  }

  useEffect(() => {
    if (Number.isNaN(numericRunId)) {
      setError("巡检编号无效");
      logWithTimestamp("error", "巡检编号无效: %s", runKey);
      return;
    }
    setLoading(true);
    setError(null);
    logWithTimestamp(
      "info",
      "开始获取巡检详情: %s",
      runDisplayIds[numericRunId] ?? numericRunId
    );
    getInspectionRun(numericRunId)
      .then((data) => {
        setRun(data);
        logWithTimestamp(
          "info",
          "巡检详情获取成功: %s",
          runDisplayIds[numericRunId] ?? numericRunId
        );
      })
      .catch((err) => {
        const message =
          err instanceof Error ? err.message : "获取巡检详情失败";
        logWithTimestamp("error", "获取巡检详情失败: %s", message);
        setError(message);
      })
      .finally(() => setLoading(false));
  }, [numericRunId, runDisplayIds, runKey]);

  const fallbackRunDisplayId = run
    ? `${normaliseClusterName(run.cluster_name || cluster?.name || "run")}-${String(
        run.id
      ).padStart(2, "0")}`
    : `${normaliseClusterName(cluster?.name || "run")}-${String(
        numericRunId
      ).padStart(2, "0")}`;
  const runDisplayId = runDisplayIds[numericRunId] ?? fallbackRunDisplayId;

  const handleDownloadReport = useCallback(() => {
    if (!run?.report_path || !run?.id) {
      return;
    }
    const url = getReportDownloadUrl(run.id);
    if (typeof window !== "undefined") {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }, [run]);

  return (
    <>
      <div className="detail-header">
        <button className="link-button" onClick={() => navigate(clusterPath)}>
          返回上一页
        </button>
        <div className="detail-header-actions">
          {run?.report_path ? (
            <button
              type="button"
              className="secondary"
              onClick={handleDownloadReport}
            >
              下载报告
            </button>
          ) : null}
        </div>
      </div>

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
                  {cluster
                    ? `${cluster.name}(${getClusterDisplayId(
                        clusterDisplayIds,
                        cluster.id
                      )})`
                    : "-"}
                </div>
                <div>
                  <strong>巡检人: </strong>
                  {run.operator || "-"}
                </div>
                <div>
                  <strong>状态: </strong>
                  <span className={statusClass(run.status)}>
                    {run.status}
                  </span>
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
                  {run.results.length === 0 ? (
                    <tr>
                      <td colSpan={4}>暂无巡检结果</td>
                    </tr>
                  ) : (
                    run.results.map((result: InspectionResult) => (
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
          </section>
        </>
      )}
    </>
  );
};

interface ConfirmationModalProps {
  state: ConfirmDialogState | null;
  onClose: () => void;
}

const ConfirmationModal = ({ state, onClose }: ConfirmationModalProps) => {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      await state.onConfirm();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <h3>{state.title}</h3>
        <p>{state.message}</p>
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
  const [file, setFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setName(cluster.name);
    setPrometheusUrl(cluster.prometheus_url ?? "");
    setFile(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, [cluster]);

  const nameInputId = `cluster-edit-name-${cluster.id}`;
  const promInputId = `cluster-edit-prom-${cluster.id}`;
  const fileInputId = `cluster-edit-file-${cluster.id}`;

  const handleFileChange = (event: FormEvent<HTMLInputElement>) => {
    const target = event.currentTarget;
    setFile(target.files?.[0] ?? null);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await onSubmit({ name, prometheusUrl, file });
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
          <label htmlFor={promInputId}>Prometheus 地址(可选)</label>
          <input
            id={promInputId}
            type="text"
            value={prometheusUrl}
            onChange={(event) => setPrometheusUrl(event.target.value)}
            disabled={submitting}
          />
        </div>
        <div className="modal-field">
          <label htmlFor={fileInputId}>重新上传 kubeconfig(可选)</label>
          <input
            id={fileInputId}
            ref={fileInputRef}
            type="file"
            accept=".yaml,.yml,.json"
            onChange={handleFileChange}
            disabled={submitting}
          />
        </div>
        {file && (
          <div className="modal-file-name">
            将上传: <strong>{file.name}</strong>
          </div>
        )}
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

  const [clusterEditState, setClusterEditState] =
    useState<ClusterConfig | null>(null);
  const [clusterEditSubmitting, setClusterEditSubmitting] = useState(false);
  const [clusterEditError, setClusterEditError] = useState<string | null>(null);

  const location = useLocation();
  const navigate = useNavigate();

  const runDisplayIds = useMemo(
    () => createRunDisplayIdMap(runs, clusters),
    [runs, clusters]
  );

  useEffect(() => {
    persistClusterDisplayIds(clusterDisplayIds);
  }, [clusterDisplayIds]);

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
      setRuns(data);
      logWithTimestamp("info", "巡检历史获取成功,数量: %d", data.length);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "获取巡检历史失败";
      logWithTimestamp("error", "获取巡检历史失败: %s", message);
      setClusterNotice(message);
      setClusterNoticeType("error");
    }
  }, []);

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
    setKubeconfigModalOpen(true);
  }, []);

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
    setClusterNotice(null);
    setClusterNoticeType(null);

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
      setClusterNotice("集群注册成功");
      setClusterNoticeType("success");
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
        setInspectionNotice("巡检任务已创建,可在历史巡检中查看进度");
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
    [selectedItemIds, operator, refreshRuns, refreshClusters]
  );

  const handleDeleteCluster = useCallback(
    (cluster: ClusterConfig): Promise<void> => {
      setConfirmState({
        title: "删除集群",
        message: `确认删除集群(${cluster.name})？该操作不可恢复。`,
        confirmLabel: "删除",
        variant: "danger",
        onConfirm: async () => {
          try {
            logWithTimestamp("info", "删除集群: %s", cluster.id);
            await apiDeleteCluster(cluster.id);
            await refreshClusters();
            await refreshRuns();
            setClusterNotice("集群已删除");
            setClusterNoticeType("success");
            if (location.pathname.includes("/clusters/")) {
              navigate("/", { replace: true });
            }
          } catch (err) {
            const message =
              err instanceof Error ? err.message : "删除集群失败";
            logWithTimestamp("error", "删除集群失败: %s", message);
            setClusterNotice(message);
            setClusterNoticeType("error");
            throw err instanceof Error ? err : new Error(message);
          }
        },
      });
      return Promise.resolve();
    },
    [refreshClusters, refreshRuns, location.pathname, navigate]
  );

  const handleDeleteRun = useCallback(
    (run: InspectionRunListItem): Promise<void> => {
      const displayId = runDisplayIds[run.id] ?? String(run.id);
      setConfirmState({
        title: "删除巡检记录",
        message: `确认删除巡检记录(${displayId})？该操作不可恢复。`,
        confirmLabel: "删除",
        variant: "danger",
        onConfirm: async () => {
          try {
            logWithTimestamp("info", "删除巡检记录: %s", run.id);
            await apiDeleteInspectionRun(run.id);
            await refreshRuns();
            await refreshClusters();
            setClusterNotice("巡检记录已删除");
            setClusterNoticeType("success");
          } catch (err) {
            const message =
              err instanceof Error ? err.message : "删除巡检记录失败";
            logWithTimestamp("error", "删除巡检记录失败: %s", message);
            setClusterNotice(message);
            setClusterNoticeType("error");
            throw err instanceof Error ? err : new Error(message);
          }
        },
      });
      return Promise.resolve();
    },
    [runDisplayIds, refreshRuns, refreshClusters]
  );

  const handleDeleteRunById = useCallback(
    (runId: number, redirectPath?: string): Promise<void> => {
      const displayId = runDisplayIds[runId] ?? String(runId);
      setConfirmState({
        title: "删除巡检记录",
        message: `确认删除巡检记录(${displayId})？该操作不可恢复。`,
        confirmLabel: "删除",
        variant: "danger",
        onConfirm: async () => {
          try {
            logWithTimestamp("info", "删除巡检记录: %s", runId);
            await apiDeleteInspectionRun(runId);
            await refreshRuns();
            await refreshClusters();
            setClusterNotice("巡检记录已删除");
            setClusterNoticeType("success");
            if (redirectPath) {
              navigate(redirectPath, { replace: true });
            }
          } catch (err) {
            const message =
              err instanceof Error ? err.message : "删除巡检记录失败";
            logWithTimestamp("error", "删除巡检记录失败: %s", message);
            setClusterNotice(message);
            setClusterNoticeType("error");
            throw err instanceof Error ? err : new Error(message);
          }
        },
      });
      return Promise.resolve();
    },
    [runDisplayIds, refreshRuns, refreshClusters, navigate]
  );

  const handleEditCluster = useCallback((cluster: ClusterConfig) => {
    setClusterEditState(cluster);
    setClusterEditError(null);
  }, []);

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
        setClusterNotice("集群信息已更新");
        setClusterNoticeType("success");
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
    [clusterEditState, refreshClusters, refreshRuns]
  );

  const closeClusterEditModal = () => {
    setClusterEditState(null);
    setClusterEditError(null);
  };

  return (
    <>
      <TopNavigation />
      <main className="app-shell">
        <Routes>
          <Route
            path="/"
            element={
              <OverviewView
                clusters={clusters}
                clusterError={clusterError}
                clusterNotice={clusterNotice}
                clusterNoticeType={clusterNoticeType}
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
                clusterDisplayIds={clusterDisplayIds}
              />
            }
          />
          <Route
            path="/history"
            element={
              <HistoryView
                runs={runs}
                onRefreshRuns={refreshRuns}
                onDeleteRun={handleDeleteRun}
                clusterDisplayIds={clusterDisplayIds}
                runDisplayIds={runDisplayIds}
              />
            }
          />
          <Route
            path="/clusters/:clusterKey"
            element={
              <ClusterDetailView
                clusters={clusters}
                items={items}
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
                clusterError={clusterError}
                onStartInspection={handleStartInspection}
                onDeleteRun={handleDeleteRun}
                onEditCluster={handleEditCluster}
                onDeleteCluster={handleDeleteCluster}
                clusterDisplayIds={clusterDisplayIds}
                runDisplayIds={runDisplayIds}
              />
            }
          />
          <Route
            path="/clusters/:clusterKey/runs/:runKey"
            element={
              <RunDetailView
                clusters={clusters}
                onDeleteRun={handleDeleteRunById}
                clusterDisplayIds={clusterDisplayIds}
                runDisplayIds={runDisplayIds}
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
        state={confirmState}
        onClose={() => setConfirmState(null)}
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
