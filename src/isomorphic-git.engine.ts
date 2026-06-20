import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';

import { GitEngine, GitEngineContext, errMessage, pathExists } from './git-engine';

export interface HttpsAuth {
  username: string;
  token: string;
}

/**
 * HTTPS / Personal-Access-Token engine backed by isomorphic-git. Pure JS — needs
 * no `git` binary, so it works in the official (slim) Homebridge Docker image.
 */
export class IsomorphicGitEngine implements GitEngine {
  private initialized = false;

  constructor(
    private readonly ctx: GitEngineContext,
    private readonly auth: HttpsAuth,
  ) {}

  private readonly onAuth = () => ({
    username: this.auth.username,
    password: this.auth.token,
  });

  async ensureRepo(): Promise<void> {
    if (this.initialized) return;

    const gitDir = path.join(this.ctx.workDir, '.git');
    if (!(await pathExists(gitDir))) {
      await fsp.mkdir(this.ctx.workDir, { recursive: true });
      this.ctx.log.info(`Cloning ${this.ctx.repositoryUrl} (branch ${this.ctx.branch}) over HTTPS...`);
      try {
        // Full history of the single branch (no `depth`): a shallow clone breaks
        // isomorphic-git's push object negotiation with ReadObjectFail (#682).
        await git.clone({
          fs,
          http,
          dir: this.ctx.workDir,
          url: this.ctx.repositoryUrl,
          ref: this.ctx.branch,
          singleBranch: true,
          onAuth: this.onAuth,
        });
      } catch (err) {
        this.ctx.log.warn(`Clone failed (${errMessage(err)}). Initializing empty repo for first push.`);
        await git.init({ fs, dir: this.ctx.workDir, defaultBranch: this.ctx.branch });
        await git.addRemote({ fs, dir: this.ctx.workDir, remote: 'origin', url: this.ctx.repositoryUrl });
      }
    }

    this.initialized = true;
  }

  async fastForward(): Promise<void> {
    try {
      await git.fastForward({
        fs,
        http,
        dir: this.ctx.workDir,
        ref: this.ctx.branch,
        singleBranch: true,
        onAuth: this.onAuth,
      });
    } catch (err) {
      this.ctx.log.debug(`Fast-forward skipped: ${errMessage(err)}`);
    }
  }

  async commitAndPush(message: string): Promise<string | null> {
    const status = await git.statusMatrix({
      fs,
      dir: this.ctx.workDir,
      filepaths: [this.ctx.filePath],
    });
    const changed = status.some(([, head, workdir, stage]) => head !== workdir || workdir !== stage);
    if (!changed) return null;

    await git.add({ fs, dir: this.ctx.workDir, filepath: this.ctx.filePath });
    const sha = await git.commit({
      fs,
      dir: this.ctx.workDir,
      message,
      author: { name: this.ctx.commitName, email: this.ctx.commitEmail },
    });
    await git.push({
      fs,
      http,
      dir: this.ctx.workDir,
      remote: 'origin',
      ref: this.ctx.branch,
      onAuth: this.onAuth,
    });
    return sha;
  }
}
