import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { GitBackupAccessory } from './accessory';
import { performBackup } from './backup';

export class GitBackupPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: PlatformAccessory[] = [];

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;

    this.api.on('didFinishLaunching', () => {
      this.discoverDevices();

      if (this.config.backupOnStart) {
        this.log.info('Running backup on start as configured.');
        performBackup(this.log, this.config).catch(err => {
          this.log.error('Backup on start failed:', String(err));
        });
      }
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  private discoverDevices(): void {
    const uuid = this.api.hap.uuid.generate(PLUGIN_NAME);
    const existing = this.accessories.find(acc => acc.UUID === uuid);

    if (existing) {
      this.log.info('Restoring cached accessory:', existing.displayName);
      new GitBackupAccessory(this, existing);
    } else {
      this.log.info('Registering new accessory: Git Backup');
      const accessory = new this.api.platformAccessory('Git Backup', uuid);
      new GitBackupAccessory(this, accessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
  }
}
