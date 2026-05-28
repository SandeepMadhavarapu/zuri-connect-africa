import { AlertCircle } from 'lucide-react';
import AppErrorBoundary from './GlobalErrorBoundary';

export default function SafeChartWrapper({ 
  children, 
  fallback = null,
  loading = false,
  error = null,
  isEmpty = false 
}) {
  return (
    <AppErrorBoundary>
      <div className="glass-card rounded-2xl p-4">
        {error && (
          <div className="flex items-center gap-2.5 px-3 py-2 bg-destructive/10 border border-destructive/20 rounded-xl mb-4">
            <AlertCircle size={14} className="text-destructive shrink-0" />
            <p className="text-xs text-destructive">{String(error)}</p>
          </div>
        )}
        
        {loading && (
          <div className="h-64 flex items-center justify-center">
            <div className="flex flex-col items-center gap-2">
              <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
              <p className="text-xs text-muted-foreground">Loading chart…</p>
            </div>
          </div>
        )}
        
        {isEmpty && !loading && (
          <div className="h-64 flex items-center justify-center">
            <p className="text-sm text-muted-foreground">No data available</p>
          </div>
        )}
        
        {!error && !loading && !isEmpty && children}
        
        {fallback && error && fallback}
      </div>
    </AppErrorBoundary>
  );
}