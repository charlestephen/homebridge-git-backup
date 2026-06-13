import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import { GitBackupPlatform } from './platform';
import { performBackup } from './backup';

export class GitBackupAccessory {
  private readonly service: Service;

  constructor(
    private readonly platform: GitBackupPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'homebridge-git-backup')
      .setCharacteristic(this.platform.Characteristic.Model, 'Git Backup Switch')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, '1.0.0');

    this.service =
      this.accessory.getService(this.platform.Service.Switch) ||
      this.accessory.addService(this.platform.Service.Switch);

    this.service.setCharacteristic(this.platform.Characteristic.Name, 'Git Backup');

    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onGet(this.handleGet.bind(this))
      .onSet(this.handleSet.bind(this));
  }

  async handleGet(): Promise<CharacteristicValue> {
    return false;
  }

  async handleSet(value: CharacteristicValue): Promise<void> {
    if (value) {
      this.platform.log.info('Backup triggered via HomeKit.');
      performBackup(this.platform.log, this.platform.config).catch(err => {
        this.platform.log.error('Backup failed:', String(err));
      });
    }
  }
}
