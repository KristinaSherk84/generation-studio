/**
 * App-wide React error boundary (2026-08-05).
 *
 * Before this, the app had NO error boundary — so any render-time throw
 * anywhere in the tree unmounted the WHOLE app and left the customer on a
 * blank white screen (observed in Clarity as "the screen disappears"), with
 * no way to buy and no trace in the server logs (a client render crash never
 * hits a serverless function).
 *
 * This turns that catastrophic silent failure into (a) a friendly, recoverable
 * screen with a Reload button, and (b) a best-effort report to /api/client-error
 * so the real error + stack finally shows up in the Vercel logs and we can fix
 * the root cause.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { hasError: boolean };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 1) Always surface it in the browser console.
    // eslint-disable-next-line no-console
    console.error("[app-crash]", error, info?.componentStack);
    // 2) Best-effort report so the crash is visible server-side. Never throw.
    try {
      void fetch("/api/client-error", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        body: JSON.stringify({
          message: String(error?.message ?? error),
          stack: String(error?.stack ?? "").slice(0, 4000),
          componentStack: String(info?.componentStack ?? "").slice(0, 4000),
          url: typeof window !== "undefined" ? window.location.href : "",
          ua: typeof navigator !== "undefined" ? navigator.userAgent : "",
        }),
      }).catch(() => {});
    } catch {
      /* reporting must never make things worse */
    }
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div
        style={{
          minHeight: "100vh",
          background: "#FAF8F4",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          fontFamily:
            "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif",
          color: "#2A2A2A",
        }}
      >
        <div
          style={{
            background: "#fff",
            border: "1px solid #E8E4DB",
            borderRadius: 14,
            maxWidth: 440,
            width: "100%",
            padding: "30px 26px",
            textAlign: "center",
            boxShadow: "0 12px 40px rgba(0,0,0,0.10)",
          }}
        >
          <h2 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 12px" }}>
            Something hiccuped on our end
          </h2>
          <p style={{ fontSize: 15, lineHeight: 1.6, color: "#5A5A56", margin: "0 0 22px" }}>
            Sorry about that! Please reload to continue. If you&rsquo;d already
            generated headshots, the link in your &ldquo;your headshots are
            ready&rdquo; email will take you straight back to them.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              background: "#1B4332",
              color: "#fff",
              border: "none",
              borderRadius: 999,
              padding: "13px 30px",
              fontSize: 15,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Reload the page
          </button>
          <p style={{ fontSize: 13, lineHeight: 1.5, color: "#9A968D", margin: "20px 0 0" }}>
            If it keeps happening, email kristi@kristinasherk.com and I&rsquo;ll
            sort it out for you.
          </p>
        </div>
      </div>
    );
  }
}
