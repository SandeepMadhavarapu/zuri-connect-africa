import { Component } from 'react';
import { AlertCircle, RotateCcw } from 'lucide-react';

export default class RenderGuard extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
    this.errorCount = 0;
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, errorMessage: error?.message || 'System temporarily unavailable' };
  }

  componentDidCatch(error, errorInfo) {
    this.errorCount++;
    console.error(`[RenderGuard:${this.props.name}] Error:`, error, errorInfo);
  }

  render() {
    const { hasError, errorMessage } = this.state;
    const { name, children, fallback } = this.props;

    if (hasError) {
      return (
        fallback || (
          <div className="glass-card rounded-2xl p-4 border border-red-400/15 bg-red-400/5">
            <div className="flex items-start gap-3">
              <AlertCircle size={16} className="text-red-400 shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm font-semibold text-red-400 mb-1">
                  {name ? `${name} temporarily unavailable` : 'System temporarily unavailable'}
                </p>
                {errorMessage && errorMessage !== 'System temporarily unavailable' && (
                  <p className="text-xs text-muted-foreground mb-2 leading-relaxed">
                    {errorMessage}
                  </p>
                )}
                <button
                  onClick={() => this.setState({ hasError: false, errorMessage: '' })}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-400 hover:text-red-300 transition-colors"
                >
                  <RotateCcw size={11} /> Try again
                </button>
              </div>
            </div>
          </div>
        )
      );
    }

    return children;
  }
}