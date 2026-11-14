export type FormChromiumRuntime = "" | "aliasmode" | "auto";

/** Preserve the legacy blank=CloakBrowser picker while giving templates a real Auto choice. */
export function profileCreationRuntime(engine: "chromium" | "firefox", selection: FormChromiumRuntime, hostRuntime?: "aliasmode"): "aliasmode" | "cloakbrowser" | undefined {
  if (engine === "firefox") return undefined;
  if (hostRuntime) return hostRuntime;
  return selection === "auto" ? undefined : selection || "cloakbrowser";
}
