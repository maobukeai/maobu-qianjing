import { expect, test } from "bun:test";
import { ProfileStore } from "./store.ts";
import { parseExport } from "./parse.ts";
import { handleUiRequest } from "./ui.ts";
import { createProfileFileUpdate } from "./web/profile-file-update.ts";
import { writeXlsx } from "./xlsx.ts";
import type { Launcher } from "./launcher.ts";

const REJECTED = { ok: false, updated: 0, skipped: 0, notFound: [], errors: [{ id: "", error: "update file could not be parsed" }] };
function store() {
  const data = new ProfileStore(":memory:");
  const base = parseExport("id=parse_one\nname=Original\ncookie=[]\nproxytype=http\nresolution=1280*720\n******************").profiles[0]!;
  data.upsertProfile(base); return data;
}
const formRequest = (body: FormData) => new Request("http://x/ui/api/profiles/update-file", { method: "POST", body });
const launch = {} as Launcher;

test("malformed multipart and non-multipart bodies return only the fixed pre-write refusal", async () => {
  for (const request of [new Request("http://x/ui/api/profiles/update-file", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=broken" }, body: "PRIVATE_BAD_MULTIPART" }),
    new Request("http://x/ui/api/profiles/update-file", { method: "POST", headers: { "content-type": "application/json" }, body: '{"PRIVATE_ACCOUNT":"PRIVATE_VALUE"}' })]) {
    const data = store(), before = data.getProfile("parse_one");
    const response = await handleUiRequest(request, launch, data); expect(response?.status).toBe(400); const body = await response!.json(); expect(body).toEqual(REJECTED);
    expect(JSON.stringify(body)).not.toContain("PRIVATE"); expect(data.getProfile("parse_one")).toEqual(before); data.close();
  }
});

test("a multipart request with no File is a fixed parse refusal rather than a misleading zero-update success", async () => {
  const data = store(), form = new FormData(); form.append("files", "PRIVATE_TEXT_INSTEAD_OF_FILE");
  const response = await handleUiRequest(formRequest(form), launch, data); expect(response?.status).toBe(400); expect(await response!.json()).toEqual(REJECTED); data.close();
});

test("a corrupt workbook after a valid file performs no profile read, edit, transaction or proxy lookup", async () => {
  const data = store(), getProfile = data.getProfile.bind(data), upsert = data.upsertProfiles.bind(data), before = getProfile("parse_one");
  let reads = 0, writes = 0, lookups = 0;
  data.getProfile = id => { reads++; return getProfile(id); };
  data.upsertProfiles = (...args) => { writes++; return upsert(...args); };
  const form = new FormData();
  form.append("files", new File(["id,name,proxy,proxytype\nparse_one,Would change,proxy.example:8080:u:PRIVATE_PROXY_PASSWORD,http"], "PRIVATE_VALID_FILE.csv"));
  form.append("files", new File(["PK PRIVATE_CORRUPT_WORKBOOK_ACCOUNT_CONTENT"], "PRIVATE_INVALID_FILE.xlsx"));
  const response = await handleUiRequest(formRequest(form), launch, data, { timezoneFetch: async () => { lookups++; throw new Error("Unexpected network"); } });
  expect(response?.status).toBe(400); const body = await response!.json(); expect(body).toEqual(REJECTED); expect(JSON.stringify(body)).not.toContain("PRIVATE");
  expect(reads).toBe(0); expect(writes).toBe(0); expect(lookups).toBe(0); expect(getProfile("parse_one")).toEqual(before); data.close();
});

test("valid CSV, TXT and XLSX remain accepted, including a legitimate header-only zero update", async () => {
  const data = store(), workbook = await writeXlsx(["id", "name"], [["parse_one", "Workbook saved"]]);
  const cases = [
    { file: new File(["id,name\n"], "header.csv"), updated: 0, name: "Original" },
    { file: new File(["id,name\nparse_one,CSV saved"], "edited.csv"), updated: 1, name: "CSV saved" },
    { file: new File(["id=parse_one\nname=TXT saved\n******************"], "edited.txt"), updated: 1, name: "TXT saved" },
    { file: new File([new Uint8Array(workbook)], "edited.xlsx"), updated: 1, name: "Workbook saved" },
  ];
  for (const item of cases) { const form = new FormData(); form.append("files", item.file); const response = await handleUiRequest(formRequest(form), launch, data); expect(response?.status).toBe(200); expect(await response!.json()).toEqual({ ok: true, updated: item.updated, skipped: 0, notFound: [], errors: [] }); expect(data.getProfile("parse_one")?.name).toBe(item.name); }
  data.close();
});

test("a write-stage failure remains HTTP500 and the client preserves an unknown outcome", async () => {
  const data = store(), before = data.getProfile("parse_one");
  data.upsertProfiles = () => { throw new Error("PRIVATE_DATABASE_WRITE_ERROR"); };
  let status = 0; const task = createProfileFileUpdate({ post: async file => { const form = new FormData(); form.append("files", file); const response = await handleUiRequest(formRequest(form), launch, data); if (!response) throw new Error("Missing route"); status = response.status; return response; } });
  task.selectFile(new File(["id,name\nparse_one,Write failure"], "edited.csv"));
  const result = await task.submit(); expect(status).toBe(500); expect(result?.latest).toMatchObject({ status: "unconfirmed", updated: null, issues: [] }); expect(JSON.stringify(result)).not.toContain("PRIVATE"); expect(data.getProfile("parse_one")).toEqual(before); data.close();
});

test("the real parse refusal becomes a file-level fixed reason, while near-matching raw text is never treated as a file-format code", async () => {
  const data = store(), task = createProfileFileUpdate({ post: async file => { const form = new FormData(); form.append("files", file); return (await handleUiRequest(formRequest(form), launch, data))!; } });
  task.selectFile(new File(["PK PRIVATE_CORRUPT_WORKBOOK"], "broken.xlsx"));
  const result = await task.submit(); expect(result?.latest).toMatchObject({ status: "rejected", updated: 0, issues: [{ id: null, reason: "file-format" }] }); expect(JSON.stringify(result)).not.toContain("PRIVATE");
  const other = createProfileFileUpdate({ post: async () => Response.json({ ...REJECTED, errors: [{ id: "", error: "update file could not be parsed: PRIVATE_RAW_LINE" }] }, { status: 400 }) });
  other.selectFile(new File(["id,name\n"], "header.csv")); expect((await other.submit())?.latest?.issues[0]?.reason).toBe("identifier"); data.close();
});
