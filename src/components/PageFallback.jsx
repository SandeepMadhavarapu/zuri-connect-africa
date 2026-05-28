import { motion } from 'framer-motion';
import { AlertTriangle, Loader2 } from 'lucide-react';

export function PageLoader() {
  return (
    <div className="flex-1 flex items-center justify-center px-4 py-8 min-h-0">
      <motion.div animate={{ opacity: [0.6, 1, 0.6] }} transition={{ duration: 2, repeat: Infinity }}>
        <div className="w-12 h-12 rounded-2xl gradient-green flex items-center justify-center">
          <Loader2 size={20} className="text-black animate-spin" />
        </div>
      </motion.div>
    </div>
  );
}

export function PageErrorFallback({ error, retry }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-4 py-8 min-h-0">
      <div className="w-12 h-12 rounded-2xl bg-destructive/10 flex items-center justify-center mb-4">
        <AlertTriangle size={24} className="text-destructive" />
      </div>
      <p className="text-base font-semibold text-foreground mb-2">Unable to load this page</p>
      <p className="text-sm text-muted-foreground text-center mb-6 max-w-xs">
        {error ? error.message : 'An unexpected error occurred. Please try again.'}
      </p>
      {retry && (
        <button
          onClick={retry}
          className="px-4 py-2 rounded-lg gradient-green text-black text-sm font-semibold"
        >
          Try again
        </button>
      )}
    </div>
  );
}

export function DataSkeleton({ count = 3 }) {
  return (
    <div className="space-y-3 px-4 py-4">
      {[...Array(count)].map((_, i) => (
        <div key={i} className="glass-card rounded-2xl p-4 h-24 skeleton" />
      ))}
    </div>
  );
}