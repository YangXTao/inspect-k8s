import { useEffect, useMemo, useRef } from "react";
import type { ConfirmDialogState, SettingsModalTab } from "../types-ui";
import type { AuthUser } from "../types";
import ConfirmationModal from "../ConfirmationModal";

interface SettingsPageProps {
  tabs: SettingsModalTab[];
  initialTabId?: string;
  activeTabId: string;
  onTabChange: (tabId: string) => void;
  onLeave: () => void;
  user?: AuthUser | null;
  onLogout?: () => void;
  onChangePassword?: () => void;
  confirmState?: ConfirmDialogState | null;
  onConfirmClose?: () => void;
}

const SettingsPage = ({
  tabs,
  initialTabId,
  activeTabId,
  onTabChange,
  onLeave,
  user,
  onLogout,
  onChangePassword,
  confirmState,
  onConfirmClose,
}: SettingsPageProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const hasTabs = tabs.length > 0;
  const fallbackTabId = useMemo(
    () =>
      tabs.find((tab) => tab.id === (initialTabId ?? ""))?.id ??
      tabs[0]?.id ??
      "overview",
    [tabs, initialTabId]
  );
  const effectiveTabId = tabs.some((tab) => tab.id === activeTabId)
    ? activeTabId
    : fallbackTabId;
  const currentTab =
    tabs.find((tab) => tab.id === effectiveTabId) ?? tabs[0] ?? null;

  useEffect(() => {
    const handleKeyDown = (event: { key: string }) => {
      if (event.key === "Escape") {
        if (confirmState && onConfirmClose) {
          onConfirmClose();
        } else {
          onLeave();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [confirmState, onLeave, onConfirmClose]);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }
    const previouslyFocused = document.activeElement as HTMLElement | null;
    containerRef.current.focus();
    return () => {
      previouslyFocused?.focus?.();
    };
  }, []);

  if (!hasTabs || !currentTab) {
    return null;
  }

  const selectTab = (tabId: string) => {
    onTabChange(tabId);
  };

  const isCompactTab =
    effectiveTabId === "overview" || effectiveTabId === "license";
  const modalClassName = `settings-modal${
    isCompactTab ? " settings-modal-compact" : ""
  }`;

  return (
    <div className="settings-page">
      <div
        className={modalClassName}
        role="region"
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
            onClick={onLeave}
            aria-label="返回上一页"
          >
            返回
          </button>
        </div>
        <div className="settings-modal-shell">
          <div className="settings-modal-sidebar">
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
            {user && (
              <div className="settings-user-card">
                <div className="settings-user-avatar">
                  {(user.display_name || user.username || "A")[0]?.toUpperCase()}
                </div>
                <div className="settings-user-info">
                  <div className="settings-user-name">
                    {user.display_name || user.username}
                  </div>
                  <div className="settings-user-meta">账号：{user.username}</div>
                  <div className="settings-user-actions">
                    <button
                      type="button"
                      className="secondary ghost"
                      onClick={onChangePassword}
                    >
                      修改密码
                    </button>
                    <button
                      type="button"
                      className="secondary danger"
                      onClick={onLogout}
                    >
                      退出登录
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
          <section className="settings-modal-main">
            {currentTab.render({
              close: onLeave,
              selectTab,
            })}
          </section>
        </div>
      </div>
      {confirmState && (
        <ConfirmationModal
          state={confirmState}
          onClose={onConfirmClose ?? onLeave}
        />
      )}
    </div>
  );
};

export default SettingsPage;
