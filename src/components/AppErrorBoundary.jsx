import { Component } from 'react';
import { AlertCircle } from 'lucide-react';

export default class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('AppErrorBoundary caught:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center px-4 py-8 min-h-0">
          <div className="w-12 h-12 rounded-2xl bg-destructive/10 flex items-center justify-center mb-4">
            <AlertCircle size={24} className="text-destructive" />
          </div>
          <p className="text-base font-semibold text-foreground mb-2">Something went wrong</p>
          <p className="text-sm text-muted-foreground text-center mb-6">
            We've encountered an error. Try refreshing the page.
          </p>
          <button
            onClick={() => {
              this.setState({ hasError: false, error: null });
              window.location.reload();
            }}
            className="px-4 py-2 rounded-lg gradient-green text-black text-sm font-semibold"
          >
            Refresh page
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}