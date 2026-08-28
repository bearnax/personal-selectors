/**
 * Turn the data source into a bundled TypeScript module.
 *
 * The source of truth is Airtable, but this script falls back to a local
 * CSV if no API keys are present.
 *
 *   node scripts/build-weapons.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

try {
  const envContent = readFileSync('.env', 'utf8');
  for (const line of envContent.split('\n')) {
    const match = line.trim().match(/^([^=]+)=(.*)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^['"](.*)['"]$/, '$1');
    }
  }
} catch (e) {
  // Ignore if .env doesn't exist
}

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(here, 'weapons-source.csv');
const OUT = join(here, '..', 'src', 'eldenring', 'weapons.ts');

/** Minimal RFC4180 reader: quoted fields with embedded commas, nothing else. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

async function loadAirtableData(tableName) {
  const apiKey = process.env.AIRTABLE_API_KEY;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!apiKey || !baseId) return null;

  console.log(`Fetching ${tableName} from Airtable...`);
  const allRecords = [];
  let offset = undefined;

  do {
    let url = `https://api.airtable.com/v0/${baseId}/${tableName}`;
    if (offset) {
      url += `?offset=${offset}`;
    }

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!res.ok) {
      throw new Error(`Airtable API HTTP ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    allRecords.push(...data.records.map(r => r.fields));
    offset = data.offset;
  } while (offset);

  return allRecords;
}

async function loadData() {
  const airtableData = await loadAirtableData('Weapons');
  if (airtableData) return airtableData;

  console.warn(`Missing AIRTABLE_API_KEY or AIRTABLE_BASE_ID. Falling back to local ${SOURCE}.`);
  const csvText = readFileSync(SOURCE, 'utf8');
  const rows = parseCsv(csvText);
  const header = rows.shift().map((h) => h.trim());
  
  return rows.map((row) => {
    const obj = {};
    for (let i = 0; i < header.length; i++) {
      obj[header[i]] = row[i];
    }
    return obj;
  });
}

/** Typos in the sheet that would otherwise split a category in two. */
const TYPE_FIXES = new Map([['Glinstone Staff', 'Glintstone Staff']]);

/**
 * The sheet's "Used" column, as a 0-5 familiarity score.
 */
const USED_SCORES = new Map([
  ['big time', 0],
  ['a good bit', 1],
  ['some', 2],
  ['a little bit', 3],
  ['not really, no', 5],
  ['', 5],
]);

const records = await loadData();
const weapons = [];
const unknownUsed = new Set();

for (const row of records) {
  const name = (row['Name'] ?? '').toString().trim();
  if (!name) continue;

  const type = (row['Weapon Type'] ?? '').toString().trim();
  const usedText = (row['Used'] ?? '').toString().trim().toLowerCase();

  let familiarity = USED_SCORES.get(usedText);
  if (familiarity === undefined) {
    unknownUsed.add(usedText);
    familiarity = 5;
  }

  const rawWeight = row['Weight'];
  const raw = typeof rawWeight === 'number' ? rawWeight : Number((rawWeight ?? '').toString().trim());
  const weight = Number.isFinite(raw) && raw >= 0 && raw <= 5 ? raw : familiarity;

  const rawZone = row['earliest_zone'];
  const zoneRaw = typeof rawZone === 'number' ? rawZone : Number((rawZone ?? '').toString().trim());
  const zone = Number.isFinite(zoneRaw) && zoneRaw >= 1 && zoneRaw <= 9 ? zoneRaw : 1;

  let dlc = row['DLC?'];
  if (typeof dlc === 'string') {
    dlc = dlc.includes('✅');
  } else {
    dlc = !!dlc;
  }

  weapons.push({
    name,
    type: TYPE_FIXES.get(type) ?? type,
    dlc,
    familiarity: weight,
    earliest_zone: zone,
  });
}

weapons.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));

const types = [...new Set(weapons.map((w) => w.type))].sort();

/** Single-quoted TS string literal, escaped for the apostrophes in the names. */
const str = (value) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

const weaponLines = weapons
  .map(
    (w) =>
      `  { name: ${str(w.name)}, type: ${str(w.type)}, dlc: ${w.dlc}, familiarity: ${w.familiarity}, earliest_zone: ${w.earliest_zone} },`,
  )
  .join('\n');

const typeLines = types.map((t) => `  ${str(t)},`).join('\n');

const body = `/**
 * The armoury, generated from the spreadsheet/Airtable by \`scripts/build-weapons.mjs\`.
 *
 * Do not edit by hand.
 *
 * \`familiarity\` is 0-5 where 0 means "used big time" and 5 means "never really
 * touched it". It is the only opinion in this file; every weighting decision is
 * made from it at runtime.
 */

export interface Weapon {
  readonly name: string;
  readonly type: string;
  readonly dlc: boolean;
  readonly familiarity: number;
  readonly earliest_zone: number;
}

export const WEAPONS: readonly Weapon[] = [
${weaponLines}
];

/** Every distinct weapon type in the sheet, alphabetically. */
export const WEAPON_TYPES: readonly string[] = [
${typeLines}
];
`;

writeFileSync(OUT, body);

console.log(`wrote ${weapons.length} weapons across ${types.length} types -> ${OUT}`);
if (unknownUsed.size > 0) {
  console.log(`unrecognised "Used" values (defaulted to unused): ${[...unknownUsed].join(', ')}`);
}
