# homebridge-git-backup

[![npm version](https://img.shields.io/npm/v/homebridge-git-backup.svg)](https://www.npmjs.com/package/homebridge-git-backup)
[![npm downloads](https://img.shields.io/npm/dt/homebridge-git-backup.svg)](https://www.npmjs.com/package/homebridge-git-backup)
[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://homebridge.io)
[![license](https://img.shields.io/npm/l/homebridge-git-backup.svg)](./LICENSE)

Homebridge plugin that backs up your Homebridge `config.json` to **any Git remote** — GitHub, Forgejo, Gitea, GitLab, Bitbucket, or a self-hosted git server — every time the config changes and on a schedule.

Built on [isomorphic-git](https://isomorphic-git.org), so it needs **no `git` binary** on the host. That matters for the official Homebridge Docker image, which doesn't ship `git`.

> Requires **Homebridge v2.0+** and **Node.js 22.12+ or 24+**.

## Features

- 🔁 **Automatic** — commits on startup, whenever `config.json` changes (debounced), and on a fixed schedule.
- 🌍 **Any provider** — anything that speaks Git-over-HTTPS, not just GitHub.
- 🧱 **Real commit history** — every change is a real commit you can diff and roll back, not a flat file overwrite.
- 🪶 **No `git` binary** — pure-JS Git via isomorphic-git; works in the slim Homebridge Docker image.
- 🔒 **Safe by default** — never force-pushes, so a diverged remote surfaces as a loud error rather than silent data loss.

## Why

The previous generation of "backup to GitHub" Homebridge plugins called the GitHub REST API directly. That meant:

- They only worked with GitHub.
- They wrote one file at a time via REST.
- The "backup" lost the commit graph — every backup was a flat file overwrite.

This plugin maintains a real Git working tree under Homebridge's storage directory, fast-forwards from the remote before each backup, commits the new config, and pushes via HTTPS. You get a full, diffable commit history of every Homebridge config change.

## Install

From the Homebridge UI: **Plugins → search "Git Backup" → Install**, then fill in the form.

Or from the command line:

```bash
npm install -g homebridge-git-backup
```

## Configure

Add a platform block to your Homebridge `config.json` (or use the Homebridge UI form):

```jsonc
{
  "platforms": [
    {
      "platform": "GitBackup",
      "name": "Git Backup",
      "repository_url": "https://github.com/you/homebridge-backups.git",
      "branch": "main",
      "git_username": "git",
      "git_token": "ghp_yourPersonalAccessToken",
      "file_path": "homebridge-config.json",
      "backup_interval": 1440,
      "commit_name": "Homebridge Git Backup",
      "commit_email": "homebridge@localhost"
    }
  ]
}
```

### Required fields

| Field | Description |
|---|---|
| `repository_url` | Full HTTPS clone URL of the backup repository |
| `git_token` | Personal Access Token, deploy key, or password for HTTPS auth |

### Provider-specific token setup

| Provider | `git_username` | `git_token` |
|---|---|---|
| GitHub | `git` (any string works) | [Personal Access Token (classic)](https://github.com/settings/tokens) with `repo` scope, or a fine-grained PAT with "Contents: Read and write" |
| Forgejo / Gitea | your Forgejo username | Access token from **Settings → Applications** with `write:repository` |
| GitLab | `oauth2` | Personal Access Token with `write_repository` scope |
| Bitbucket | your username | App password with "Repositories: Write" |
| Self-hosted (HTTP basic auth) | username | password |

> **Security tip:** create a backup-only repository and a token scoped to just that one repository. Don't reuse a token that has access to other repos.

### Optional fields

| Field | Default | Description |
|---|---|---|
| `branch` | `main` | Branch to push backups to |
| `file_path` | `homebridge-config.json` | Path within the repository where the config is stored. Subdirectories are created automatically. |
| `backup_interval` | `1440` (24h) | Scheduled backup cadence in minutes (minimum 5) |
| `commit_name` | `Homebridge Git Backup` | Author name on backup commits |
| `commit_email` | `homebridge@localhost` | Author email on backup commits |

## How it works

1. **On startup**, the plugin clones the target repository (single branch, full history) into `<homebridge-storage>/git-backup-workdir`. If the repository is empty or unreachable, it falls back to initializing a new local repo for the first push.
2. **On every Homebridge `config.json` change** (debounced 5s) and **on a schedule**, the plugin:
   - Fast-forwards the local working tree from the remote (so a backup from another instance doesn't get clobbered).
   - Copies the current `config.json` to the configured `file_path`.
   - Stages, commits, and pushes via HTTPS using the configured token.
   - If nothing changed, no commit is made — no empty-commit noise.
3. **On shutdown**, watchers and timers are released cleanly.

Backup runs are serialized — if a change arrives while a backup is in flight, it's coalesced and run once the current one finishes.

> **Note:** the plugin watches the *directory* containing `config.json`, not the file path itself. Homebridge and the Config UI save the config with an atomic write-then-rename, which swaps the file's inode; a watcher bound to the file path would go silent after the first save. Watching the directory makes change detection reliable on Linux (inotify), Docker, and macOS.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Nothing is backed up when I edit the config in the UI | Fixed in **1.0.1**. Earlier versions watched the config *file* and missed Homebridge's atomic saves. Update to ≥ 1.0.1. |
| `Backup failed … ReadObjectFail` on the first push | Fixed in **1.0.1** (the working tree was shallow-cloned, which breaks isomorphic-git's push to a repo that already has history). Update to ≥ 1.0.1. |
| `Backup failed … HttpError: … 401/403` | Authentication. Re-check `git_username`/`git_token` against the provider table above, and confirm the token has **write** access to the target repo. |
| `Backup failed … PushRejectedNonFastForward` | The remote has commits the plugin's working tree doesn't. The plugin never force-pushes. Use a single-writer backup repo, or delete `<storage>/git-backup-workdir` to re-clone. |
| Logs show `Clone failed … Initializing empty repo for first push` | Expected for a brand-new, empty backup repo. The first commit creates the branch on the remote. |

Set Homebridge's log level to debug (or run the plugin in a child bridge with verbose logging) to see per-trigger backup activity (`startup`, `config change`, `scheduled`).

## Compatibility

- **Homebridge:** v2.0 and later. The plugin is a service-only dynamic platform — it creates no HomeKit accessories and uses none of the HAP APIs that changed in Homebridge 2.0.
- **Node.js:** 22.12+ or 24+ (matches the Homebridge 2.0 baseline).

## Developing locally

```bash
git clone https://github.com/charlestephen/homebridge-git-backup.git
cd homebridge-git-backup
npm install
npm run build
npm link
```

Then in your Homebridge install: `npm link homebridge-git-backup` and restart Homebridge. Use `npm run watch` for incremental rebuilds while iterating.

## Changelog

### 1.0.1
- **Fixed:** config-change backups never firing — the watcher tracked the config *file*, which Homebridge replaces via atomic rename. It now watches the parent directory and filters by filename.
- **Fixed:** first push failing with `ReadObjectFail` on any repo with existing history — the working tree was shallow-cloned (`depth: 1`), which breaks isomorphic-git's push object negotiation ([isomorphic-git#682](https://github.com/isomorphic-git/isomorphic-git/issues/682)). Clones are now full-history (single branch).
- **Changed:** fast-forward now uses the dedicated `git.fastForward()` (no merge commits, no author needed).
- **Changed:** `engines.node` aligned to Homebridge 2.0's baseline (`^22.12.0 || ^24.0.0`).

### 1.0.0
- Initial release.

## License

MIT — see [LICENSE](./LICENSE).
