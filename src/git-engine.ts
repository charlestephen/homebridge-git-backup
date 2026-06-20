import { promises as fsp } from 'node:fs';
import type { Logging } from 'homebridge';

/** Everything an engine needs that is independent of the auth method. */
export interface GitEngineContext {
  repositoryUrl: string;
  branch: string;
  workDir: string;
  /** Path of the backed-up config within the repository, relative to workDir. */
  filePath: string;
  commitName: string;
  commitEmail: string;
  log: Logging;
}

/**
 * A transport-specific Git backend. HTTPS is served by isomorphic-git (no git
 * binary); SSH is served by simple-git (the git binary + ssh). The orchestrating
 * service is engine-agnostic: it writes the config file into the work tree, then
 * asks the engine to fast-forward, commit, and push.
 */
export interface GitEngine {
  /** Clone the remote into workDir, or init an empty repo if it's unreachable. Idempotent. */
  ensureRepo(): Promise<void>;
  /** Best-effort fast-forward of the local branch from the remote. Never throws. */
  fastForward(): Promise<void>;
  /**
   * Stage filePath; if it changed, commit `message` and push to the branch.
   * Returns the new commit SHA, or null when there was nothing to commit.
   */
  commitAndPush(message: string): Promise<string | null>;
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
