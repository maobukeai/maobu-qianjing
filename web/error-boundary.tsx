import React, { useId, useLayoutEffect, useRef, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "./i18n.tsx";
import { AppIcon } from "./ui-primitives.tsx";
import "./error-boundary.css";

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
  resetErrorBoundary,
  scope,
}: ErrorBoundaryFallbackProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const reloadNoteId = `${titleId}-reload-note`;
  const retry = useRef<HTMLButtonElement>(null);
  const title = scope
    ? t("Could not open {scope}", { scope: t(scope) })
    : t("Something went wrong");

  useLayoutEffect(() => {
    const button = retry.current;
    if (!button) return;
    const { activeElement, body, documentElement } = button.ownerDocument;
    if (!activeElement || activeElement === body || activeElement === documentElement) button.focus();
  }, []);

  const reloadPage = () => {
    if (typeof window !== "undefined" && window.location?.reload) {
      window.location.reload();
    }
  };

  return (
    <section className="error-boundary-fallback" aria-labelledby={titleId}>
      <div className="error-boundary-card">
        <div className="error-boundary-heading" role="alert">
          <span className="error-boundary-icon"><AppIcon name="warning" /></span>
          <div>
            <h2 id={titleId} className="error-boundary-title">{title}</h2>
            <p id={reloadNoteId} className="error-boundary-message">{t("Reloading may discard unsaved changes.")}</p>
          </div>
        </div>
        <div className="error-boundary-actions">
          <button
            ref={retry}
            type="button"
            className="btn primary"
            onClick={resetErrorBoundary}
          >
            {t("Try again")}
          </button>
          <button
            type="button"
            className="btn ghost"
            aria-describedby={reloadNoteId}
            onClick={reloadPage}
          >
            {t("Reload")}
          </button>
        </div>
      </div>
    </section>
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
