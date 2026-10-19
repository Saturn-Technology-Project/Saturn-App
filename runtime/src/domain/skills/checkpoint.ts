/**
 * Called around every write a skill makes to a project folder, with the absolute path: `before` keeps
 * the original bytes the first time a run touches a file, `after` records what the run left there.
 */
export interface FileCheckpoint {
  before(target: string): Promise<void>;
  after(target: string): Promise<void>;
}
