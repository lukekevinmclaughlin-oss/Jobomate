import React from "react";

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="app">
          <div style={{
            display: "flex", flexDirection: "column", alignItems: "center",
            justifyContent: "center", height: "100vh", padding: "2rem",
            fontFamily: "system-ui, -apple-system, sans-serif",
          }}>
            <h2 style={{ marginBottom: "0.5rem" }}>Something went wrong</h2>
            <p style={{ color: "#666", maxWidth: 400, textAlign: "center", marginBottom: "1rem" }}>
              The application encountered an unexpected error. Please try restarting.
            </p>
            <pre style={{
              background: "#f5f5f5", padding: "1rem", borderRadius: 8,
              maxWidth: 600, overflow: "auto", fontSize: "0.8rem", color: "#c00"
            }}>
              {this.state.error?.message || "Unknown error"}
            </pre>
            <button
              onClick={() => window.location.reload()}
              style={{
                marginTop: "1rem", padding: "0.5rem 1.5rem",
                background: "#007aff", color: "white", border: "none",
                borderRadius: 6, cursor: "pointer", fontSize: "1rem",
              }}
            >
              Restart
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
