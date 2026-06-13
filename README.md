# homebridge-git-backup

A Homebridge plugin that adds a switch accessory to HomeKit for backing up your Homebridge configuration files to any git repository. Supports GitHub, GitLab, Gitea, Forgejo, and any self-hosted git server.

## Features

- Backs up any files or directories you specify
- Works with **any git host** — not just GitHub
- **HTTPS with a repository-scoped Personal Access Token (PAT)** — no password stored in plain text
- **SSH with a deployment key** — specify a dedicated key file per repository
- Preserves directory structure in the repository to prevent filename collisions
- Optional automatic backup on Homebridge start
- Configured via Homebridge UI (config.schema.json) or manually

## Installation

Install via Homebridge UI or:

```bash
npm install -g homebridge-git-backup
```

## Configuration

Add to the `platforms` array in your Homebridge `config.json`.

### HTTPS with Personal Access Token (recommended)

Create a repository-scoped PAT on your git host (GitHub → Settings → Developer settings → Fine-grained tokens; GitLab → User Settings → Access Tokens; Gitea → Settings → Applications). Grant it **read/write** access to the target repository only.

```json
{
  "platform": "GitBackup",
  "name": "Git Backup",
  "repositoryUrl": "https://github.com/user/homebridge-backups.git",
  "connectMethod": "https",
  "accessToken": "ghp_xxxxxxxxxxxxxxxxxxxx",
  "gitUserName": "Homebridge Backup",
  "gitUserEmail": "homebridge@localhost",
  "branch": "main",
  "filesToBackup": [
    "/var/lib/homebridge/config.json",
    "/var/lib/homebridge/.homebridge"
  ],
  "backupOnStart": false
}
```

### SSH with a deployment key

Generate a dedicated key pair for the Homebridge user:

```bash
ssh-keygen -t ed25519 -f /home/homebridge/.ssh/backup_key -C "homebridge-git-backup" -N ""
```

Add the public key (`backup_key.pub`) as a **deploy key** with write access on your repository host (GitHub → repo Settings → Deploy keys; GitLab → repo Settings → Repository → Deploy keys).

```json
{
  "platform": "GitBackup",
  "name": "Git Backup",
  "repositoryUrl": "git@github.com:user/homebridge-backups.git",
  "connectMethod": "ssh",
  "sshKeyPath": "/home/homebridge/.ssh/backup_key",
  "gitUserName": "Homebridge Backup",
  "gitUserEmail": "homebridge@localhost",
  "branch": "main",
  "filesToBackup": [
    "/var/lib/homebridge/config.json"
  ],
  "backupOnStart": true
}
```

Leave `sshKeyPath` empty to use the Homebridge user's default SSH key (`~/.ssh/id_rsa`).

## Config options

| Key | Type | Required | Default | Description |
|-----|------|----------|---------|-------------|
| `repositoryUrl` | string | Yes | — | Full URL of the git repository |
| `connectMethod` | `"https"` or `"ssh"` | Yes | `"https"` | Authentication method |
| `accessToken` | string | HTTPS only | — | Repository-scoped PAT or deploy token |
| `sshKeyPath` | string | No | `~/.ssh/id_rsa` | Path to SSH private key (deployment key) |
| `gitUserName` | string | Yes | — | Git commit author name |
| `gitUserEmail` | string | Yes | — | Git commit author email |
| `branch` | string | No | `"main"` | Branch to push to; created if it doesn't exist |
| `filesToBackup` | string[] | Yes | — | Absolute paths to files/dirs to back up |
| `backupOnStart` | boolean | No | `false` | Run a backup when Homebridge starts |

## Usage

Toggle the **Git Backup** switch in the Home app (or any HomeKit controller) to trigger a backup. The switch always shows as off — toggling it on fires the backup and it resets automatically.

If `backupOnStart` is enabled, a backup also runs automatically each time Homebridge starts.

## Notes

- Files are committed with their full path preserved (`/var/lib/homebridge/config.json` is stored as `var/lib/homebridge/config.json` in the repository), so files with the same basename from different directories don't overwrite each other.
- If the remote branch doesn't exist yet it will be created on the first push.
- If nothing has changed since the last backup, no commit is created.
