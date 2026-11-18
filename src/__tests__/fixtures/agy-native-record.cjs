// Synthetic projection of the independently verified agy 1.2.7 SQLite/protobuf format.
const Database = require('libsql')
const { mkdirSync } = require('node:fs')
const { join } = require('node:path')
const { randomUUID } = require('node:crypto')
const varint = value => {
  let number = BigInt(value); const out = []
  while (number > 127n) { out.push(Number(number & 127n) | 128); number >>= 7n }
  return Buffer.from([...out, Number(number)])
}
const number = (field, value) => Buffer.concat([varint(field * 8), varint(value)])
const message = (field, value) => Buffer.concat([varint(field * 8 + 2), varint(value.length), value])
const string = (field, value) => message(field, Buffer.from(value))
const schema = `CREATE TABLE IF NOT EXISTS trajectory_meta(trajectory_id TEXT, cascade_id TEXT, trajectory_type INTEGER, source INTEGER);
CREATE TABLE IF NOT EXISTS steps(idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_format INTEGER, metadata BLOB, step_payload BLOB, error_details BLOB);
CREATE TABLE IF NOT EXISTS executor_metadata(idx INTEGER PRIMARY KEY, data BLOB);
CREATE TABLE IF NOT EXISTS gen_metadata(idx INTEGER PRIMARY KEY, data BLOB);`
function open(home, cid) {
  const directory = join(home, '.gemini', 'antigravity-cli', 'conversations')
  mkdirSync(directory, { recursive: true })
  const db = new Database(join(directory, cid + '.db'))
  db.exec(schema)
  let trajectory = db.prepare('SELECT trajectory_id FROM trajectory_meta').get()?.trajectory_id
  if (!trajectory) { trajectory = randomUUID(); db.prepare('INSERT INTO trajectory_meta VALUES(?,?,4,17)').run(trajectory, cid) }
  return { db, trajectory }
}
function metadata(cid, trajectory, idx, execution, at = Date.now()) {
  const timestamp = Buffer.concat([number(1, Math.floor(at / 1000)), number(2, Math.floor(at % 1000) * 1e6)])
  const source = Buffer.concat([string(1, trajectory), number(2, idx), number(3, 0), string(4, cid)])
  return Buffer.concat([message(1, timestamp), string(12, execution), message(20, source), message(8, timestamp)])
}
function put(db, cid, trajectory, idx, type, execution, inner, options = {}) {
  const meta = metadata(cid, trajectory, idx, execution, options.at)
  const status = options.status ?? 3
  const payload = Buffer.concat([number(1, type), number(4, status), message(5, meta), message(type === 14 ? 19 : 20, inner)])
  db.prepare('INSERT OR REPLACE INTO steps VALUES(?,?,?,?,?,?,?)').run(idx, type, status, 0, meta, payload, options.error ? Buffer.from(options.error) : null)
}
function input(home, cid, prompt) {
  const { db, trajectory } = open(home, cid)
  try {
    const idx = (db.prepare('SELECT max(idx) n FROM steps').get().n ?? -1) + 1
    const execution = randomUUID()
    put(db, cid, trajectory, idx, 14, execution, string(2, prompt))
    return { home, cid, trajectory, execution, inputIdx: idx }
  } finally { db.close() }
}
function answer(turn, text, options = {}) {
  const { db } = open(turn.home, turn.cid)
  try {
    const idx = (db.prepare('SELECT max(idx) n FROM steps').get().n ?? -1) + 1
    const inner = Buffer.concat([string(1, text), string(8, options.modified ?? text), ...(options.tool ? [message(7, Buffer.from([8, 1]))] : []), ...(options.thinking ? [string(3, options.thinking)] : [])])
    put(db, turn.cid, turn.trajectory, idx, 15, options.execution ?? turn.execution, inner, options)
    return idx
  } finally { db.close() }
}
module.exports = { schema, varint, number, message, string, input, answer, open }
