import { useEffect, useRef, type ReactNode } from "react";
import "./ConfirmDialog.css";

type ConfirmDialogProps = {
  isOpen: boolean;
  title: string;
  /** The question and its consequences. */
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** Styles the confirm button as a warning, for actions that cannot be undone. */
  isDestructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Asks for confirmation in an in-page modal dialog instead of window.confirm, which some mobile browsers and
 * embedded views block or style poorly. Escape, the Cancel button, and the backdrop cancel; focus starts on
 * Cancel so an accidental Enter never confirms an action that cannot be undone.
 */
const ConfirmDialogContent = ({
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  isDestructive = false,
  onConfirm,
  onCancel,
}: Omit<ConfirmDialogProps, "isOpen">) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
    cancelButtonRef.current?.focus();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog"
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-body"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onClick={(event) => {
        // A click on the dialog element itself (not its content) is a click on the backdrop.
        if (event.target === event.currentTarget) {
          onCancel();
        }
      }}
    >
      <div className="confirm-dialog-content">
        <header className="confirm-dialog-header">
          <h2 id="confirm-dialog-title">{title}</h2>
        </header>
        <div id="confirm-dialog-body" className="confirm-dialog-body">
          {children}
        </div>
        <footer className="confirm-dialog-footer">
          <button
            ref={cancelButtonRef}
            type="button"
            className="secondary-button"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={
              isDestructive
                ? "primary-button confirm-dialog-danger"
                : "primary-button"
            }
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </footer>
      </div>
    </dialog>
  );
};

export const ConfirmDialog = ({ isOpen, ...props }: ConfirmDialogProps) =>
  isOpen ? <ConfirmDialogContent {...props} /> : null;
