import { useEffect, useMemo, useRef } from "react";
import type { ConfirmDialogState, SettingsModalTab } from "../types-ui";
import type { AuthUser } from "../types";
import ConfirmationModal from "../ConfirmationModal";
import { useEffect, useMemo, useRef } from "react";

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
    document.body.classList.add("settings-lock");
    return () => {
      document.body.classList.remove("settings-lock");
    };
  }, []);

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

  return (
    <div className="settings-page">
      <div
        className="settings-modal"
        role="region"
        aria-label="系统设置"
        ref={containerRef}
        tabIndex={-1}
      >
        <div className="settings-modal-shell">
          <aside className="settings-modal-sidebar">
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
          </aside>
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
