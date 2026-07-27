import fs from "node:fs/promises";
import zlib from "node:zlib";

const textDecoder = new TextDecoder("utf-8");
const textEncoder = new TextEncoder();
const sig = { local: 0x04034b50, central: 0x02014b50, eocd: 0x06054b50 };

function fail(message) { throw new Error(message); }
function u16(buf, at) { return buf.readUInt16LE(at); }
function u32(buf, at) { return buf.readUInt32LE(at); }
function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function parseZip(buffer) {
  const min = Math.max(0, buffer.length - 0xffff - 22);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (u32(buffer, i) === sig.eocd) { eocd = i; break; }
  }
  if (eocd < 0) fail("Not a supported XLSX ZIP file.");
  const count = u16(buffer, eocd + 10);
  const centralSize = u32(buffer, eocd + 12);
  const centralOffset = u32(buffer, eocd + 16);
  if (count === 0xffff || centralOffset === 0xffffffff) fail("ZIP64 workbooks are not supported.");
  const entries = [];
  let at = centralOffset;
  for (let i = 0; i < count; i += 1) {
    if (u32(buffer, at) !== sig.central) fail("Invalid central ZIP directory.");
    const nameLength = u16(buffer, at + 28);
    const extraLength = u16(buffer, at + 30);
    const commentLength = u16(buffer, at + 32);
    const end = at + 46 + nameLength + extraLength + commentLength;
    const rawCentral = Buffer.from(buffer.subarray(at, end));
    const name = textDecoder.decode(buffer.subarray(at + 46, at + 46 + nameLength));
    entries.push({
      name, rawCentral, flags: u16(buffer, at + 8), method: u16(buffer, at + 10),
      time: u16(buffer, at + 12), date: u16(buffer, at + 14), crc: u32(buffer, at + 16),
      compressedSize: u32(buffer, at + 20), size: u32(buffer, at + 24), localOffset: u32(buffer, at + 42),
    });
    at = end;
  }
  if (at !== centralOffset + centralSize) fail("Unexpected ZIP central-directory size.");
  entries.sort((a, b) => a.localOffset - b.localOffset);
  for (let i = 0; i < entries.length; i += 1) {
    entries[i].rawLocal = Buffer.from(buffer.subarray(entries[i].localOffset, i + 1 < entries.length ? entries[i + 1].localOffset : centralOffset));
  }
  return { entries, comment: Buffer.from(buffer.subarray(eocd + 22)), original: buffer };
}

function entryData(entry) {
  const raw = entry.rawLocal;
  if (u32(raw, 0) !== sig.local) fail(`Invalid local ZIP entry: ${entry.name}`);
  const nameLength = u16(raw, 26), extraLength = u16(raw, 28);
  const start = 30 + nameLength + extraLength;
  const compressed = raw.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(compressed);
  if (entry.method === 8) return zlib.inflateRawSync(compressed);
  fail(`Unsupported ZIP compression for ${entry.name}.`);
}

