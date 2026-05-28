import { AlertCircle, RefreshCw } from 'lucide-react';
import { motion } from 'framer-motion';

export default function RouteFallback({ message = "Something failed to load", onRetry }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="flex-1 flex items-center justify-center px-4"
    >
      <div className="glass-card rounded-2xl p-8 border border-destructive/20 max-w-sm text-center">
        <div className="w-12 h-12 rounded-2xl bg-destructive/10 flex items-center justify-center mx-auto mb-4">
          <AlertCircle size={24} className="text-destructive" />
        </div>
        <p className="text-sm font-semibold text-foreground mb-2">Load Failed</p>
        <p className="text-xs text-muted-foreground mb-6">{message}</p>
        <button
          onClick={onRetry || (() => window.location.reload())}
          className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl gradient-green text-black font-semibold text-sm transition-all active:scale-95"
        >
          <RefreshCw size={14} />
          Try Again
        </button>
      </div>
    </motion.div>
  );
}