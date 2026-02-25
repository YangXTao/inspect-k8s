import { useEffect, useState } from "react";
import type { ConfirmDialogState } from "./types-ui";

export interface ConfirmationModalProps {
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

export default ConfirmationModal;
