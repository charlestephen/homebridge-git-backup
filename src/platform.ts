import * as fs from 'node:fs';
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
import { GitEngine, GitEngineContext } from './git-engine';
import { IsomorphicGitEngine } from './isomorphic-git.engine';
import { SshGitEngine } from './ssh-git.engine';
import { AuthMethod, GitBackupConfig } from './interfaces';
import { PLATFORM_NAME } from './settings';

const DEFAULT_INTERVAL_MINUTES = 1440;
const MINIMUM_INTERVAL_MINUTES = 5;
const WATCHER_DEBOUNCE_MS = 5000;
const WATCHER_POLL_MS = 30000;
const SSH_KEY_FILENAME = '.git-backup-ssh-key';

export class GitBackupPlatform implements DynamicPlatformPlugin {
  private readonly cfg: GitBackupConfig;
  private service?: GitBackupService;
  private watcher?: FSWatcher;
  private intervalTimer?: NodeJS.Timeout;
  private inFlight = false;
  private pending = false;
  private polling = false;

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

  private authMethod(): AuthMethod {
    return this.cfg.auth_method === 'ssh' ? 'ssh' : 'https';
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

    if (this.authMethod() === 'ssh') {
      if (!this.cfg.ssh_private_key && !this.cfg.ssh_key_path) {
        this.log.error(`${PLATFORM_NAME}: SSH auth requires "ssh_private_key" or "ssh_key_path".`);
        return false;
      }
      if (/^https?:\/\//i.test(this.cfg.repository_url)) {
        this.log.warn(
          `${PLATFORM_NAME}: auth_method is "ssh" but repository_url looks like HTTPS. ` +
            'Use an SSH URL, e.g. git@github.com:you/homebridge-backups.git',
        );
      }
    } else {
      if (!this.cfg.git_token) {
        this.log.error(`${PLATFORM_NAME}: HTTPS auth requires "git_token".`);
        return false;
      }
      if (/^(git@|ssh:\/\/)/i.test(this.cfg.repository_url)) {
        this.log.warn(
          `${PLATFORM_NAME}: auth_method is "https" but repository_url looks like SSH. ` +
            'Use an HTTPS URL, e.g. https://github.com/you/homebridge-backups.git',
        );
      }
    }

    return true;
  }

  /** Resolve a private-key file path: use ssh_key_path, or materialize the inline key with 0600 perms. */
  private resolveSshKeyPath(): string {
    if (this.cfg.ssh_key_path) return this.cfg.ssh_key_path;

    const keyFile = path.join(this.api.user.storagePath(), SSH_KEY_FILENAME);
    let key = (this.cfg.ssh_private_key ?? '').replace(/\r\n/g, '\n');
    if (!key.endsWith('\n')) key += '\n'; // OpenSSH rejects keys without a trailing newline
    fs.writeFileSync(keyFile, key, { mode: 0o600 });
    fs.chmodSync(keyFile, 0o600); // enforce perms even if the file already existed
    return keyFile;
  }

  private start(): void {
    const branch = this.cfg.branch ?? 'main';
    const filePath = this.cfg.file_path ?? 'homebridge-config.json';
    const commitName = this.cfg.commit_name ?? 'Homebridge Git Backup';
    const commitEmail = this.cfg.commit_email ?? 'homebridge@localhost';

    const intervalMinutes = Math.max(
      MINIMUM_INTERVAL_MINUTES,
      this.cfg.backup_interval ?? DEFAULT_INTERVAL_MINUTES,
    );

    const workDir = path.join(this.api.user.storagePath(), 'git-backup-workdir');

    const ctx: GitEngineContext = {
      repositoryUrl: this.cfg.repository_url,
      branch,
      workDir,
      filePath,
      commitName,
      commitEmail,
      log: this.log,
    };

    let engine: GitEngine;
    if (this.authMethod() === 'ssh') {
      engine = new SshGitEngine(ctx, { keyPath: this.resolveSshKeyPath() });
      this.log.info(`${PLATFORM_NAME} using SSH (deployment key) auth.`);
    } else {
      engine = new IsomorphicGitEngine(ctx, {
        username: this.cfg.git_username ?? 'git',
        token: this.cfg.git_token ?? '',
      });
      this.log.info(`${PLATFORM_NAME} using HTTPS (token) auth.`);
    }

    this.service = new GitBackupService(engine, ctx);

    const configPath = this.api.user.configPath();

    void this.runBackup('startup');

    this.setupConfigWatch(configPath);

    this.intervalTimer = setInterval(
      () => void this.runBackup('scheduled'),
      intervalMinutes * 60 * 1000,
    );

    this.log.info(
      `${PLATFORM_NAME} watching ${configPath}; ` +
        `scheduled every ${intervalMinutes} minute(s).`,
    );
  }

