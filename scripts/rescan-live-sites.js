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
//   node --env-file=.env.local scripts/rescan-live-sites.js
//   node --env-file=.env.local scripts/rescan-live-sites.js --json
//   node --env-file=.env.local scripts/rescan-live-sites.js --unpublish
//
// Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, the same two the
// app uses. Run it from the project root so node_modules resolves.
import { supabaseAdmin } from '../lib/supabase.js';
import { findHardBlock, offlineSummary } from '../lib/publish.js';

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--unpublish');
const AS_JSON = args.has('--json');
const PAGE = 200;

if (args.has('--help') || args.has('-h')) {
  console.log(`
Scan every live site for hard-block content.

  (no flags)    dry run -- report only, change nothing
  --json        machine-readable output
  --unpublish   ALSO take the failing sites offline (writes to the database)
  --help        this message
`.trim());
  process.exit(0);
}

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  console.error('Try: node --env-file=.env.local scripts/rescan-live-sites.js');
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

    const hit = findHardBlock(project.current_code);
    if (!hit) continue;

    findings.push({
      siteId: site.id,
      projectId: project.id,
      name: project.name || 'Untitled',
      email: ownerEmail(project),
      address: site.custom_domain || site.subdomain || '(no address)',
      ruleId: hit.id,
      block: hit.label,
      summary: offlineSummary(hit.id),
    });
  }

  if (AS_JSON) {
    console.log(JSON.stringify({ scanned, noCode, findings, applied: APPLY }, null, 2));
  } else {
    console.log(`Scanned ${scanned} live site${scanned === 1 ? '' : 's'}.`);
    if (noCode) console.log(`${noCode} of them are live with no built code.`);
    console.log('');

    if (findings.length === 0) {
      console.log('No hard blocks found. Every live site would pass the screen today.');
    } else {
      console.log(`${findings.length} site${findings.length === 1 ? '' : 's'} would fail the screen:\n`);
      for (const f of findings) {
        console.log(`  ${f.name}`);
        console.log(`    owner    ${f.email}`);
        console.log(`    address  ${f.address}`);
        console.log(`    problem  ${f.block}  [${f.ruleId}]`);
        console.log(`    project  ${f.projectId}`);
        console.log('');
      }
    }
  }

  if (!APPLY) {
    if (findings.length) {
      console.log('Dry run -- nothing was changed.');
      console.log('Re-run with --unpublish to take these offline.');
    }
    return;
  }

  // Same write screenLiveSite() makes, so a site taken down here is
  // indistinguishable from one taken down by an edit -- including the
  // dashboard reading "Needs attention" and the reason behind it.
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
