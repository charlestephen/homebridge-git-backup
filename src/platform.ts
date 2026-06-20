import * as path from 'node:path';
import type {
  API,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';
import { APIEvent } from 'homebridge';
import chokidar, { FSWatcher } from 'chokidar';

import { GitBackupService } from './git-backup.service';
import { GitBackupConfig } from './interfaces';
import { PLATFORM_NAME } from './settings';

const DEFAULT_INTERVAL_MINUTES = 1440;
const MINIMUM_INTERVAL_MINUTES = 5;
const WATCHER_DEBOUNCE_MS = 5000;

export class GitBackupPlatform implements DynamicPlatformPlugin {
  private readonly cfg: GitBackupConfig;
  private service?: GitBackupService;
  private watcher?: FSWatcher;
  private intervalTimer?: NodeJS.Timeout;
  private inFlight = false;
  private pending = false;

  constructor(
    public readonly log: Logging,
    config: PlatformConfig,
    public readonly api: API,
  ) {
    this.cfg = config as GitBackupConfig;

    if (!this.validate()) return;

    this.api.on(APIEvent.DID_FINISH_LAUNCHING, () => this.start());
    this.api.on(APIEvent.SHUTDOWN, () => this.stop());
  }

  configureAccessory(_accessory: PlatformAccessory): void {
    // No accessories - this is a service-only platform plugin.
  }

  private validate(): boolean {
    if (!this.cfg) {
      this.log.error(`${PLATFORM_NAME}: missing platform config block.`);
      return false;
    }
    if (!this.cfg.repository_url) {
      this.log.error(`${PLATFORM_NAME}: "repository_url" is required.`);
      return false;
    }
    if (!this.cfg.git_token) {
      this.log.error(`${PLATFORM_NAME}: "git_token" is required.`);
      return false;
    }
    return true;
  }

  private start(): void {
    const branch = this.cfg.branch ?? 'main';
    const username = this.cfg.git_username ?? 'git';
    const filePath = this.cfg.file_path ?? 'homebridge-config.json';
    const commitName = this.cfg.commit_name ?? 'Homebridge Git Backup';
    const commitEmail = this.cfg.commit_email ?? 'homebridge@localhost';

    const intervalMinutes = Math.max(
      MINIMUM_INTERVAL_MINUTES,
      this.cfg.backup_interval ?? DEFAULT_INTERVAL_MINUTES,
    );

    const workDir = path.join(this.api.user.storagePath(), 'git-backup-workdir');

    this.service = new GitBackupService({
      repositoryUrl: this.cfg.repository_url,
      branch,
      username,
      token: this.cfg.git_token,
      filePath,
      commitName,
      commitEmail,
      workDir,
      log: this.log,
    });

    const configPath = this.api.user.configPath();
    const configDir = path.dirname(configPath);
    const configName = path.basename(configPath);

    void this.runBackup('startup');

    // Watch the directory that holds config.json, not the file itself.
    // Homebridge and the Config UI save config.json atomically (write a temp
    // file, then rename it over the original), which swaps the file's inode.
    // A watcher bound to the file path loses its target after the first save
    // and never fires again. depth:0 keeps us out of the git-backup-workdir
    // subdirectory (so our own commits don't retrigger a backup), and the
    // filename filter ignores every sibling except config.json.
    this.watcher = chokidar.watch(configDir, {
      persistent: true,
      ignoreInitial: true,
      depth: 0,
      awaitWriteFinish: {
        stabilityThreshold: WATCHER_DEBOUNCE_MS,
        pollInterval: 100,
      },
    });
    const onConfigEvent = (changedPath: string): void => {
      if (path.basename(changedPath) === configName) {
        void this.runBackup('config change');
      }
    };
    this.watcher.on('add', onConfigEvent);
    this.watcher.on('change', onConfigEvent);

    this.intervalTimer = setInterval(
      () => void this.runBackup('scheduled'),
      intervalMinutes * 60 * 1000,
    );

    this.log.info(
      `${PLATFORM_NAME} watching ${configPath}; ` +
        `scheduled every ${intervalMinutes} minute(s).`,
    );
  }

  private async runBackup(trigger: string): Promise<void> {
    if (!this.service) return;

    if (this.inFlight) {
      this.pending = true;
      this.log.debug(`Backup already running; coalescing trigger "${trigger}".`);
      return;
    }

    this.inFlight = true;
    try {
      this.log.debug(`Running backup (trigger: ${trigger}).`);
      await this.service.backup(this.api.user.configPath());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`Backup failed (${trigger}): ${msg}`);
    } finally {
      this.inFlight = false;
      if (this.pending) {
        this.pending = false;
        void this.runBackup('coalesced');
      }
    }
  }

  private stop(): void {
    this.log.info(`${PLATFORM_NAME} shutting down.`);
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = undefined;
    }
    if (this.watcher) {
      void this.watcher.close();
      this.watcher = undefined;
    }
  }
}
