import { Link, NavLink } from "react-router-dom";
import type { AuthUser } from "../types";
import { useEffect, useRef, useState } from "react";

interface TopNavigationProps {
  user?: AuthUser | null;
  onOpenSettings: () => void;
  onChangePassword?: () => void;
  onLogout?: () => void;
  showClusters: boolean;
  showAudit: boolean;
  showSchedule: boolean;
  showHistory: boolean;
}

const TopNavigation = ({
  user,
  onOpenSettings,
  onChangePassword,
  onLogout,
  showClusters,
  showAudit,
  showSchedule,
  showHistory,
}: TopNavigationProps) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, []);

  const displayName = (user?.display_name || user?.username || "A").trim();
  const avatarLabel = displayName ? displayName[0]?.toUpperCase() : "A";

  return (
    <header className="top-navigation">
      <Link to="/" className="top-navigation-brand" aria-label="返回首页">
        <span className="top-navigation-home-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" focusable="false">
            <path
              d="M20.25 9.52 12.6 3.46a.75.75 0 0 0-.93 0L3.75 9.52a.75.75 0 0 0-.27.57V20a.75.75 0 0 0 .75.75h4.5a.75.75 0 0 0 .75-.75v-4.5h4.5V20a.75.75 0 0 0 .75.75h4.5A.75.75 0 0 0 21 20V10.09a.75.75 0 0 0-.27-.57Z"
              fill="currentColor"
            />
          </svg>
        </span>
        <span className="top-navigation-title">首页概览</span>
      </Link>

      <div className="top-navigation-right">
        <nav className="top-navigation-links">
          {showClusters && (
            <NavLink
              to="/clusters"
              className={({ isActive }) =>
                `top-navigation-link${isActive ? " active" : ""}`
              }
            >
              <span className="top-navigation-link-inner">
                <span className="top-navigation-link-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false">
                    <path
                      d="M5.5 4.75h13a1.75 1.75 0 0 1 1.75 1.75v2.25A1.75 1.75 0 0 1 18.5 10.5h-13A1.75 1.75 0 0 1 3.75 8.75V6.5A1.75 1.75 0 0 1 5.5 4.75Zm0 9h13A1.75 1.75 0 0 1 20.25 15.5v2.25A1.75 1.75 0 0 1 18.5 19.5h-13A1.75 1.75 0 0 1 3.75 17.75V15.5A1.75 1.75 0 0 1 5.5 13.75Zm0-7.5a.25.25 0 0 0-.25.25v2.25c0 .14.11.25.25.25h13a.25.25 0 0 0 .25-.25V6.5a.25.25 0 0 0-.25-.25h-13Zm0 9a.25.25 0 0 0-.25.25v2.25c0 .14.11.25.25.25h13a.25.25 0 0 0 .25-.25V15.5a.25.25 0 0 0-.25-.25h-13Z"
                      fill="currentColor"
                    />
                  </svg>
                </span>
                <span>集群列表</span>
              </span>
            </NavLink>
          )}
          {showSchedule && (
            <NavLink
              to="/schedule"
              className={({ isActive }) =>
                `top-navigation-link${isActive ? " active" : ""}`
              }
            >
              <span className="top-navigation-link-inner">
                <span className="top-navigation-link-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false">
                    <path
                      d="M7.5 3a.75.75 0 0 1 .75.75V6h7.5V3.75a.75.75 0 0 1 1.5 0V6h1.25A2.5 2.5 0 0 1 21 8.5v10A2.5 2.5 0 0 1 18.5 21h-13A2.5 2.5 0 0 1 3 18.5v-10A2.5 2.5 0 0 1 5.5 6h1.25V3.75A.75.75 0 0 1 7.5 3Zm11 9.5h-13v6a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-6Zm0-1.5v-2.5a1 1 0 0 0-1-1h-11a1 1 0 0 0-1 1V11h13Z"
                      fill="currentColor"
                    />
                  </svg>
                </span>
                <span>定时巡检</span>
              </span>
            </NavLink>
          )}
          {showHistory && (
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
          )}
          {showAudit && (
            <NavLink
              to="/audit"
              className={({ isActive }) =>
                `top-navigation-link${isActive ? " active" : ""}`
              }
            >
              <span className="top-navigation-link-inner">
                <span className="top-navigation-link-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false">
                    <path
                      d="M7 4.75A2.75 2.75 0 0 0 4.25 7.5v9A2.75 2.75 0 0 0 7 19.25h10A2.75 2.75 0 0 0 19.75 16.5v-9A2.75 2.75 0 0 0 17 4.75H7Zm0 1.5h10c.69 0 1.25.56 1.25 1.25v9c0 .69-.56 1.25-1.25 1.25H7c-.69 0-1.25-.56-1.25-1.25v-9c0-.69.56-1.25 1.25-1.25Zm1.5 2.5a.75.75 0 0 0 0 1.5h7a.75.75 0 0 0 0-1.5h-7Zm0 4a.75.75 0 0 0 0 1.5h7a.75.75 0 0 0 0-1.5h-7Z"
                      fill="currentColor"
                    />
                  </svg>
                </span>
                <span>审计日志</span>
              </span>
            </NavLink>
          )}
        </nav>

        <div className="top-navigation-user" ref={menuRef}>
          <button
            type="button"
            className={`avatar-trigger${menuOpen ? " open" : ""}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((prev) => !prev)}
          >
            <span className="avatar-circle">{avatarLabel}</span>
            <span className="avatar-meta">
              <span className="avatar-name">{displayName || "用户"}</span>
              <span className="avatar-desc">个人中心</span>
            </span>
            <span className="avatar-caret" aria-hidden="true">
              <svg viewBox="0 0 20 20">
                <path
                  d="M5.3 7.7a1 1 0 0 1 1.4 0L10 11l3.3-3.3a1 1 0 1 1 1.4 1.4l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 0-1.4Z"
                  fill="currentColor"
                />
              </svg>
            </span>
          </button>
          {menuOpen && (
            <div className="avatar-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenSettings();
                }}
              >
                设置
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onChangePassword?.();
                }}
              >
                修改密码
              </button>
              <button
                type="button"
                role="menuitem"
                className="danger"
                onClick={() => {
                  setMenuOpen(false);
                  onLogout?.();
                }}
              >
                退出登录
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};

export default TopNavigation;
