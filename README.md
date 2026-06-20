# homebridge-git-backup

[![npm version](https://img.shields.io/npm/v/homebridge-git-backup.svg)](https://www.npmjs.com/package/homebridge-git-backup)
[![npm downloads](https://img.shields.io/npm/dt/homebridge-git-backup.svg)](https://www.npmjs.com/package/homebridge-git-backup)
[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://homebridge.io)
[![license](https://img.shields.io/npm/l/homebridge-git-backup.svg)](./LICENSE)

Homebridge plugin that backs up your Homebridge `config.json` to **any Git remote** — GitHub, Forgejo, Gitea, GitLab, Bitbucket, or a self-hosted git server — every time the config changes and on a schedule.

Authenticate with **HTTPS + a Personal Access Token** (pure JavaScript via [isomorphic-git](https://isomorphic-git.org) — no `git` binary needed, ideal for the official Homebridge Docker image) **or SSH + a deployment key** (via the host's `git`/`ssh`).

> Requires **Homebridge v2.0+** and **Node.js 22.12+ or 24+**.

## Features

- 🔁 **Automatic** — commits on startup, whenever `config.json` changes (debounced), and on a fixed schedule.
- 🔐 **Two auth methods** — HTTPS Personal Access Token, or SSH deployment key.
- 🌍 **Any provider** — anything that speaks Git over HTTPS or SSH, not just GitHub.
- 🧱 **Real commit history** — every change is a real commit you can diff and roll back.
- 🪶 **No `git` binary for HTTPS** — pure-JS Git; works in the slim Homebridge Docker image.
- 🔒 **Safe by default** — never force-pushes, so a diverged remote surfaces as a loud error rather than silent data loss.

## Install

From the Homebridge UI: **Plugins → search "Git Backup" → Install**, then fill in the form.

Or from the command line:

```bash
npm install -g homebridge-git-backup
```

## Authentication

Pick **one** method with the `auth_method` setting.

| | `https` (default) | `ssh` |
|---|---|---|
| Credential | Personal Access Token / password | Deployment (SSH) private key |
| Repository URL | `https://host/you/repo.git` | `git@host:you/repo.git` |
| Git engine | isomorphic-git (pure JS) | system `git` + `ssh` |
| Needs `git` binary on host? | **No** | **Yes** |
| Works in official Homebridge Docker image? | **Yes** | No (image has no `git`/`ssh`) |

> **Use HTTPS** if you run the official Homebridge Docker image or want zero host dependencies. **Use SSH** if you prefer deployment keys and your host has `git` + `ssh` installed (most native installs, or a custom image).

### HTTPS — provider token setup

| Provider | `git_username` | `git_token` |
|---|---|---|
| GitHub | `git` (any string works) | [Personal Access Token (classic)](https://github.com/settings/tokens) with `repo` scope, or fine-grained PAT with "Contents: Read and write" |
| Forgejo / Gitea | your username | Access token (**Settings → Applications**) with `write:repository` |
| GitLab | `oauth2` | Personal Access Token with `write_repository` scope |
| Bitbucket | your username | App password with "Repositories: Write" |
| Self-hosted (HTTP basic) | username | password |

### SSH — deployment key setup

1. Generate a dedicated key (no passphrase, so it can run unattended):
   ```bash
   ssh-keygen -t ed25519 -f ~/backup_deploy_key -N "" -C "homebridge-git-backup"
   ```
2. Add the **public** key (`~/backup_deploy_key.pub`) to your repo as a **deploy key with write access** (GitHub: *Settings → Deploy keys*; Forgejo/Gitea: *Settings → Deploy Keys*; GitLab: *Settings → Repository → Deploy keys*).
3. Give the plugin the **private** key via **either**:
   - `ssh_key_path` — a path to the private key file on the host (**preferred**, keeps the key out of the backed-up config), or
   - `ssh_private_key` — the inline key contents (see the security note below).

> **Security note:** the plugin commits `config.json`, so any secret stored *in* `config.json` (an HTTPS `git_token`, or an inline `ssh_private_key`) ends up in the backup repo. Mitigate by using a **backup-only repository** with a **scoped token / dedicated deploy key**, and prefer `ssh_key_path` so the private key never enters `config.json`.

## Configure

### HTTPS example

```jsonc
{
  "platforms": [
    {
      "platform": "GitBackup",
      "name": "Git Backup",
      "auth_method": "https",
      "repository_url": "https://github.com/you/homebridge-backups.git",
      "branch": "main",
      "git_username": "git",
      "git_token": "ghp_yourPersonalAccessToken",
      "file_path": "homebridge-config.json",
      "backup_interval": 1440
    }
  ]
}
```

### SSH example

```jsonc
{
  "platforms": [
    {
      "platform": "GitBackup",
      "name": "Git Backup",
      "auth_method": "ssh",
      "repository_url": "git@github.com:you/homebridge-backups.git",
      "branch": "main",
      "ssh_key_path": "/var/lib/homebridge/.ssh/backup_deploy_key",
      "file_path": "homebridge-config.json",
      "backup_interval": 1440
    }
  ]
}
```

### Settings reference

| Field | Required | Default | Description |
|---|---|---|---|
| `repository_url` | ✅ | — | HTTPS or SSH clone URL of the backup repository |
| `auth_method` | | `https` | `https` or `ssh` |
| `branch` | | `main` | Branch to push backups to |
| `git_username` | https | `git` | Username for HTTPS auth |
| `git_token` | https | — | PAT/password for HTTPS auth |
| `ssh_key_path` | ssh* | — | Path to the private deploy key on the host |
| `ssh_private_key` | ssh* | — | Inline private key (alternative to `ssh_key_path`) |
| `file_path` | | `homebridge-config.json` | Path within the repo where the config is written |
| `backup_interval` | | `1440` (24h) | Scheduled cadence in minutes (minimum 5) |
| `commit_name` | | `Homebridge Git Backup` | Commit author name |
| `commit_email` | | `homebridge@localhost` | Commit author email |

\* SSH requires **one of** `ssh_key_path` or `ssh_private_key`.

## How it works

1. **On startup**, the plugin clones the target repository (single branch, full history) into `<homebridge-storage>/git-backup-workdir`. If the repository is empty or unreachable, it falls back to initializing a new local repo for the first push.
2. **On every Homebridge `config.json` change** (debounced 5s) and **on a schedule**, the plugin fast-forwards from the remote, copies the current `config.json` to `file_path`, then commits and pushes — only if something actually changed.
3. **On shutdown**, watchers and timers are released cleanly.

Backup runs are serialized; if a change arrives mid-backup it's coalesced and run once the current one finishes.

> **Note:** the plugin watches the *directory* containing `config.json`, not the file path itself. Homebridge saves the config with an atomic write-then-rename, which swaps the file's inode; a watcher bound to the file path would go silent after the first save. Watching the directory makes change detection reliable on Linux (inotify), Docker, and macOS.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `HTTPS auth requires "git_token"` / `SSH auth requires ...` | A required credential for the chosen `auth_method` is missing. |
| `SSH auth requires the "git" binary ...` | You chose SSH on a host without `git`/`ssh` (e.g. official Docker). Switch to HTTPS, or use an image that includes git + ssh. |
| `Backup failed … 401/403` (HTTPS) | Check `git_username`/`git_token` and that the token has **write** access. |
| `Backup failed … Permission denied (publickey)` (SSH) | The deploy key isn't authorized for the repo, or has no write access. Re-add the **public** key as a write-enabled deploy key. |
| `Backup failed … PushRejectedNonFastForward` | The remote has commits the plugin's tree doesn't. The plugin never force-pushes — use a single-writer backup repo, or delete `<storage>/git-backup-workdir` to re-clone. |
| `Clone failed … Initializing empty repo for first push` | Expected for a brand-new, empty backup repo. The first commit creates the branch. |
| `Config watcher hit EMFILE/ENOSPC` | The host ran out of inotify watches/instances — a host-wide limit shared by all your plugins, not specific to this one. The plugin auto-falls back to polling, so backups keep working. To restore the efficient watcher, raise the host limits (below). |

**Raising inotify limits (Linux host):** if you see the `EMFILE`/`ENOSPC` warning, the host's inotify limits are exhausted across all your plugins. Raise them and restart Homebridge:

```bash
echo -e "fs.inotify.max_user_instances=512\nfs.inotify.max_user_watches=524288" | sudo tee /etc/sysctl.d/60-homebridge-inotify.conf
sudo sysctl --system
```

Set Homebridge's log level to debug to see per-trigger backup activity (`startup`, `config change`, `scheduled`).

## Compatibility

- **Homebridge:** v2.0+. This is a service-only dynamic platform — it creates no HomeKit accessories and uses none of the HAP APIs that changed in Homebridge 2.0.
- **Node.js:** 22.12+ or 24+.
- **SSH auth** additionally requires `git` and `ssh` on the host. HTTPS auth has no host dependencies.

## Developing locally

```bash
git clone https://github.com/charlestephen/homebridge-git-backup.git
cd homebridge-git-backup
npm install
npm run build
npm link
```

Then in your Homebridge install: `npm link homebridge-git-backup` and restart Homebridge. Use `npm run watch` for incremental rebuilds.

## Changelog

### 2.0.2
- **Added:** automatic fallback to **polling** when the inotify watcher can't start (`EMFILE`/`ENOSPC`). On Homebridge hosts running many plugins, the per-user inotify limit can be exhausted host-wide; the plugin now polls `config.json` (no inotify, no held descriptors) instead of losing live change detection. The efficient inotify watcher is still preferred — raise the host limits (see [Troubleshooting](#troubleshooting)) to use it.

### 2.0.1
- **Fixed:** `EMFILE: too many open files` crash loop. The config watcher opened a file watch for every entry in the Homebridge storage directory (which holds many other plugins' state files). It now watches only `config.json` — still via the directory, so atomic saves are detected — keeping the footprint to a single directory watch. Watcher errors are now non-fatal (the plugin degrades to scheduled backups instead of crashing the child bridge).

### 2.0.0
- **Added:** SSH authentication with deployment keys (`auth_method: "ssh"`), via `simple-git` + `GIT_SSH_COMMAND`. Provide the key inline (`ssh_private_key`) or by path (`ssh_key_path`).
- **Added:** explicit `auth_method` (`https` | `ssh`) with conditional config-UI fields.
- **Changed:** HTTPS remains powered by isomorphic-git (no git binary); SSH uses the host `git`/`ssh`.
- Carries forward the 1.0.1 fixes (reliable config-change detection; full-history clone so pushes don't fail with `ReadObjectFail`).

### 1.0.1
- **Fixed:** config-change backups not firing (watcher now tracks the directory, surviving Homebridge's atomic config saves).
- **Fixed:** first push failing with `ReadObjectFail` on repos with history (full-history clone instead of shallow; [isomorphic-git#682](https://github.com/isomorphic-git/isomorphic-git/issues/682)).

### 1.0.0
- Initial release.

## License

MIT — see [LICENSE](./LICENSE).
