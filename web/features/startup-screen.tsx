import { useId, type ReactNode } from "react";
import { AppIcon } from "../ui-primitives.tsx";
import { DesktopStartupBar, WindowActionError, type WindowChrome } from "../window-chrome.tsx";
import "./startup-screen.css";

interface StartupScreenProps {
  chrome: WindowChrome;
  brand: ReactNode;
  title: string;
  phase: "loading" | "failed" | "session";
  children?: ReactNode;
}

export function StartupScreen({ chrome, brand, title, phase, children }: StartupScreenProps) {
  const id = useId();
  return (
    <div className={`desktop-loading-shell${chrome.enabled ? " desktop-frameless" : ""}`}>
      <DesktopStartupBar chrome={chrome}>{brand}</DesktopStartupBar>
      <WindowActionError chrome={chrome} />
      <main className="onboarding startup-stage">
        <section className="onboarding-card startup-card" aria-labelledby={id} data-startup-phase={phase}>
          <div className="startup-heading" role={phase === "failed" ? "alert" : phase === "loading" ? "status" : undefined}>
            <span className="startup-icon">
              <AppIcon name={phase === "failed" ? "alert" : phase === "session" ? "lock" : "refresh"} />
            </span>
            <h1 id={id}>{title}</h1>
          </div>
          {children}
        </section>
      </main>
    </div>
  );
}
