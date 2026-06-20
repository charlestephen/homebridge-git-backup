import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import { GitEngine, GitEngineContext } from './git-engine';

/**
 * Engine-agnostic backup orchestration. It writes the current Homebridge config
 * into the work tree, then delegates the git transport (clone/fast-forward/
 * commit/push) to the configured {@link GitEngine}.
 */
export class GitBackupService {
  constructor(
    private readonly engine: GitEngine,
    private readonly ctx: GitEngineContext,
  ) {}

  async backup(sourceConfigPath: string): Promise<void> {
    await this.engine.ensureRepo();
    await this.engine.fastForward();

    const dest = path.join(this.ctx.workDir, this.ctx.filePath);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(sourceConfigPath, dest);

    const sha = await this.engine.commitAndPush(
      `Backup Homebridge config: ${new Date().toISOString()}`,
    );

    if (sha) {
      this.ctx.log.info(
        `Pushed backup ${sha.slice(0, 7)} to ${this.ctx.repositoryUrl} (${this.ctx.branch}).`,
      );
    } else {
      this.ctx.log.debug('Homebridge config unchanged — nothing to commit.');
    }
  }
}
