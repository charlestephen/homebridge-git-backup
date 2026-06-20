import type { PlatformConfig } from 'homebridge';

export interface GitBackupConfig extends PlatformConfig {
  repository_url: string;
  branch?: string;
  git_username?: string;
  git_token: string;
  file_path?: string;
  backup_interval?: number;
  commit_name?: string;
  commit_email?: string;
}
