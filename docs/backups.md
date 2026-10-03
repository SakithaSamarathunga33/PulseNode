# Scheduled backups and disaster recovery

PulseNode can back up **itself** (the panel: database, encryption key, session secret, `.env.local`)
and the **managed databases** it provisions, on a schedule, to a local folder and/or any
S3-compatible bucket (AWS S3, Backblaze B2, Cloudflare R2, Wasabi, MinIO, …).

Open **Backups** in the panel, or use the API (`/api/backups/...`).

## Concepts

| | |
|---|---|
| **Destination** | Where files go: *local* (a folder inside the panel's data directory) or *s3* (endpoint, bucket, prefix, access key, secret key). |
| **Schedule** | What and when: target `panel` or one managed database, frequency (hourly / daily at HH:00 / weekly on a weekday), how many copies to **keep**, which destinations, whether to notify on success. |
| **History** | One row per run, with size and the result **per destination**. |

Runs happen one at a time. A schedule that was due while the panel was down runs **once** after the
panel starts (never a burst). A run that is still going is never started twice. Times use the
server's local time zone.

### Retention

Each schedule keeps its newest **N** (default 7) successful copies **per destination** and deletes
older ones automatically. Failed rows older than 180 days (or beyond the newest 200) are trimmed; rows
that still point at a stored file are governed only by retention.

### Failures and notifications

A failed run (dump produced nothing, upload failed on any destination, passphrase missing, …) opens a
critical **`backup.failed`** alert — visible in *Alerts* and sent to your notification channels (Slack,
email, webhook, …) — once per schedule until a later run succeeds, which resolves it. "Notify on
success" additionally sends an informational message after each good run. A panel restart during a run
is *not* a failure: that run is recorded as interrupted and the schedule stays due.

## Destinations

* **Local** — default `<data dir>/backups/scheduled` (inside the `pn-go-data` volume). A custom
  folder must be inside the data directory, or inside a directory you mount into the `go-api` container
  and list in `PULSENODE_BACKUPS_EXTRA_DIRS` (colon separated). A local copy on the same disk does
  **not** protect against losing the server — add an off-site destination.
* **S3-compatible** — `endpoint` is `host[:port]` (a pasted `https://host` is accepted), `region` is
  optional, `pathStyle` is needed by MinIO and some others. Credentials are stored **encrypted** and are
  never returned by the API (only the last 4 characters of the access key). Changing the endpoint or
  bucket requires entering both keys again, so stored credentials can never be redirected to a new
  server.
* **Private addresses are blocked** (loopback, LAN, link-local, cloud metadata) to stop the panel being
  used as a proxy into your network. Running MinIO on your LAN or on the Docker network? Set
  `PULSENODE_BACKUPS_ALLOW_PRIVATE=true` in `.env.local` and restart.
* Use **Test** on a destination: it writes, reads back and deletes a tiny object.

## What is in a backup

### Panel backup (`panel-<time>.pnbak`)

An archive of: a consistent snapshot of the SQLite database (users, projects, encrypted secrets,
settings, destinations), `aes-key`, `jwt-secret`, `.env.local` (when the panel can read it — the
install directory is mounted at `/workspace`), and the scan/SBOM history. It also carries a manifest
with a SHA-256 of every file.

It is **always encrypted** with a passphrase **you** choose (*Backups → Passphrase*, ≥ 12 characters):
tar + gzip, then AES-256-GCM in 64 KiB authenticated chunks, key derived with scrypt (N = 2^15). The
passphrase is stored (encrypted) in the panel only so scheduled runs can use it.

> **Write the passphrase down somewhere that is not this server.** It cannot be recovered from the
> backup, and if the server is lost the panel's own copy is lost with it. Changing the passphrase does
> not re-encrypt old backups — those still need the old one.

Because the archive contains the encryption key, anyone with the file **and** the passphrase can read
every secret in your panel. Treat both like a root password.

### Managed database backups (`<container>-<time>.sql.gz[.enc]`)

A dump of one managed database (`pg_dump`, `mysqldump`, `mongodump --archive`, or the Redis RDB),
gzipped, and — if you leave **Encrypt** on (default) — encrypted with a key derived from the panel's
AES key. After dumping, the file is read back end to end (gzip checksum, encryption) and must look like
a dump of that engine; an empty or damaged dump fails the run instead of being uploaded.

An encrypted database backup can be restored by a panel that has the **same AES key** — which is exactly
what the panel backup carries. External (connected) databases are not covered.

### Restoring a database backup

*Backups → History → Restore* (or `POST /api/backups/history/{id}/restore {"confirm":"restore"}`).
This **overwrites the database's current data** and is refused while another backup or restore runs.

## Disaster recovery: rebuild the panel from a panel backup

You need: the `.pnbak` file (from a destination, or *Download* in the panel), your passphrase, and a
server with Docker.

1. **Install PulseNode** on the new server (`install.sh`, or `docker compose up` once so the volumes
   exist), then stop it: `docker compose down` (this keeps the volumes).
2. **Copy the backup and put the passphrase in a file** (kept out of shell history):

   ```bash
   mkdir -p /root/restore && cd /root/restore
   # copy panel-XXXX.pnbak here
   read -rs -p 'Passphrase: ' P && printf '%s' "$P" > pass && unset P
   ```

3. **Verify it** (decrypts and checks every checksum, writes nothing):

   ```bash
   cd /path/to/PulseNode   # the install directory
   docker compose run --rm --no-deps --entrypoint pulsenode \
     -v /root/restore:/restore go-api \
     verify-backup --file /restore/panel-XXXX.pnbak --passphrase-file /restore/pass
   ```

4. **Extract it** into a new folder (it refuses to overwrite existing files unless you add `--force`):

   ```bash
   docker compose run --rm --no-deps --entrypoint pulsenode \
     -v /root/restore:/restore go-api \
     restore-panel --file /restore/panel-XXXX.pnbak --passphrase-file /restore/pass --out /restore/out
   ```

   You now have `pulsenode.db`, `aes-key`, `jwt-secret`, `.env.local` (and the scan history) in
   `/root/restore/out`. These work **without** a running panel, on any machine with the `pulsenode`
   binary or image.
5. **Put the files in place.**
   * `.env.local` → the install directory (it holds `AES_KEY` / `JWT_SECRET`, which the panel prefers
     over the files below). If it was not in the archive, set `AES_KEY=<contents of aes-key>` and
     `JWT_SECRET=<contents of jwt-secret>` in your `.env.local`.
   * The database and key files go into the volumes (find their exact names with
     `docker volume ls | grep pn-`):

     ```bash
     docker run --rm -v <project>_pn-sqlite-data:/data -v /root/restore/out:/in alpine sh -c \
       'rm -f /data/pulsenode.db-wal /data/pulsenode.db-shm; cp /in/pulsenode.db /data/pulsenode.db'
     docker run --rm -v <project>_pn-go-data:/var/lib/pulsenode -v /root/restore/out:/in alpine sh -c \
       'cp /in/aes-key /in/jwt-secret /var/lib/pulsenode/ 2>/dev/null; cp /in/scans.json /in/sboms.json /var/lib/pulsenode/ 2>/dev/null; true'
     ```
6. `docker compose up -d`, then sign in with your **old** admin account. Projects, domains,
   destinations, schedules and notification channels are back; deployed apps are not (re-deploy them
   from the Projects page — their images and data volumes are separate from the panel).
7. Check *Backups → Status*, run a schedule once, and consider rotating secrets that lived on the old
   server.

**Why the AES key matters:** every stored secret (project env vars, GitHub tokens, destination
credentials, DB passwords) is encrypted with it. A database restored *without* its key cannot decrypt
them — the panel then refuses deploys with "cannot decrypt env: AES key mismatch" instead of passing
scrambled values to your apps. The panel backup always contains the matching key.

## Offline commands

```text
pulsenode verify-backup --file BACKUP.pnbak --passphrase-file FILE
pulsenode restore-panel --file BACKUP.pnbak --passphrase-file FILE --out DIR [--force]
```

`--passphrase-file -` reads the passphrase from standard input. Both exit non-zero on a wrong
passphrase, a damaged or truncated file, a hash mismatch, or (restore) an existing target file.

## API summary

All routes are under `/api/backups`, need a signed-in session, and return JSON (lists are plain
arrays, never `null`).

```text
GET/POST   destinations                 PATCH/DELETE destinations/{id}
POST       destinations/{id}/test       POST destinations/test        (draft; pass "id" to reuse stored keys)
GET/POST   schedules                    PATCH/DELETE schedules/{id}   POST schedules/{id}/run
GET        history?limit=&scheduleId=   GET history/{id}/download     DELETE history/{id}
POST       history/{id}/restore         (database backups only; body {"confirm":"restore"})
GET        status                       GET/POST passphrase
```

Every run, restore, download and destination change is written to the audit log.

## Limits

* Panel backups can only be restored offline (above), by design — restoring over a running panel would
  replace the database it is using.
* Database dumps run inside the database container; very large databases need enough free disk space
  in the panel's data volume for the temporary file during the run.
* Object stores are written with the standard S3 API; uploads larger than 5 GiB use multipart
  automatically but have not been tested against every provider.
