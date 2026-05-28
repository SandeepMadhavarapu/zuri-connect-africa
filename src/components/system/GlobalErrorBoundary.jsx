import { Component } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';

export default class GlobalErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorCount: 0 };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    const count = this.state.errorCount + 1;
    this.setState({ errorCount: count });
    
    try {
      console.error('[GlobalErrorBoundary] Render crash caught:', {
        error: error?.message || String(error),
        componentStack: errorInfo?.componentStack,
        crashCount: count,
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      console.error('Audit log failed:', e);
    }

    console.error('[GlobalErrorBoundary]', error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="fixed inset-0 bg-background flex items-center justify-center px-4 z-50">
          <div className="glass-card rounded-2xl p-8 border border-destructive/20 max-w-sm text-center">
            <div className="w-12 h-12 rounded-2xl bg-destructive/10 flex items-center justify-center mx-auto mb-4">
              <AlertCircle size={24} className="text-destructive" />
            </div>
            <p className="text-sm font-semibold text-foreground mb-2">Application Error</p>
            <p className="text-xs text-muted-foreground mb-1">
              {this.state.error?.message || 'An unexpected error occurred'}
            </p>
            {this.state.errorCount > 1 && (
              <p className="text-[10px] text-amber-400 mb-6">
                (Error #{this.state.errorCount})
              </p>
            )}
            <div className="flex gap-2">
              <button
                onClick={this.handleReset}
                className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-white/8 border border-white/10 text-foreground font-semibold text-sm transition-all hover:bg-white/12"
              >
                Retry
              </button>
              <button
                onClick={() => window.location.href = '/'}
                className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl gradient-green text-black font-semibold text-sm transition-all active:scale-95"
              >
                <RefreshCw size={14} />
                Reload
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}