import React from 'react';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    this.setState({ errorInfo });
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: 16,
          margin: 8,
          background: '#1a0000',
          border: '2px solid #dc2626',
          borderRadius: 8,
          color: '#fca5a5',
          fontFamily: 'monospace',
          fontSize: 13,
          wordBreak: 'break-word',
          overflow: 'auto',
          maxHeight: 300
        }}>
          <div style={{ fontWeight: 700, marginBottom: 8, color: '#ef4444' }}>
            React render error
          </div>
          <div style={{ marginBottom: 8 }}>
            {this.state.error?.toString()}
          </div>
          {this.state.errorInfo?.componentStack && (
            <pre style={{ fontSize: 11, color: '#999', whiteSpace: 'pre-wrap' }}>
              {this.state.errorInfo.componentStack}
            </pre>
          )}
          <button
            onClick={() => this.setState({ hasError: false, error: null, errorInfo: null })}
            style={{
              marginTop: 12,
              padding: '8px 16px',
              background: '#dc2626',
              color: '#fff',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 13
            }}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
