// data/db.js — JSON-Datenbank (kein npm install nötig!)
// Speichert alles in JSON-Dateien, gleiche execute()-API wie mysql2
import fs from "node:fs";

const DIR = "./data/jsondb";
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });

// ── Hilfsfunktionen ───────────────────────────────────────────
function read(table) {
    const fp = `${DIR}/${table}.json`;
    if (!fs.existsSync(fp)) return [];
    try { return JSON.parse(fs.readFileSync(fp, "utf8")); } catch { return []; }
}
function write(table, rows) {
    fs.writeFileSync(`${DIR}/${table}.json`, JSON.stringify(rows, null, 2));
}
function parseWhere(clause, params) {
    let i = 0;
    return clause.split(/\s+AND\s+/i).map(part => {
        const lt = part.match(/(\w+)\s*<\s*\?/);
        const eq = part.match(/(\w+)\s*=\s*\?/);
        if (lt) return { field: lt[1], op: "<", val: params[i++] };
        if (eq) return { field: eq[1], op: "=", val: params[i++] };
        return null;
    }).filter(Boolean);
}
function matches(row, conditions) {
    return conditions.every(c => {
        if (c.op === "=") return String(row[c.field]) === String(c.val);
        if (c.op === "<") return Number(row[c.field]) < Number(c.val);
        return false;
    });
}

// ── Haupt-DB-Objekt mit execute() ─────────────────────────────
const db = {
    execute(sql, params = []) {
        const s = sql.trim().replace(/\s+/g, " ");

        // CREATE TABLE → ignorieren (Dateien werden bei Bedarf erstellt)
        if (/^CREATE TABLE/i.test(s)) return [[], {}];

        // DELETE FROM table WHERE ...
        if (/^DELETE FROM (\w+) WHERE (.+)/i.test(s)) {
            const [, tbl, where] = s.match(/^DELETE FROM (\w+) WHERE (.+)/i);
            const conds = parseWhere(where, params);
            const rows  = read(tbl).filter(r => !matches(r, conds));
            write(tbl, rows);
            return [{ affectedRows: 1 }, {}];
        }

        // SELECT COUNT(*) as X FROM table
        if (/^SELECT COUNT\(\*\) as (\w+) FROM (\w+)/i.test(s)) {
            const [, alias, tbl] = s.match(/^SELECT COUNT\(\*\) as (\w+) FROM (\w+)/i);
            return [[{ [alias]: read(tbl).length }], {}];
        }

        // SELECT * FROM table WHERE ...
        if (/^SELECT \* FROM (\w+) WHERE (.+)/i.test(s)) {
            const [, tbl, where] = s.match(/^SELECT \* FROM (\w+) WHERE (.+)/i);
            const conds = parseWhere(where, params);
            return [read(tbl).filter(r => matches(r, conds)), {}];
        }

        // SELECT * FROM table (kein WHERE)
        if (/^SELECT \* FROM (\w+)$/i.test(s)) {
            const [, tbl] = s.match(/^SELECT \* FROM (\w+)$/i);
            return [read(tbl), {}];
        }

        // INSERT INTO table (cols...) VALUES (?)  [ON DUPLICATE KEY UPDATE]
        if (/^INSERT INTO (\w+)\s*\(([^)]+)\)/i.test(s)) {
            const [, tbl, colStr] = s.match(/^INSERT INTO (\w+)\s*\(([^)]+)\)/i);
            const cols  = colStr.split(",").map(c => c.trim());
            const rows  = read(tbl);
            const newRow = {};
            cols.forEach((c, i) => { newRow[c] = params[i]; });
            newRow.created_at = new Date().toISOString();

            const pk = cols[0]; // erster Spalte = Primärschlüssel
            const ix = rows.findIndex(r => String(r[pk]) === String(newRow[pk]));

            if (ix >= 0) {
                // ON DUPLICATE KEY UPDATE → mergen
                rows[ix] = { ...rows[ix], ...newRow, last_login: new Date().toISOString() };
            } else {
                rows.push(newRow);
            }

            write(tbl, rows);
            return [{ affectedRows: 1 }, {}];
        }

        console.warn("[DB] Unbekanntes SQL:", s.slice(0, 80));
        return [[], {}];
    }
};

console.log("✅ JSON-Datenbank bereit (Daten in data/jsondb/)");
export default db;
