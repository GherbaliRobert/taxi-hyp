#!/usr/bin/env node
// Copie de siguranță a bazei de date, sigură și cu serverul pornit.
//   npm run backup                       → data/backups/taxi-AAAA-LL-ZZ_HH-MM.db
//   npm run backup -- /cale/copie.db

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const source = process.env.DATABASE_FILE || path.join(__dirname, '..', 'data', 'taxi.db');
if (!fs.existsSync(source)) {
  console.error(`Baza de date ${source} nu există.`);
  process.exit(1);
}

const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
const target = process.argv[2] || path.join(path.dirname(source), 'backups', `taxi-${stamp}.db`);
fs.mkdirSync(path.dirname(target), { recursive: true });

const db = new Database(source, { readonly: true, fileMustExist: true });
db.backup(target)
  .then(() => console.log(`Copie salvată în ${target}`))
  .catch((err) => {
    console.error('Copia nu a reușit:', err.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
