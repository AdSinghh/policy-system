const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const ExcelJS = require("exceljs");

/**
 * Yields spreadsheet rows as plain objects, from either CSV or XLSX.
 *
 * Both paths stream. Every import worker opens the file independently and reads
 * only its own stripe of rows, so memory stays flat regardless of file size and
 * regardless of how many workers are running.
 */

const XLSX_EXTENSIONS = new Set([".xlsx", ".xlsm"]);

/** ExcelJS hands back rich text, formula results and Dates as objects. */
function cellToPrimitive(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value;
  if (typeof value !== "object") return value;

  if (typeof value.text === "string") return value.text;
  if (value.result !== undefined) return cellToPrimitive(value.result);
  if (Array.isArray(value.richText)) {
    return value.richText.map((part) => part.text).join("");
  }
  if (typeof value.hyperlink === "string") return value.hyperlink;
  return String(value);
}

async function* readCsvRows(filePath) {
  const stream = fs.createReadStream(filePath).pipe(csv());
  for await (const row of stream) yield row;
}

async function* readXlsxRows(filePath) {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    entries: "emit",
    sharedStrings: "cache",
    hyperlinks: "ignore",
    styles: "ignore",
    worksheets: "emit",
  });

  let headers = null;

  for await (const worksheet of reader) {
    for await (const row of worksheet) {
      // row.values is 1-indexed with a leading hole.
      const cells = Array.isArray(row.values) ? row.values.slice(1) : [];

      if (!headers) {
        headers = cells.map((cell) => String(cellToPrimitive(cell)).trim());
        continue;
      }

      const record = {};
      headers.forEach((header, index) => {
        if (!header) return;
        record[header] = cellToPrimitive(cells[index]);
      });
      yield record;
    }
    // Only the first worksheet carries policy data.
    break;
  }
}

/**
 * @param {string} filePath  path on disk
 * @param {string} [originalName]  the client-supplied filename, which is where
 *   the real extension lives — multer stores uploads under a random hash.
 */
function readRows(filePath, originalName) {
  const extension = path.extname(originalName || filePath).toLowerCase();

  if (extension === ".xls") {
    throw new Error(
      "Legacy .xls is not supported. Re-save the workbook as .xlsx or export CSV.",
    );
  }

  return XLSX_EXTENSIONS.has(extension)
    ? readXlsxRows(filePath)
    : readCsvRows(filePath);
}

module.exports = { readRows, cellToPrimitive };
