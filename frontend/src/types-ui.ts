import type { ReactNode } from "react";

export type ConfirmVariant = "primary" | "danger";

export interface ConfirmDialogOption {
  id: string;
  label: string;
  description?: string;
  defaultChecked?: boolean;
}

export interface ConfirmDialogState {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: ConfirmVariant;
  onConfirm: (options?: Record<string, boolean>) => Promise<void> | void;
  scope?: "global" | "settings";
  options?: ConfirmDialogOption[];
}

export interface SettingsModalTabRenderContext {
  close: () => void;
  selectTab: (tabId: string) => void;
}

export interface SettingsModalTab {
  id: string;
  label: string;
  render: (context: SettingsModalTabRenderContext) => ReactNode;
}
