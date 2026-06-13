import { Logger, PlatformConfig } from 'homebridge';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import simpleGit from 'simple-git';

function buildRepoUrl(config: PlatformConfig): string {
  const connectMethod = (config.connectMethod as string) || 'https';
  const repositoryUrl = config.repositoryUrl as string;

  if (connectMethod === 'ssh') {
    return repositoryUrl;
  }

  // Inject PAT into HTTPS URL: https://oauth2:<token>@host/path.git
  // This pattern works with GitHub, GitLab, Gitea, Forgejo, and most git hosts.
  const accessToken = (config.accessToken as string) || '';
  const url = new URL(repositoryUrl);
  if (accessToken) {
    url.username = 'oauth2';
    url.password = accessToken;
  }
  return url.toString();
}

function getGitEnv(config: PlatformConfig): NodeJS.ProcessEnv {
  const connectMethod = (config.connectMethod as string) || 'https';
  if (connectMethod === 'ssh' && config.sshKeyPath) {
    const keyPath = config.sshKeyPath as string;
    return {
      GIT_SSH_COMMAND: `ssh -i "${keyPath}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`,
    };
  }
  return {};
}

// Copies files/dirs into destDir preserving their full path structure
// so /var/lib/homebridge/config.json → destDir/var/lib/homebridge/config.json.
// This avoids basename collisions when backing up files with the same name.
function copyToWorkDir(files: string[], destDir: string): void {
  for (const src of files) {
    const rel = src.startsWith('/') ? src.slice(1) : src;
    const dest = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    if (fs.statSync(src).isDirectory()) {
      fs.cpSync(src, dest, { recursive: true });
    } else {
      fs.copyFileSync(src, dest);
    }
  }
}

export async function performBackup(log: Logger, config: PlatformConfig): Promise<void> {
  const filesToBackup = (config.filesToBackup as string[]) || [];
  if (!Array.isArray(filesToBackup) || filesToBackup.length === 0) {
    throw new Error('filesToBackup must be a non-empty array in plugin config.');
  }

  const missing = filesToBackup.filter(f => !fs.existsSync(f));
  if (missing.length > 0) {
    throw new Error(`Files not found: ${missing.join(', ')}`);
  }

  const branch = (config.branch as string) || 'main';
  const repoUrl = buildRepoUrl(config);
  const gitEnv = getGitEnv(config);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebridge-git-backup-'));
  log.info('Backup started.');

  try {
    const git = simpleGit({
      baseDir: workDir,
      binary: 'git',
      maxConcurrentProcesses: 1,
    }).env({ ...process.env, ...gitEnv });

    await git.init();
    await git.addRemote('origin', repoUrl);
    await git.addConfig('user.email', (config.gitUserEmail as string) || 'homebridge@localhost');
    await git.addConfig('user.name', (config.gitUserName as string) || 'Homebridge Git Backup');

    // Determine if the remote branch already exists
    let remoteBranchExists = false;
    try {
      await git.fetch('origin');
      const refs = await git.listRemote(['--heads', 'origin', branch]);
      remoteBranchExists = refs.trim().length > 0;
    } catch (err) {
      log.debug(`Could not reach remote (will push fresh): ${String(err)}`);
    }

    if (remoteBranchExists) {
      await git.checkout(['-b', branch, '--track', `origin/${branch}`]);
      await git.reset(['--hard', `origin/${branch}`]);
    } else {
      log.info(`Branch '${branch}' not found on remote — will create it on first push.`);
      await git.checkout(['-b', branch]);
    }

    copyToWorkDir(filesToBackup, workDir);

    await git.add('.');

    const date = new Date();
    let didCommit = false;
    try {
      const result = await git.commit(`Backup ${date.toUTCString()}`);
      didCommit = !!result.commit;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('nothing to commit')) {
        log.info('Nothing changed since last backup.');
        return;
      }
      throw err;
    }

    if (didCommit) {
      await git.push('origin', branch);
      log.info('Backup pushed successfully.');
    } else {
      log.info('Nothing changed since last backup.');
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
    log.debug('Temporary directory cleaned up.');
  }
}
