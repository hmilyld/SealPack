import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import {
  Toast,
  ToastTitle,
  Toaster,
  useId,
  useToastController,
} from "@fluentui/react-components";

export type ToastIntent = "success" | "error" | "warning" | "info";

interface ToastContextValue {
  toast: (message: string, intent?: ToastIntent) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const toasterId = useId("sealpack-toaster");
  const { dispatchToast } = useToastController(toasterId);

  const toast = useCallback(
    (message: string, intent: ToastIntent = "info") => {
      dispatchToast(
        <Toast>
          <ToastTitle>{message}</ToastTitle>
        </Toast>,
        { intent, timeout: 4000 },
      );
    },
    [dispatchToast],
  );

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <Toaster toasterId={toasterId} position="bottom-end" />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue["toast"] {
  const value = useContext(ToastContext);
  if (!value) throw new Error("useToast 必须在 ToastProvider 内使用");
  return value.toast;
}
