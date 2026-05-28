import { useToast } from "@/components/ui/use-toast";
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast";
import { CheckCircle2, XCircle, AlertTriangle, Info } from 'lucide-react';

function ToastIcon({ variant }) {
  if (variant === 'destructive') {
    return <XCircle size={16} className="text-destructive-foreground shrink-0 mt-0.5" />;
  }
  if (variant === 'warning') {
    return <AlertTriangle size={16} className="text-amber-400 shrink-0 mt-0.5" />;
  }
  if (variant === 'success') {
    return <CheckCircle2 size={16} className="text-primary shrink-0 mt-0.5" />;
  }
  return <Info size={16} className="text-muted-foreground shrink-0 mt-0.5" />;
}

export function Toaster() {
  const { toasts } = useToast();

  return (
    <ToastProvider>
      {toasts.map(function ({ id, title, description, action, ...props }) {
        return (
          <Toast key={id} {...props}>
            <div className="flex items-start gap-2.5">
              <ToastIcon variant={props.variant} />
              <div className="grid gap-1 flex-1">
                {title && <ToastTitle>{title}</ToastTitle>}
                {description && (
                  <ToastDescription>{description}</ToastDescription>
                )}
              </div>
            </div>
            {action}
            <ToastClose />
          </Toast>
        );
      })}
      <ToastViewport />
    </ToastProvider>
  );
} 