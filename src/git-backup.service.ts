import { promises as fsp } from 'node:fs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logging } from 'homebridge';
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';

export interface GitBackupOptions {
  repositoryUrl: string;
  branch: string;
  username: string;
  token: string;
  filePath: string;
  commitName: string;
  commitEmail: string;
  workDir: string;
  log: Logging;
}

export class GitBackupService {
  private readonly opts: GitBackupOptions;
  private initialized = false;

  constructor(opts: GitBackupOptions) {
    this.opts = opts;
  }

  async backup(sourceConfigPath: string): Promise<void> {
    await this.ensureRepo();
    await this.fastForward();

    const destAbsolute = path.join(this.opts.workDir, this.opts.filePath);
    await fsp.mkdir(path.dirname(destAbsolute), { recursive: true });
    await fsp.copyFile(sourceConfigPath, destAbsolute);

    const status = await git.statusMatrix({
      fs,
      dir: this.opts.workDir,
      filepaths: [this.opts.filePath],
    });
    const hasChanges = status.some(([, head, workdir, stage]) =>
      head !== workdir || workdir !== stage,
    );
    if (!hasChanges) {
      this.opts.log.debug('Homebridge config unchanged — nothing to commit.');
      return;
    }

    await git.add({ fs, dir: this.opts.workDir, filepath: this.opts.filePath });

    const sha = await git.commit({
      fs,
      dir: this.opts.workDir,
      message: `Backup Homebridge config: ${new Date().toISOString()}`,
      author: { name: this.opts.commitName, email: this.opts.commitEmail },
    });
    this.opts.log.info(`Committed backup ${sha.slice(0, 7)} on ${this.opts.branch}.`);

    await git.push({
      fs,
      http,
      dir: this.opts.workDir,
      remote: 'origin',
      ref: this.opts.branch,
      onAuth: () => ({ username: this.opts.username, password: this.opts.token }),
    });
    this.opts.log.info(`Pushed ${sha.slice(0, 7)} to ${this.opts.repositoryUrl}.`);
  }

  private async ensureRepo(): Promise<void> {
    if (this.initialized) return;

    const gitDir = path.join(this.opts.workDir, '.git');
    const exists = await this.exists(gitDir);

    if (!exists) {
      await fsp.mkdir(this.opts.workDir, { recursive: true });
      this.opts.log.info(`Cloning ${this.opts.repositoryUrl} (branch ${this.opts.branch})...`);
      try {
        // NOTE: do NOT shallow-clone (no `depth`). isomorphic-git's push walks
        // the commit graph to negotiate which objects to send; on a shallow
        // clone it reads past the graft boundary and throws ReadObjectFail
        // (isomorphic-git#682). A config-history repo is tiny, so we fetch the
        // full history of the single target branch instead.
        await git.clone({
          fs,
          http,
          dir: this.opts.workDir,
          url: this.opts.repositoryUrl,
          ref: this.opts.branch,
          singleBranch: true,
          onAuth: () => ({ username: this.opts.username, password: this.opts.token }),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.opts.log.warn(`Clone failed (${msg}). Initializing empty repo for first push.`);
        await git.init({ fs, dir: this.opts.workDir, defaultBranch: this.opts.branch });
        await git.addRemote({
          fs,
          dir: this.opts.workDir,
          remote: 'origin',
          url: this.opts.repositoryUrl,
        });
      }
    }

    this.initialized = true;
  }

  private async fastForward(): Promise<void> {
    try {
      // git.fastForward is `pull` hard-coded to fast-forward-only, so it never
      // creates a merge commit and needs no author. If the branch can't be
      // fast-forwarded (e.g. local is ahead after our last push, or the remote
      // ref doesn't exist yet) it throws and we simply carry on — the push
      // below stays non-forced so divergence surfaces as a loud error rather
      // than silent data loss.
      await git.fastForward({
        fs,
        http,
        dir: this.opts.workDir,
        ref: this.opts.branch,
        singleBranch: true,
        onAuth: () => ({ username: this.opts.username, password: this.opts.token }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.log.debug(`Fast-forward skipped: ${msg}`);
    }
  }

  private async exists(p: string): Promise<boolean> {
    try {
      await fsp.access(p);
      return true;
    } catch {
      return false;
    }
  }
}
