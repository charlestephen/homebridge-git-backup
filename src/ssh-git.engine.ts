import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import simpleGit, { SimpleGit } from 'simple-git';

import { GitEngine, GitEngineContext, errMessage, pathExists } from './git-engine';

export interface SshAuth {
  /** Absolute path to the private key file used for the deployment key. */
  keyPath: string;
}

/**
 * SSH / deployment-key engine backed by simple-git. isomorphic-git has no SSH
 * transport (isomorphic-git#231), so the SSH path shells out to the system `git`
 * binary with GIT_SSH_COMMAND pointing at the deploy key. This requires `git`
 * and `ssh` on the host — they are NOT present in the official Homebridge Docker
 * image, where HTTPS auth should be used instead.
 */
export class SshGitEngine implements GitEngine {
  private initialized = false;
  private readonly sshCommand: string;

  constructor(
    private readonly ctx: GitEngineContext,
    auth: SshAuth,
  ) {
    // IdentitiesOnly: ignore any agent/default keys and use only this one.
    // accept-new: trust the host key on first contact (TOFU), but fail if it changes.
    // BatchMode: never prompt — fail fast instead of hanging a backup.
    this.sshCommand =
      `ssh -i "${auth.keyPath}" -o IdentitiesOnly=yes ` +
      '-o StrictHostKeyChecking=accept-new -o BatchMode=yes';
  }

  private client(dir: string): SimpleGit {
    // simple-git's .env() replaces the child environment, so we spread
    // process.env to keep PATH etc. — but it refuses an inherited GIT_EDITOR /
    // GIT_SEQUENCE_EDITOR (they can execute arbitrary commands during git ops).
    // We never invoke an editor (commits use -m), so strip them.
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.GIT_EDITOR;
    delete env.GIT_SEQUENCE_EDITOR;
    // allowUnsafeSshCommand: simple-git blocks GIT_SSH_COMMAND by default as an
    // arbitrary-command-execution guard. Driving the deploy key through a custom
    // SSH command is exactly this engine's purpose, so we opt in deliberately.
    return simpleGit({ baseDir: dir, unsafe: { allowUnsafeSshCommand: true } }).env({
      ...env,
      GIT_SSH_COMMAND: this.sshCommand,
      GIT_TERMINAL_PROMPT: '0',
    });
  }

  async ensureRepo(): Promise<void> {
    if (this.initialized) return;

    // Preflight: simple-git needs the git binary. Give a clear error if absent.
    try {
      await this.client(path.dirname(this.ctx.workDir)).version();
    } catch (err) {
      throw new Error(
        `SSH auth requires the "git" binary on the host, which could not be run (${errMessage(err)}). ` +
          'The official Homebridge Docker image does not include git — use HTTPS auth there instead.',
      );
    }

    const gitDir = path.join(this.ctx.workDir, '.git');
    if (!(await pathExists(gitDir))) {
      await fsp.mkdir(this.ctx.workDir, { recursive: true });
      this.ctx.log.info(`Cloning ${this.ctx.repositoryUrl} (branch ${this.ctx.branch}) over SSH...`);
      try {
        await this.client(path.dirname(this.ctx.workDir)).clone(this.ctx.repositoryUrl, this.ctx.workDir, [
          '--single-branch',
          '--branch',
          this.ctx.branch,
        ]);
      } catch (err) {
        this.ctx.log.warn(`Clone failed (${errMessage(err)}). Initializing empty repo for first push.`);
        const g = this.client(this.ctx.workDir);
        await g.init();
        // Point HEAD at the configured branch before the first commit, without
        // relying on `git init -b` (git >= 2.28) — works on any git version.
        await g.raw(['symbolic-ref', 'HEAD', `refs/heads/${this.ctx.branch}`]);
        await g.addRemote('origin', this.ctx.repositoryUrl);
      }
    }

    // Ensure commits have an author regardless of host-level git config.
    const g = this.client(this.ctx.workDir);
    await g.addConfig('user.name', this.ctx.commitName);
    await g.addConfig('user.email', this.ctx.commitEmail);

    this.initialized = true;
  }

  async fastForward(): Promise<void> {
    try {
      const g = this.client(this.ctx.workDir);
      await g.fetch('origin', this.ctx.branch);
      await g.merge(['--ff-only', `origin/${this.ctx.branch}`]);
    } catch (err) {
      this.ctx.log.debug(`Fast-forward skipped: ${errMessage(err)}`);
    }
  }

  async commitAndPush(message: string): Promise<string | null> {
    const g = this.client(this.ctx.workDir);
    await g.add(this.ctx.filePath);

    // Nothing staged for our file => identical content => nothing to do.
    const staged = await g.diff(['--cached', '--name-only']);
    if (!staged.trim()) return null;

    const result = await g.commit(message);
    await g.push('origin', this.ctx.branch);
    return result.commit || null;
  }
}
