/**
 * CSV minimo para importar y exportar el menu (Excel en espanol guarda con coma o con punto y coma).
 * Soporta comillas, comillas dobles escapadas, saltos de linea dentro de comillas, BOM y CRLF.
 */

export type Delimiter = "," | ";" | "\t";

/** Detecta el separador por la primera linea (fuera de comillas). Si empata, la coma. */
function detectDelimiter(text: string): Delimiter {
  const counts: Record<Delimiter, number> = { ",": 0, ";": 0, "\t": 0 };
  let inQuotes = false;
  for (const ch of text) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === "\n" || ch === "\r")) break;
    else if (!inQuotes && ch in counts) counts[ch as Delimiter]++;
  }
  if (counts[";"] > counts[","] && counts[";"] >= counts["\t"]) return ";";
  if (counts["\t"] > counts[","]) return "\t";
  return ",";
}

export function parseCsv(input: string): { rows: string[][]; delimiter: Delimiter } {
  const text = input.replace(/^﻿/, "");
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  const endCell = () => {
    row.push(cell);
    cell = "";
  };
  const endRow = () => {
    endCell();
    // Se ignoran los renglones totalmente vacios.
    if (row.some((c) => c.trim() !== "")) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") inQuotes = true;
    else if (ch === delimiter) endCell();
    else if (ch === "\n") endRow();
    else if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      endRow();
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) endRow();
  return { rows, delimiter };
}

/** Celdas que Excel interpretaria como formula (=, +, -, @): se antepone un apostrofo para que sean texto. */
const guard = (v: string) => (/^[=+\-@]/.test(v) ? `'${v}` : v);

export function toCsv(rows: string[][], delimiter: Delimiter = ","): string {
  const cell = (raw: string) => {
    const v = guard(raw);
    return v.includes(delimiter) || /["\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  // BOM al inicio: Excel abre bien los acentos.
  return "﻿" + rows.map((r) => r.map(cell).join(delimiter)).join("\r\n") + "\r\n";
}

/** Quita el apostrofo que antepone toCsv para que un archivo exportado se pueda volver a importar igual. */
export const unguard = (v: string): string => (/^'[=+\-@]/.test(v) ? v.slice(1) : v);

/**
 * "85", "$85.50", "$ 1,250.00", "85,50" → centavos. null si no es un precio valido (negativo, texto, vacio).
 * Con ";" como separador, la coma es el decimal ("85,50"); con coma como separador no puede venir sin comillas.
 */
export function parsePriceToCents(raw: string): number | null {
  const s = raw.replace(/[\s$]|mxn|pesos?/gi, "");
  if (!s || !/^\d[\d.,]*$/.test(s)) return null;
  let n: string;
  if (s.includes(",") && s.includes(".")) {
    // El ultimo signo es el decimal; el otro separa miles.
    const decimal = s.lastIndexOf(",") > s.lastIndexOf(".") ? "," : ".";
    const thousands = decimal === "," ? "." : ",";
    n = s.split(thousands).join("").replace(decimal, ".");
  } else if (s.includes(",")) {
    // "1,250" (miles) o "85,50" (decimal): tres digitos tras la coma = miles.
    n = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, "") : s.replace(",", ".");
  } else n = s;
  const value = Number(n);
  if (!Number.isFinite(value) || value < 0) return null;
  const cents = Math.round(value * 100);
  return cents <= 10_000_000 ? cents : null; // tope: 100,000 pesos
}
