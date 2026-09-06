// GET /api/cron/backup
//
// Daily full export of every table holding something we could not
// rebuild from scratch, written to a private Storage bucket as one
// gzipped JSON file per table under a date-stamped folder:
//
//   backups/2026-09-06/projects.json.gz
//
// Not user-facing -- only callable by the scheduler, via a Bearer token
// that must match CRON_SECRET, the same guard /api/cron/purge-trash uses.
//
// This is a logical export, not a point-in-time snapshot: tables are read
// one after another while the site keeps serving, so rows written mid-run
// may land in one file and not another. It is a safety net for "a row was
// deleted and we need it back", not a substitute for Supabase's own PITR.
import { supabaseAdmin } from '@/lib/supabase';
import zlib from 'zlib';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';       // zlib and Buffer
export const maxDuration = 300;        // large tables page slowly

const BUCKET = 'backups';
const BATCH = 1000;                    // rows per read
const RETAIN_DAYS = 30;

// Tables worth keeping, in the order a restore would want them: accounts
// first, then the work belonging to them, then what visitors left behind.
// Restoring in this order satisfies the foreign keys without deferring.
//
// Two names differ from what the dashboard calls them: `submissions` is
// "Enquiries" in the UI, and the per-day analytics rollup is `site_daily`.
// A site's HTML is on `projects.current_code`, with its history in
// `versions` -- `sites` itself only carries the domain and publish state.
//
// orderBy exists because pagination needs a stable sort, and site_daily
// has no id column -- its key is (site_id, day).
const TABLES = [
  { name: 'profiles',      orderBy: ['id'] },
  { name: 'subscriptions', orderBy: ['id'] },
  { name: 'projects',      orderBy: ['id'] },
  { name: 'versions',      orderBy: ['id'] },
  { name: 'sites',         orderBy: ['id'] },
  { name: 'submissions',   orderBy: ['id'] },
  { name: 'site_events',   orderBy: ['id'] },
  { name: 'site_daily',    orderBy: ['site_id', 'day'] },
  { name: 'audit_log',     orderBy: ['id'] },
];

const DATE_FOLDER_RE = /^\d{4}-\d{2}-\d{2}$/;

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ------------------------------------------------------------------
// gzip
// ------------------------------------------------------------------
// Rows are streamed into the compressor as they arrive rather than
// building one giant string first: site_events can run to hundreds of
// thousands of rows, and holding the whole JSON document and its
// gzipped copy in memory at once is how this route would die.

function gzipCollector() {
  const gz = zlib.createGzip({ level: 6 });
  const chunks = [];
  gz.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    gz.on('end', () => resolve(Buffer.concat(chunks)));
    gz.on('error', reject);
  });
  return { gz, done };
}

// Honours backpressure -- without the callback a big table would queue
// every row in memory, defeating the point of streaming.
function write(stream, str) {
  return new Promise((resolve, reject) => {
    stream.write(str, 'utf8', (err) => (err ? reject(err) : resolve()));
  });
}

// ------------------------------------------------------------------
// export one table
// ------------------------------------------------------------------
// Offset pagination over a stable sort. On a table being written to
// during the run (site_events, mainly) a row inserted behind the cursor
// can be missed -- acceptable for a nightly backup, and the alternative
// is keyset pagination that site_daily's composite key can't share.
async function exportTable(admin, table, orderBy) {
  const { gz, done } = gzipCollector();
  let rows = 0;

  try {
    await write(gz, '[\n');

    for (let offset = 0; ; offset += BATCH) {
      let query = admin.from(table).select('*');
      for (const col of orderBy) query = query.order(col, { ascending: true });

      const { data, error } = await query.range(offset, offset + BATCH - 1);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;

      for (const row of data) {
        await write(gz, (rows === 0 ? '' : ',\n') + JSON.stringify(row));
        rows++;
      }

      if (data.length < BATCH) break;
    }

    await write(gz, '\n]\n');
    gz.end();
  } catch (err) {
    gz.destroy();
    throw err;
  }

  return { buffer: await done, rows };
}

