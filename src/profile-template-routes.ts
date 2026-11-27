/** Called only after the settings route's same-origin/header/JSON and bounded-body guards. */
import { isProfileTemplateId, parseProfileTemplateSettings, previewProfileTemplate, ProfileTemplateError, type ProfileTemplateInput, type ProfileTemplateStore } from "./profile-templates.ts";

const PREFIX = "/ui/api/settings/templates";
function json(value: unknown, status = 200): Response { return Response.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }); }
function input(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new ProfileTemplateError("invalid-input");
  return value as Record<string, unknown>;
}
/** No network, browser launch, profile reads or profile mutation occur in these routes. */
export function handleProfileTemplateRequest(pathname: string, method: string, body: unknown, store: ProfileTemplateStore): Response | null {
  if (![PREFIX, PREFIX + "/delete", PREFIX + "/preview"].includes(pathname)) return null;
  try {
    if (pathname === PREFIX && method === "GET") return json({ ok: true, catalog: store.read() });
    if (method !== "POST") return json({ ok: false, code: "method-not-allowed", error: "Method not allowed" }, 405);
    if (pathname === PREFIX) {
      const value = input(body, ["revision", "id", "name", "settings"]);
      const template: ProfileTemplateInput = { name: value.name as string, settings: parseProfileTemplateSettings(value.settings), ...(value.id === undefined ? {} : { id: value.id as string }) };
      return json({ ok: true, catalog: store.save(template, value.revision as number) });
    }
    if (pathname === PREFIX + "/delete") {
      const value = input(body, ["revision", "id"]);
      return json({ ok: true, catalog: store.remove(value.id as string, value.revision as number) });
    }
    const value = input(body, ["id", "settings"]);
    if (!isProfileTemplateId(value.id)) throw new ProfileTemplateError("invalid-input");
    const current = parseProfileTemplateSettings(value.settings), template = store.read().templates.find(template => template.id === value.id);
    if (!template) throw new ProfileTemplateError("not-found");
    return json({ ok: true, preview: previewProfileTemplate(template, current) });
  } catch (error) {
    const failure = error instanceof ProfileTemplateError ? error : new ProfileTemplateError("storage-error");
    return json({ ok: false, code: failure.code, error: failure.message }, failure.status);
  }
}