  /**
   * Primary watcher: a single inotify watch on the storage directory, scoped to
   * config.json via `ignored`. Watching the directory (not the file path) lets us
   * survive Homebridge's atomic write+rename saves; `ignored` keeps the footprint
   * to one directory watch so we don't open an fs.watch per sibling file (EMFILE).
   */
  private setupConfigWatch(configPath: string): void {
    const configDir = path.dirname(configPath);
    const resolvedDir = path.resolve(configDir);
    const resolvedConfig = path.resolve(configPath);

    const watcher = chokidar.watch(configDir, {
      persistent: true,
      ignoreInitial: true,
      depth: 0,
      ignored: (entry: string): boolean => {
        const r = path.resolve(entry);
        return r !== resolvedDir && r !== resolvedConfig;
      },
      awaitWriteFinish: { stabilityThreshold: WATCHER_DEBOUNCE_MS, pollInterval: 100 },
    });
    this.watcher = watcher;
    this.wireWatcher(watcher, configPath);
  }

  /**
   * Fallback watcher used when inotify is exhausted (EMFILE/ENOSPC): poll
   * config.json directly. Polling uses periodic fs.stat — no inotify instances,
   * no held descriptors — and re-stat'ing the path survives atomic renames.
   */
  private fallBackToPolling(configPath: string): void {
    this.polling = true;
    if (this.watcher) {
      void this.watcher.close();
      this.watcher = undefined;
    }
    const poller = chokidar.watch(configPath, {
      persistent: true,
      ignoreInitial: true,
      usePolling: true,
      interval: WATCHER_POLL_MS,
      awaitWriteFinish: { stabilityThreshold: WATCHER_DEBOUNCE_MS, pollInterval: 100 },
    });
    this.watcher = poller;
    this.wireWatcher(poller, configPath);
    this.log.info(`Now polling ${configPath} every ${Math.round(WATCHER_POLL_MS / 1000)}s for changes.`);
  }

  private wireWatcher(watcher: FSWatcher, configPath: string): void {
    const configName = path.basename(configPath);
    const onConfigEvent = (changedPath: string): void => {
      if (path.basename(changedPath) === configName) {
        void this.runBackup('config change');
      }
    };
    watcher.on('add', onConfigEvent);
    watcher.on('change', onConfigEvent);
    watcher.on('error', (err: unknown) => {
      const code = (err as NodeJS.ErrnoException)?.code;
      const msg = err instanceof Error ? err.message : String(err);
      // inotify/FD exhaustion on the efficient watcher -> switch to polling once.
      if (!this.polling && (code === 'EMFILE' || code === 'ENOSPC')) {
        this.log.warn(
          `Config watcher hit ${code} — the host is out of inotify watches/instances. ` +
            'Falling back to polling config.json. For the efficient inotify watcher, raise ' +
            'fs.inotify.max_user_instances and fs.inotify.max_user_watches on the host.',
        );
        this.fallBackToPolling(configPath);
        return;
      }
      // Never fatal: a dead watcher just means we rely on scheduled backups.
      if (this.polling) {
        this.log.debug(`Watcher error after fallback (${msg}).`);
      } else {
        this.log.warn(`Config watcher error (${msg}). Continuing with scheduled backups.`);
      }
    });
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