// ------------------------------------------------------------------
// storage
// ------------------------------------------------------------------

// Created private on first run rather than by hand, so the bucket cannot
// exist in a public state by accident. Creating an existing bucket is a
// harmless error we ignore.
async function ensureBucket(admin) {
  const { data, error } = await admin.storage.getBucket(BUCKET);
  if (data && !error) return;

  const { error: createError } = await admin.storage.createBucket(BUCKET, { public: false });
  // Another concurrent run may have won the race; that's fine.
  if (createError && !/exists/i.test(createError.message || '')) {
    throw new Error(`could not create the ${BUCKET} bucket: ${createError.message}`);
  }
}

async function upload(admin, path, buffer) {
  const { error } = await admin.storage.from(BUCKET).upload(path, buffer, {
    contentType: 'application/gzip',
    upsert: true, // a re-run the same day overwrites rather than failing
  });
  if (error) throw new Error(error.message);
}

// Storage has no "delete folder" -- objects go individually, so each old
// date folder is listed and its files removed.
async function pruneOldBackups(admin) {
  const cutoff = new Date(Date.now() - RETAIN_DAYS * 86400000).toISOString().slice(0, 10);

  const { data: folders, error } = await admin.storage.from(BUCKET).list('', { limit: 1000 });
  if (error) {
    console.error('[cron/backup] could not list backups for pruning', error);
    return { prunedFolders: 0, prunedFiles: 0 };
  }

  let prunedFolders = 0;
  let prunedFiles = 0;

  for (const entry of folders || []) {
    // A string compare is a date compare for YYYY-MM-DD.
    if (!DATE_FOLDER_RE.test(entry.name) || entry.name >= cutoff) continue;

    const { data: files, error: listError } = await admin.storage
      .from(BUCKET)
      .list(entry.name, { limit: 1000 });

    if (listError) {
      console.error('[cron/backup] could not list', entry.name, listError);
      continue;
    }
    if (!files || files.length === 0) continue;

    const paths = files.map((f) => `${entry.name}/${f.name}`);
    const { error: removeError } = await admin.storage.from(BUCKET).remove(paths);
    if (removeError) {
      console.error('[cron/backup] could not remove', entry.name, removeError);
      continue;
    }

    prunedFolders++;
    prunedFiles += paths.length;
  }

  return { prunedFolders, prunedFiles };
}

// ------------------------------------------------------------------

export async function GET(request) {
  const auth = request.headers.get('authorization') || '';
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: 'Not allowed' }, { status: 401 });
  }

  const admin = supabaseAdmin();
  const date = today();
  const startedAt = Date.now();

  try {
    await ensureBucket(admin);
  } catch (err) {
    console.error('[cron/backup] bucket unavailable', err);
    return Response.json({ error: String(err.message || err), date }, { status: 500 });
  }

  const tables = {};
  const failed = [];

  // One table's failure must not cost the other eight: each is caught,
  // named, and the run carries on. The 500 at the end is what surfaces
  // it in the Vercel log.
  for (const { name, orderBy } of TABLES) {
    try {
      const { buffer, rows } = await exportTable(admin, name, orderBy);
      await upload(admin, `${date}/${name}.json.gz`, buffer);
      tables[name] = { rows, bytes: buffer.length };
    } catch (err) {
      const message = String(err?.message || err);
      console.error(`[cron/backup] ${name} failed`, message);
      tables[name] = { error: message };
      failed.push(name);
    }
  }

  // Only prune behind a complete run. Deleting a 30-day-old backup on the
  // strength of a partial one is how you end up with neither.
  let pruned = { prunedFolders: 0, prunedFiles: 0, skipped: true };
  if (failed.length === 0) {
    pruned = { ...(await pruneOldBackups(admin)), skipped: false };
  }

  const body = {
    date,
    seconds: Math.round((Date.now() - startedAt) / 1000),
    tables,
    ...pruned,
  };

  if (failed.length) {
    return Response.json({ error: `Backup failed for: ${failed.join(', ')}`, failed, ...body }, { status: 500 });
  }

  return Response.json({ ok: true, ...body });
}
