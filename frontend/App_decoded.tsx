import { useEffect, useMemo, useRef, useState } from "react";
import {
  Routes,
  Route,
  useNavigate,
  useParams,
  useLocation,
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
  if (!value) return "-";
  return new Date(value).toLocaleString();
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
  clusterFileRef: React.RefObject<HTMLInputElement>;
  onUpload: () => void;
  runs: InspectionRunListItem[];
  onRefreshRuns: () => void;
  onDeleteRun: (run: InspectionRunListItem) => Promise<void>;
  onEditCluster: (cluster: ClusterConfig) => void;
  onDeleteCluster: (cluster: ClusterConfig) => Promise<void>;
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
  clusterFileRef,
  onUpload,
  runs,
  onRefreshRuns,
  onDeleteRun,
  onEditCluster,
  onDeleteCluster,
}: OverviewProps) => {
  const navigate = useNavigate();

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
            <p>上传 kubeconfig，配置 Prometheus，一键执行巡检并生成报告。</p>
          </div>
        </div>
        <div className="header-actions">
          <div className="cluster-upload">
            <label>上传 kubeconfig</label>
            <input
              type="text"
              placeholder="自定义集群名称（可选）"
              value={clusterNameInput}
              onChange={(event) => setClusterNameInput(event.target.value)}
            />
            <input
              type="text"
              placeholder="Prometheus 地址（可选）"
              value={clusterPromInput}
              onChange={(event) => setClusterPromInput(event.target.value)}
            />
            <input ref={clusterFileRef} type="file" accept=".yaml,.yml,.json" />
            <button
              className="secondary"
              onClick={onUpload}
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
            还没有集群，请通过上方按钮上传 kubeconfig 完成注册。
          </p>
        ) : (
          <div className="cluster-list">
            {clusters.map((cluster) => {
              const statusMeta = getClusterStatusMeta(cluster.connection_status);
              return (
                <button
                  key={cluster.id}
                  className="cluster-card"
                  onClick={() => navigate(`/clusters/${cluster.id}`)}
                >
                  <div className="cluster-card-top">
                    <div className="cluster-name">{cluster.name}</div>
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
                      最近校验：{formatDate(cluster.last_checked_at)}
                    </div>
                  )}
                  <div className="cluster-meta">
                    <span>Prometheus：{cluster.prometheus_url || "未配置"}</span>
                  </div>
                  <div className="cluster-meta">
                    <span>创建时间：{formatDate(cluster.created_at)}</span>
                    <span>更新时间：{formatDate(cluster.updated_at)}</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>

      <section className="card history">
        <div className="card-header">
          <h2>历史巡检</h2>
          <button className="secondary" onClick={onRefreshRuns}>
            刷新
          </button>
        </div>
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>集群</th>
                <th>巡检人</th>
                <th>状态</th>
                <th>开始时间</th>
                <th>结束时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td>{run.id}</td>
                  <td>{run.cluster_name}</td>
                  <td>{run.operator || "-"}</td>
                  <td>
                    <span className={statusClass(run.status)}>{run.status}</span>
                  </td>
                  <td>{formatDate(run.created_at)}</td>
                  <td>{formatDate(run.completed_at)}</td>
                  <td className="actions">
                    <button
                      className="link-button"
                      onClick={() =>
                        navigate(`/clusters/${run.cluster_id}/runs/${run.id}`)
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
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
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
}: ClusterDetailProps) => {
  const { clusterId } = useParams();
  const navigate = useNavigate();

  const numericId = Number(clusterId);

  useEffect(() => {
    setSelectedIds(() => []);
  }, [numericId, setSelectedIds]);

  if (Number.isNaN(numericId)) {
    return (
      <div className="detail-empty">
        <p>集群编号无效。</p>
        <button className="secondary" onClick={() => navigate("/")}>
          返回集群列表
        </button>
      </div>
    );
  }

  const cluster = clusters.find((c) => c.id === numericId);
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
          ← 返回集群列表
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
              <strong>名称：</strong>
              {cluster.name}
            </div>
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
              {formatDate(cluster.last_checked_at)}
            </div>
            <div>
              <strong>Prometheus：</strong>
              {cluster.prometheus_url || "未配置"}
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
              placeholder="输入巡检人姓名（可选）"
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
                <th>ID</th>
                <th>巡检人</th>
                <th>状态</th>
                <th>开始时间</th>
                <th>结束时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {clusterRuns.map((run) => (
                <tr key={run.id}>
                  <td>{run.id}</td>
                  <td>{run.operator || "-"}</td>
                  <td>
                    <span className={statusClass(run.status)}>{run.status}</span>
                  </td>
                  <td>{formatDate(run.created_at)}</td>
                  <td>{formatDate(run.completed_at)}</td>
                  <td className="actions">
                    <button
                      className="link-button"
                      onClick={() =>
                        navigate(`/clusters/${cluster.id}/runs/${run.id}`)
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
              ))}
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
}

const RunDetailView = ({ clusters, onDeleteRun }: RunDetailProps) => {
  const { clusterId, runId } = useParams();
  const navigate = useNavigate();

  const numericRunId = Number(runId);
  const numericClusterId = Number(clusterId);

  const [run, setRun] = useState<InspectionRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (Number.isNaN(numericRunId)) {
      setError("巡检编号无效。");
      return;
    }
    setLoading(true);
    setError(null);
    getInspectionRun(numericRunId)
      .then((data) => setRun(data))
      .catch((err) =>
        setError(err instanceof Error ? err.message : "获取巡检详情失败。")
      )
      .finally(() => setLoading(false));
  }, [numericRunId]);

  const cluster = useMemo(
    () => clusters.find((item) => item.id === (run?.cluster_id ?? numericClusterId)),
    [clusters, run, numericClusterId]
  );

  if (Number.isNaN(numericRunId)) {
