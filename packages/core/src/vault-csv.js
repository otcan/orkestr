// Minimal RFC 4180 CSV parser: quoted fields, escaped quotes, embedded
// commas/newlines, CRLF or LF line endings and a leading UTF-8 BOM.

function vaultError(code, statusCode = 400) {
  return Object.assign(new Error(code), { statusCode, code });
}

/**
 * @param {string} text
 * @param {{ maxRows?: number }} [options] maxRows counts data rows plus header
 * @returns {string[][]}
 */
export function parseCsv(text = "", { maxRows = Infinity } = {}) {
  const input = String(text || "").replace(/^﻿/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let index = 0;
  const endRow = () => {
    row.push(field);
    field = "";
    if (!(row.length === 1 && row[0] === "")) {
      rows.push(row);
      if (rows.length > maxRows) throw vaultError("vault_import_too_many_rows", 413);
    }
    row = [];
  };
  while (index < input.length) {
    const char = input[index];
    if (quoted) {
      if (char === "\"") {
        if (input[index + 1] === "\"") {
          field += "\"";
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === "\"" && field === "") {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\r" && input[index + 1] === "\n") {
      endRow();
      index += 1;
    } else if (char === "\n" || char === "\r") {
      endRow();
    } else {
      field += char;
    }
    index += 1;
  }
  if (quoted) throw vaultError("vault_import_csv_malformed");
  if (field !== "" || row.length) endRow();
  return rows;
}

/** Maps CSV rows to objects keyed by lower-cased, trimmed header names. */
export function csvRecords(rows = []) {
  const [header = [], ...data] = rows;
  const keys = header.map((name) => String(name || "").trim().toLowerCase());
  return {
    headers: keys,
    records: data.map((cells) => Object.fromEntries(keys.map((key, column) => [key, cells[column] ?? ""]))),
  };
}
