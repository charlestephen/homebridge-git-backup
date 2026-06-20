import type { PlatformConfig } from 'homebridge';

export type AuthMethod = 'https' | 'ssh';

export interface GitBackupConfig extends PlatformConfig {
  repository_url: string;
  branch?: string;

  /** How to authenticate with the remote. Defaults to 'https'. */
  auth_method?: AuthMethod;

  // --- HTTPS (Personal Access Token) ---
  git_username?: string;
  git_token?: string;

  // --- SSH (deployment key) ---
  /** Inline PEM/OpenSSH private key. Written to a 0600 file at runtime. */
  ssh_private_key?: string;
  /** Path to an existing private key file on the host (preferred — keeps the key out of the backed-up config). */
  ssh_key_path?: string;

  // --- common ---
  file_path?: string;
  backup_interval?: number;
  commit_name?: string;
  commit_email?: string;
}
