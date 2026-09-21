// One-off audit: run the hard-block screen over every currently
// published site.
//
// screenLiveSite() has only ever run on a new publish or an edit, so a
// site published before a rule existed has never been checked against
// it. This answers "what is live right now that would not pass today?"
//
// DRY RUN BY DEFAULT -- it reads and reports, and changes nothing.
// Nothing here writes unless you pass --unpublish, and even then it
// only sets the same status and reason screenLiveSite would.
//
// Usage (Node 20.6+, for --env-file):
//   node --env-file=.env.local scripts/rescan-live-sites.mjs
//   node --env-file=.env.local scripts/rescan-live-sites.mjs --json
//   node --env-file=.env.local scripts/rescan-live-sites.mjs --json --host=www.youtube.com
//   node --env-file=.env.local scripts/rescan-live-sites.mjs --unpublish
//
// Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, the same two the
// app uses. Run it from the project root so node_modules resolves.
import { supabaseAdmin } from '../lib/supabase.js';
import { findHardBlock, hardBlockHost, normalizeEmbeds, offlineSummary } from '../lib/publish.js';

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--unpublish');
// Rules not yet trusted on the publish path. Read-only by design: see
// the refusal further down that stops --experimental combining with
// --unpublish.
const EXPERIMENTAL = args.has('--experimental');
const AS_JSON = args.has('--json');
// --host=example.com narrows the report to findings whose matched URL is on
// that host (or a subdomain of it), for counting one provider across the
// estate. Reporting only -- see the refusal below.
const HOST_ARG = process.argv.slice(2).find((a) => a.startsWith('--host='));
const HOST = HOST_ARG ? HOST_ARG.slice('--host='.length).trim().toLowerCase() : null;
const PAGE = 200;

if (args.has('--help') || args.has('-h')) {
  console.log(`
Scan every live site for hard-block content.

  (no flags)    dry run -- report only, change nothing
  --json        machine-readable output
  --host=HOST   report only findings whose matched URL is on HOST
                (or a subdomain of it); cannot be combined with --unpublish
  --experimental also apply rules not yet live on the publish path
  --unpublish   ALSO take the failing sites offline (writes to the database)
  --help        this message
`.trim());
  process.exit(0);
}

// A filter that narrowed a destructive write would be a footgun: the same
// flag that answers "how many use this provider?" would also mean "take
// exactly those offline". Counting and unpublishing stay separate.
if (HOST && APPLY) {
  console.error('Refusing to --unpublish with --host set.');
  console.error('--host narrows the report only. Drop it to apply to every finding.');
  process.exit(1);
}

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  console.error('Try: node --env-file=.env.local scripts/rescan-live-sites.mjs');
  process.exit(1);
}

const admin = supabaseAdmin();

// Sites, their project (for the name and the code) and the owner's
// email in one read. current_code is large, so this pages rather than
// pulling every site's HTML into memory at once.
async function* liveSites() {
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await admin
      .from('sites')
      .select('id, subdomain, custom_domain, status, offline_reason, projects(id, name, current_code, profiles(email))')
      .eq('status', 'live')
      .order('id', { ascending: true })
      .range(offset, offset + PAGE - 1);

    if (error) throw new Error(`could not read sites: ${error.message}`);
    if (!data || data.length === 0) return;

    for (const row of data) yield row;
    if (data.length < PAGE) return;
  }
}

function ownerEmail(project) {
  const p = project?.profiles;
  const profile = Array.isArray(p) ? p[0] : p;
  return profile?.email || '(unknown)';
}

async function main() {
  const findings = [];
  let scanned = 0;
  let noCode = 0;

  for await (const site of liveSites()) {
    const project = Array.isArray(site.projects) ? site.projects[0] : site.projects;
    scanned++;

    if (!project?.current_code) {
      // Live with nothing to serve. Not a block, but worth knowing.
      noCode++;
      continue;
    }

    // Normalised first, so this judges a site exactly as publish does.
    // Without it a YouTube embed that publishes fine today would be
    // reported here as failing -- and --unpublish would take it down.
    const hit = findHardBlock(normalizeEmbeds(project.current_code), { experimental: EXPERIMENTAL });
    if (!hit) continue;

    findings.push({
      siteId: site.id,
      projectId: project.id,
      name: project.name || 'Untitled',
      email: ownerEmail(project),
      address: site.custom_domain || site.subdomain || '(no address)',
      ruleId: hit.id,
      block: hit.label,
      // Rules with their own matcher report what they matched -- for the
      // inline-request rule that is the URL, which is the whole story.
      detail: hit.detail || null,
      host: hardBlockHost(hit),
      summary: offlineSummary(hit.id),
    });
  }

  // --host narrows what is REPORTED, never what is written. The refusal at
  // the top of the file keeps it away from --unpublish, which always acts
  // on the full findings list.
  const onHost = (f) => !HOST || (!!f.host && (f.host === HOST || f.host.endsWith('.' + HOST)));
  const reported = findings.filter(onHost);

  if (AS_JSON) {
    console.log(JSON.stringify({
      scanned, noCode, hostFilter: HOST, matched: reported.length,
      findings: reported, applied: APPLY,
    }, null, 2));
  } else {
    console.log(`Scanned ${scanned} live site${scanned === 1 ? '' : 's'}.`);
    if (noCode) console.log(`${noCode} of them are live with no built code.`);
    if (HOST) console.log(`Filtered to ${HOST} (${findings.length} finding(s) in total).`);
    console.log('');

    if (reported.length === 0) {
      console.log(HOST
        ? `No live site has a hard block on ${HOST}.`
        : 'No hard blocks found. Every live site would pass the screen today.');
    } else {
      console.log(`${reported.length} site${reported.length === 1 ? '' : 's'} would fail the screen:\n`);
      for (const f of reported) {
        console.log(`  ${f.name}`);
        console.log(`    owner    ${f.email}`);
        console.log(`    address  ${f.address}`);
        console.log(`    problem  ${f.block}  [${f.ruleId}]`);
        if (f.detail) console.log(`    matched  ${f.detail}`);
        console.log(`    project  ${f.projectId}`);
        console.log('');
      }
    }
  }

  if (!APPLY) {
    if (reported.length) {
      console.log('Dry run -- nothing was changed.');
      console.log('Re-run with --unpublish to take these offline.');
    }
    return;
  }

  // Same write screenLiveSite() makes, so a site taken down here is
  // indistinguishable from one taken down by an edit -- including the
  // dashboard reading "Needs attention" and the reason behind it.
  // An unproven rule must never be the thing that takes a customer's
  // site offline. Audit with --experimental, promote the rule once the
  // findings look right, then apply.
  if (EXPERIMENTAL) {
    console.error('Refusing to --unpublish while --experimental is on.');
    console.error('Audit first, promote the rule out of experimental, then apply.');
    process.exit(1);
  }

  console.log(`Unpublishing ${findings.length} site(s)…`);
  let done = 0;
  for (const f of findings) {
    const { error } = await admin
      .from('sites')
      .update({ status: 'draft', offline_reason: f.ruleId, offline_at: new Date().toISOString() })
      .eq('id', f.siteId);

    if (error) console.error(`  FAILED ${f.name}: ${error.message}`);
    else { done++; console.log(`  offline: ${f.name}`); }
  }
  console.log(`\n${done} of ${findings.length} taken offline.`);
  console.log('Note: their owners are NOT told by this script -- the chat message only');
  console.log('fires on an edit. Contact them, or they will find out from the dashboard.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
