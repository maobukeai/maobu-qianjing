import { parse } from "csv-parse/sync";
import type { ProxyReplacementRequestRow } from "../contracts/local.ts";

const CSV_PROXY_COLUMNS = ["type", "host", "port", "user", "pass"] as const;
const CSV_SELECTORS = ["profileId", "username"] as const;

export class ProxyReplacementInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProxyReplacementInputError";
  }
}

function inputError(message: string): never { throw new ProxyReplacementInputError(message); }

export function parseProxyReplacementCsv(csv: string): ProxyReplacementRequestRow[] {
  let records: string[][];
  try {
    records = parse(csv, {
      bom: true,
      relax_column_count: false,
      skip_empty_lines: true,
    }) as string[][];
  } catch {
    inputError("CSV input is invalid");
  }
  if (records.length < 2) inputError("CSV input must contain a header and at least one row");

  const headers = records[0]!.map((header) => header.trim());
  if (headers.some((header) => !header) || new Set(headers).size !== headers.length) {
    inputError("CSV headers must be unique and non-empty");
  }
  const selectors = CSV_SELECTORS.filter((selector) => headers.includes(selector));
  if (selectors.length !== 1) inputError("CSV must contain exactly one selector header: username or profileId");
  if (CSV_PROXY_COLUMNS.some((column) => !headers.includes(column))) {
    inputError("CSV must contain type, host, port, user, and pass headers");
  }
  const allowed = new Set<string>([...CSV_SELECTORS, ...CSV_PROXY_COLUMNS]);
  if (headers.some((header) => !allowed.has(header))) inputError("CSV contains an unsupported header");

  const selector = selectors[0]!;
  return records.slice(1).map((record) => {
    const values = Object.fromEntries(headers.map((header, index) => [header, record[index] ?? ""]));
    const replacement: Record<string, unknown> = {
      [selector]: values[selector]!,
      proxy: {
        type: values.type!,
        host: values.host!,
        port: values.port!,
        user: values.user!,
        pass: values.pass!,
      },
    };
    return replacement as unknown as ProxyReplacementRequestRow;
  });
}
