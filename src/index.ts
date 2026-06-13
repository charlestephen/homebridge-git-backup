import { API } from 'homebridge';
import { PLATFORM_NAME } from './settings';
import { GitBackupPlatform } from './platform';

export = (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, GitBackupPlatform);
};
