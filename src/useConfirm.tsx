import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ConfirmDialog } from "./ConfirmDialog";

/** What a confirmation asks, for useConfirm. */
export type ConfirmOptions = {
  title: string;
  /** The question and its consequences. */
  body: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** Styles the confirm button as a warning, for actions that cannot be undone. */
  isDestructive?: boolean;
};

type PendingConfirmation = ConfirmOptions & {
  resolve: (confirmed: boolean) => void;
};

/**
 * Asks for confirmation in the in-page ConfirmDialog with a promise, as a drop-in for window.confirm in async
 * handlers: `if (!(await confirm({...}))) return;`. Render the returned `confirmDialog` once in the component.
 * Asking again while a question is open cancels the earlier one, and unmounting cancels any open question.
 * @returns The confirm function and the dialog element to render.
 */
export const useConfirm = () => {
  const [pending, setPending] = useState<PendingConfirmation | null>(null);
  const pendingRef = useRef<PendingConfirmation | null>(null);

  const settle = useCallback((confirmed: boolean) => {
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    current?.resolve(confirmed);
  }, []);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        pendingRef.current?.resolve(false);
        const next = { ...options, resolve };
        pendingRef.current = next;
        setPending(next);
      }),
    [],
  );

  useEffect(() => () => pendingRef.current?.resolve(false), []);

  const confirmDialog = pending ? (
    <ConfirmDialog
      // A new key for each question, so the dialog opens fresh with focus on Cancel.
      key={`${pending.title}-${String(pending.confirmLabel)}`}
      isOpen
      title={pending.title}
      confirmLabel={pending.confirmLabel}
      cancelLabel={pending.cancelLabel}
      isDestructive={pending.isDestructive}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    >
      {pending.body}
    </ConfirmDialog>
  ) : null;

  return { confirm, confirmDialog };
};
