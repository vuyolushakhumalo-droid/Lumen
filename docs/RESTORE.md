# Restoring from a backup

Every night at 02:00 UTC the site copies its database into private storage.
This guide walks through getting one customer's site back after it was
deleted by mistake.

You need access to the Supabase dashboard. You do not need to be a developer,
but **you are editing the live database** — read a step fully before running it.

---

## 1. Find the backup

1. Open the Supabase dashboard and pick the Lintel project.
2. In the left sidebar click **Storage**.
3. Open the bucket called **backups**.
4. You will see one folder per day, named like `2026-09-06`. Open the most
   recent day from *before* the thing went missing. If a site was deleted on
   Tuesday, use Monday's folder.

Inside each folder is one file per table:

| File | What's in it |
|---|---|
| `profiles.json.gz` | Customer accounts |
| `subscriptions.json.gz` | Who is on which plan |
| `projects.json.gz` | **The website's actual HTML** |
| `versions.json.gz` | Every earlier draft of that HTML |
| `sites.json.gz` | Domains and whether a site is published |
| `submissions.json.gz` | Enquiries sent through customer sites |
| `site_events.json.gz` | Raw page-view records |
| `site_daily.json.gz` | Daily visitor totals |
| `audit_log.json.gz` | Dated record of key events |

Backups are kept for **30 days**. Older folders are deleted automatically.

## 2. Download and open the files

Click a file, then **Download**. You will get a `.json.gz` file.

The `.gz` part means it is compressed. To open it:

- **Windows** — right-click, *Extract All*. If Windows won't open it, install
  [7-Zip](https://www.7-zip.org/), then right-click → *7-Zip* → *Extract Here*.
- **Mac** — double-click it. It unzips on its own.

You are left with a `.json` file. Open it in any text editor. It is a long
list of records inside `{ }` brackets, one per row.

For restoring a website you need **two** files: `projects.json` and
`sites.json`.

## 3. Find the right record

You are looking for the customer's site. Search the file (Ctrl+F / Cmd+F) for
something you know — the site name, or the customer's subdomain.

In `projects.json` each record looks roughly like this, though `current_code`
will be *very* long — it is the entire website:

```json
{
  "id": "8f21c0de-3b5a-4e77-9a10-2c4d5e6f7a8b",
  "user_id": "1a2b3c4d-...",
  "name": "Marta's Flowers",
  "current_code": "<!doctype html>… thousands of characters …",
  "preview_url": null,
  "created_at": "2026-04-02T09:14:22.104Z",
  "updated_at": "2026-08-30T16:02:55.881Z"
}
```

**Copy the whole record**, from its opening `{` to its closing `}` — not the
comma after it. Do the same for the matching record in `sites.json`: it is the
one whose `project_id` equals the `id` you just copied.

## 4. Put it back

1. In the Supabase sidebar click **SQL Editor**, then **New query**.
2. Type the SQL below, pasting your copied record where shown.
3. Click **Run**.

Restore the project first — the site record points at it and will be rejected
if the project isn't there yet.

```sql
-- 1. The website itself
insert into projects
select * from jsonb_populate_record(null::projects, $json$

PASTE THE PROJECTS RECORD HERE

$json$::jsonb)
on conflict (id) do nothing;
```

```sql
-- 2. Its domain and publish state
insert into sites
select * from jsonb_populate_record(null::sites, $json$

PASTE THE SITES RECORD HERE

$json$::jsonb)
on conflict (id) do nothing;
```

Keep the `$json$` markers exactly as written. They tell the database "the text
between these is data, not instructions", which is what lets you paste website
code containing quotes and apostrophes without breaking anything.

`on conflict (id) do nothing` means: if the record is somehow already there,
change nothing. Running these twice is safe.

## 5. Check it worked

Run this, replacing the id with the project id from step 3:

```sql
select p.name,
       length(p.current_code) as code_length,
       s.subdomain,
       s.status
from projects p
left join sites s on s.project_id = p.id
where p.id = '8f21c0de-3b5a-4e77-9a10-2c4d5e6f7a8b';
```

You should get one row back, with `code_length` in the thousands. Then open the
customer's site in a browser to confirm.

---

## If something looks wrong

**"insert or update violates foreign key constraint"** — the account that owns
this site is missing too. Restore it first from `profiles.json`, the record
whose `id` matches the project's `user_id`:

```sql
insert into profiles
select * from jsonb_populate_record(null::profiles, $json$

PASTE THE PROFILES RECORD HERE

$json$::jsonb)
on conflict (id) do nothing;
```

Then go back to step 4.

**The site is back but out of date** — the backup is from up to 24 hours before
the loss, so the last day of edits is not in it. Check `versions.json` for a
later draft: find records whose `project_id` matches, take the one with the
newest `created_at`, and copy its `code` value over the project's
`current_code`.

**Nothing matches your search** — try an older day's folder. If the site was
deleted more than 30 days ago the backups are gone; contact Supabase support
about point-in-time recovery instead.

**You are not sure** — stop and ask a developer. Nothing here is urgent enough
to risk making it worse, and the backup files are not going anywhere.
