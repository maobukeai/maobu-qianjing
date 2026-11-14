import { expect, test } from "bun:test";
import { createImportReceipt, ImportReceiptError } from "./import-receipt-data.ts";

const result = () => ({ ok: true, files: 2, profiles: 4, cookiesStripped: 3, skipped: 1, errors: [{ file: "export.json", id: "record_1", error: "PRIVATE_RAW_ERROR", quarantined: true }] });
test("import receipts keep only safe counts and fixed reasons, without raw import fields", () => {
  const value = result();
  Object.defineProperty(value, "profilesData", { enumerable: true, get() { throw new Error("Private data must not be read"); } });
  const receipt = createImportReceipt(value, 100);
  expect(receipt.files).toBe(2); expect(receipt.profiles).toBe(4); expect(receipt.cookiesStripped).toBe(3); expect(receipt.skipped).toBe(1);
  expect(receipt.proxyRepairReports).toBe(1); expect(receipt.issues).toEqual([{ file: "export.json", id: "record_1", reason: "proxy-repair", proxyRepairReported: true }]);
  expect(JSON.stringify(receipt)).not.toContain("PRIVATE"); expect(Object.isFrozen(receipt)).toBe(true); expect(Object.isFrozen(receipt.issues[0])).toBe(true);
  expect(createImportReceipt(result(), 100).id).not.toBe(receipt.id);
});

test("import receipt metadata strips paths and withholds unreadable or credential-like file names and IDs", () => {
  const receipt = createImportReceipt({ ...result(), errors: [
    { file: "C:\\Users\\PRIVATE_HOME\\读取.json", id: "safe-id", error: "invalid resolution: PRIVATE_RAW_DIMENSIONS" },
    { file: "authorization=PRIVATE_TOKEN.json", id: "http://person:PRIVATE_PASSWORD@host", error: "unrecognized PRIVATE_ERROR" },
    { file: "bad\u202e.csv", id: "../PRIVATE_PATH", error: "invalid timezone: PRIVATE_RAW_TIMEZONE" },
  ] });
  expect(receipt.issues.map(item => [item.file, item.id, item.reason])).toEqual([["读取.json", "safe-id", "screen"], [null, null, "source-record"], [null, null, "timezone"]]);
  expect(JSON.stringify(receipt)).not.toContain("PRIVATE");
});

test("every receipt counter requires a nonnegative safe integer and success requires explicit ok true", () => {
  for (const field of ["files", "profiles", "cookiesStripped", "skipped"]) for (const bad of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", undefined]) {
    expect(() => createImportReceipt({ ...result(), [field]: bad })).toThrow(ImportReceiptError);
  }
  for (const value of [null, [], {}, { ...result(), ok: "true" }, { ...result(), ok: false, error: "PRIVATE_ERROR" }]) {
    try { createImportReceipt(value); throw new Error("Must reject invalid/unconfirmed result"); }
    catch (error) { expect(error).toBeInstanceOf(ImportReceiptError); expect((error as Error).message).not.toContain("PRIVATE_ERROR"); }
  }
  expect(createImportReceipt({ ok: true, files: 0, profiles: 0, cookiesStripped: 0, skipped: 0, errors: [] }).issues).toEqual([]);
});

test("damaged issue structures and throwing fields use only a fixed invalid-result error", () => {
  for (const errors of [undefined, null, {}, [null], new Array(1), [{ file: "export.json", id: "id" }], [{ file: "export.json", id: 1, error: "private" }], [{ file: "export.json", id: "id", error: "private", quarantined: "true" }]]) {
    expect(() => createImportReceipt({ ...result(), errors })).toThrow("The import service returned incomplete results.");
  }
  const poisoned = { ...result(), get errors(): unknown { throw new Error("PRIVATE_GETTER"); } };
  expect(() => createImportReceipt(poisoned)).toThrow("The import service returned incomplete results.");
});

test("receipt allowlisted fields are captured once before validation and cannot change after being checked", () => {
  let idReads = 0, countReads = 0;
  const receipt = createImportReceipt({ ...result(), get profiles() { countReads++; return countReads === 1 ? 4 : "PRIVATE_AFTER_CHECK"; }, errors: [{ file: "export.csv", get id() { idReads++; return idReads === 1 ? "safe_id" : "http://person:PRIVATE_PASSWORD@host"; }, error: "unknown" }] });
  expect(receipt.profiles).toBe(4); expect(receipt.issues[0]?.id).toBe("safe_id"); expect(countReads).toBe(1); expect(idReads).toBe(1); expect(JSON.stringify(receipt)).not.toContain("PRIVATE");
});
