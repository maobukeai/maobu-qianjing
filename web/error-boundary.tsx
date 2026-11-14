import React, { type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "./i18n";

export interface ErrorBoundaryFallbackProps {
  error: Error;
  resetErrorBoundary: () => void;
  scope?: string;
}

export interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode | ((props: ErrorBoundaryFallbackProps) => ReactNode);
  onReset?: () => void;
  onError?: (error: Error, info: ErrorInfo) => void;
  resetKeys?: readonly unknown[];
  scope?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

function resetKeysChanged(
  prevKeys: readonly unknown[] | undefined,
  nextKeys: readonly unknown[] | undefined,
): boolean {
  if (prevKeys === nextKeys) return false;
  if (!prevKeys || !nextKeys) return prevKeys !== nextKeys;
  if (prevKeys.length !== nextKeys.length) return true;
  for (let i = 0; i < prevKeys.length; i += 1) {
    if (!Object.is(prevKeys[i], nextKeys[i])) return true;
  }
  return false;
}

export function ErrorBoundaryFallback({
  error,
  resetErrorBoundary,
  scope,
}: ErrorBoundaryFallbackProps) {
  const { t } = useTranslation();
  const title = scope
    ? t("{scope} ran into an unexpected error", { scope })
    : t("Something went wrong");

  const reloadPage = () => {
    if (typeof window !== "undefined" && window.location?.reload) {
      window.location.reload();
    }
  };

  return (
    <div className="error-boundary-fallback" role="alert">
      <div className="error-boundary-card">
        <div className="error-boundary-title">{title}</div>
        <p className="error-boundary-message">
          {error.message || t("An unexpected rendering error occurred.")}
        </p>
        <div className="error-boundary-actions">
          <button
            type="button"
            className="btn primary sm"
            onClick={resetErrorBoundary}
          >
            {t("Try again")}
          </button>
          <button
            type="button"
            className="btn ghost sm"
            onClick={reloadPage}
          >
            {t("Reload")}
          </button>
        </div>
      </div>
    </div>
  );
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(
      `[ErrorBoundary${this.props.scope ? `:${this.props.scope}` : ""}]`,
      error,
      info.componentStack,
    );
    this.props.onError?.(error, info);
  }

  override componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (
      this.state.error &&
      resetKeysChanged(prevProps.resetKeys, this.props.resetKeys)
    ) {
      this.resetErrorBoundary();
    }
  }

  resetErrorBoundary = (): void => {
    this.props.onReset?.();
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    const { children, fallback, scope } = this.props;
    if (!error) return children;
    if (typeof fallback === "function") {
      return fallback({
        error,
        resetErrorBoundary: this.resetErrorBoundary,
        scope,
      });
    }
    if (fallback !== undefined) {
      return fallback;
    }
    return (
      <ErrorBoundaryFallback
        error={error}
        resetErrorBoundary={this.resetErrorBoundary}
        scope={scope}
      />
    );
  }
}