function rebuildZip(zip, replacements) {
  const chunks = [];
  let offset = 0;
  const updated = new Map();
  for (const entry of zip.entries) {
    const replacement = replacements.get(entry.name);
    if (!replacement) {
      chunks.push(entry.rawLocal);
      updated.set(entry.name, { ...entry, newOffset: offset, rawLocal: entry.rawLocal });
      offset += entry.rawLocal.length;
      continue;
    }
    const raw = entry.rawLocal;
    const nameLength = u16(raw, 26), extraLength = u16(raw, 28);
    const header = Buffer.from(raw.subarray(0, 30));
    const nameAndExtra = raw.subarray(30, 30 + nameLength + extraLength);
    const compressed = zlib.deflateRawSync(replacement);
    const flags = entry.flags & ~0x0008;
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc32(replacement), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(replacement.length, 22);
    const local = Buffer.concat([header, nameAndExtra, compressed]);
    chunks.push(local);
    updated.set(entry.name, {
      ...entry, flags, method: 8, crc: crc32(replacement), compressedSize: compressed.length,
      size: replacement.length, newOffset: offset, rawLocal: local,
    });
    offset += local.length;
  }
  const central = [];
  for (const entry of zip.entries) {
    const next = updated.get(entry.name);
    const raw = Buffer.from(entry.rawCentral);
    raw.writeUInt16LE(next.flags, 8);
    raw.writeUInt16LE(next.method, 10);
    raw.writeUInt32LE(next.crc, 16);
    raw.writeUInt32LE(next.compressedSize, 20);
    raw.writeUInt32LE(next.size, 24);
    raw.writeUInt32LE(next.newOffset, 42);
    central.push(raw);
  }
  const centralBuffer = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(sig.eocd, 0);
  eocd.writeUInt16LE(zip.entries.length, 8);
  eocd.writeUInt16LE(zip.entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(zip.comment.length, 20);
  return Buffer.concat([...chunks, centralBuffer, eocd, zip.comment]);
}

function xmlDecode(text = "") {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
function xmlEscape(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function attr(tag, name) {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
}
function columnOf(ref) { return ref.replace(/\d+/g, ""); }
function rowOf(ref) { return Number(ref.match(/\d+$/)?.[0]); }

function sharedStrings(zip) {
  const entry = zip.entries.find((item) => item.name === "xl/sharedStrings.xml");
  if (!entry) return [];
  const xml = textDecoder.decode(entryData(entry));
  return [...xml.matchAll(/<(?:[\w-]+:)?si\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?si>/g)].map((match) =>
    [...match[1].matchAll(/<(?:[\w-]+:)?t\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?t>/g)].map((t) => xmlDecode(t[1])).join(""));
}
function sheetPath(zip, sheetName) {
  const workbook = textDecoder.decode(entryData(zip.entries.find((item) => item.name === "xl/workbook.xml") ?? fail("Missing workbook.xml")));
  const rels = textDecoder.decode(entryData(zip.entries.find((item) => item.name === "xl/_rels/workbook.xml.rels") ?? fail("Missing workbook relationships")));
  const sheet = [...workbook.matchAll(/<(?:[\w-]+:)?sheet\b([^>]*)\/?>(?:<\/(?:[\w-]+:)?sheet>)?/g)].find((match) => xmlDecode(attr(match[1], "name") ?? "") === sheetName);
  if (!sheet) fail(`Sheet not found: ${sheetName}`);
  const relId = attr(sheet[1], "r:id");
  const relation = [...rels.matchAll(/<Relationship\b([^>]*)\/?>(?:<\/Relationship>)?/g)].find((match) => attr(match[1], "Id") === relId);
  if (!relation) fail(`Relationship not found for sheet: ${sheetName}`);
  const target = attr(relation[1], "Target");
  return `xl/${target.replace(/^\//, "").replace(/^xl\//, "")}`;
}
function parseCells(content, strings) {
  const cells = new Map();
  for (const match of content.matchAll(/<(?:[\w-]+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w-]+:)?c>)/g)) {
    const ref = attr(match[1], "r");
    if (!ref) continue;
    const type = attr(match[1], "t");
    const body = match[2] ?? "";
    let value = "";
    if (type === "s") value = strings[Number(/<(?:[\w-]+:)?v>([\s\S]*?)<\/(?:[\w-]+:)?v>/.exec(body)?.[1])] ?? "";
    else if (type === "inlineStr") value = [...body.matchAll(/<(?:[\w-]+:)?t\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?t>/g)].map((t) => xmlDecode(t[1])).join("");
    else value = xmlDecode(/<(?:[\w-]+:)?v>([\s\S]*?)<\/(?:[\w-]+:)?v>/.exec(body)?.[1] ?? "");
    cells.set(ref, value);
  }
  return cells;
}
const NAME_HEADER = "\u59d3\u540d";
const FEEDBACK_HEADER = "\u8003\u8bd5\u53cd\u9988";
const EXCLUDED_HEADERS = new Set([
  "\u5e8f\u53f7", "\u603b\u5206", "\u8003\u8bd5\u5206\u6570", FEEDBACK_HEADER, NAME_HEADER,
]);

function inspectWorkbook(buffer, sheetName) {
  const zip = parseZip(buffer);
  const strings = sharedStrings(zip);
  const path = sheetPath(zip, sheetName);
  const entry = zip.entries.find((item) => item.name === path);
  if (!entry) fail(`Worksheet XML not found: ${path}`);
  const xml = textDecoder.decode(entryData(entry));
  const rows = [];
  let headers = null, headerRow = null;
  for (const match of xml.matchAll(/<(?:[\w-]+:)?row\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?row>/g)) {
    const row = Number(attr(match[1], "r"));
    const cells = parseCells(match[2], strings);
    const values = Object.fromEntries([...cells.entries()].map(([ref, value]) => [columnOf(ref), value]));
    if (!headers && Object.values(values).includes(NAME_HEADER) && Object.values(values).includes(FEEDBACK_HEADER)) {
      headers = Object.fromEntries(Object.entries(values).map(([column, value]) => [value, column]));
      headerRow = row;
    } else if (headers && row > headerRow && values[headers[NAME_HEADER]]) {
      const scores = Object.fromEntries(Object.entries(headers)
        .filter(([header]) => !EXCLUDED_HEADERS.has(header))
        .map(([header, column]) => [header, values[column] ?? ""]));
      rows.push({ row, name: values[headers[NAME_HEADER]], scores, feedback: values[headers[FEEDBACK_HEADER]] ?? "" });
    }
  }
  if (!headers) fail("Required headers are missing.");
  const scoreHeaders = Object.keys(headers).filter((header) => !EXCLUDED_HEADERS.has(header));
  if (!scoreHeaders.length) fail("No question-type score columns were found.");
  return { zip, path, xml, headers, rows, scoreHeaders };
}
function patchSheet(xml, feedbackColumn, updates) {
  const byRow = new Map(updates.map((item) => [Number(item.row), String(item.text)]));
  const prefix = /<([\w-]+:)?worksheet\b/.exec(xml)?.[1] ?? "";
  const rowTag = `${prefix}row`, cellTag = `${prefix}c`, isTag = `${prefix}is`, textTag = `${prefix}t`;
  return xml.replace(new RegExp(`<${rowTag}\\b([^>]*)>([\\s\\S]*?)<\\/${rowTag}>`, "g"), (whole, rowAttrs, content) => {
    const row = Number(attr(rowAttrs, "r"));
    if (!byRow.has(row)) return whole;
    const ref = `${feedbackColumn}${row}`;
    const text = xmlEscape(byRow.get(row));
    let replaced = false;
    const next = content.replace(new RegExp(`<${cellTag}\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${cellTag}>)`, "g"), (cell, attrs) => {
      if (attr(attrs, "r") !== ref) return cell;
      replaced = true;
      const preserved = attrs.replace(/\s+t="[^"]*"/g, "");
      return `<${cellTag}${preserved} t="inlineStr"><${isTag}><${textTag}>${text}</${textTag}></${isTag}></${cellTag}>`;
    });
    if (replaced) return `<${rowTag}${rowAttrs}>${next}</${rowTag}>`;
    return `<${rowTag}${rowAttrs}>${next}<${cellTag} r="${ref}" t="inlineStr"><${isTag}><${textTag}>${text}</${textTag}></${isTag}></${cellTag}></${rowTag}>`;
  });
}
function verifyUnchanged(before, after, targetPath) {
  const left = parseZip(before), right = parseZip(after);
  for (const entry of left.entries) {
    if (entry.name === targetPath) continue;
    const comparison = right.entries.find((item) => item.name === entry.name);
    if (!comparison || !entry.rawLocal.equals(comparison.rawLocal)) fail(`Unexpected workbook part changed: ${entry.name}`);
  }
}
function layoutSignature(xml) {
  const cols = /<(?:[\w-]+:)?cols\b[\s\S]*?<\/(?:[\w-]+:)?cols>/.exec(xml)?.[0] ?? "";
  const rowTags = [...xml.matchAll(/<(?:[\w-]+:)?row\b[^>]*>/g)].map((match) => match[0]).join("");
  return `${cols}\n${rowTags}`;
}

const [mode, inputPath, sheetName, encodedUpdates] = process.argv.slice(2);
if (!mode || !inputPath || !sheetName) fail("Usage: patch_xlsx.mjs <inspect|write> <file.xlsx> <sheet> [base64-json-updates]");
const before = await fs.readFile(inputPath);
const inspected = inspectWorkbook(before, sheetName);
if (mode === "inspect") {
  console.log(JSON.stringify({ sheet: sheetName, feedbackColumn: inspected.headers[FEEDBACK_HEADER], scoreHeaders: inspected.scoreHeaders, rows: inspected.rows }));
} else if (mode === "write") {
  const updates = JSON.parse(Buffer.from(encodedUpdates ?? "", "base64url").toString("utf8"));
  if (!Array.isArray(updates) || updates.some((item) => !Number.isInteger(Number(item.row)) || typeof item.text !== "string")) fail("Updates must be an array of {row, text}.");
  const expectedRows = new Set(inspected.rows.map((item) => item.row));
  if (updates.some((item) => !expectedRows.has(Number(item.row)))) fail("An update targets a row outside the student table.");
  const changedXml = patchSheet(inspected.xml, inspected.headers[FEEDBACK_HEADER], updates);
  const after = rebuildZip(inspected.zip, new Map([[inspected.path, textEncoder.encode(changedXml)]]));
  verifyUnchanged(before, after, inspected.path);
  const verified = inspectWorkbook(after, sheetName);
  if (layoutSignature(inspected.xml) !== layoutSignature(verified.xml)) fail("Row heights or column definitions changed.");
  for (const update of updates) {
    const actual = verified.rows.find((item) => item.row === Number(update.row))?.feedback;
    if (actual !== update.text) fail(`Feedback verification failed at row ${update.row}.`);
  }
  await fs.writeFile(inputPath, after);
  console.log(JSON.stringify({ sheet: sheetName, writtenRows: updates.map((item) => Number(item.row)), feedbackColumn: inspected.headers[FEEDBACK_HEADER] }));
} else fail(`Unsupported mode: ${mode}`);
