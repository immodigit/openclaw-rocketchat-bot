import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type CheckpointState = {
  updatedSince: string | null;
  recentMessageIds: string[];
};

type PersistedState = Record<string, CheckpointState>;

const EMPTY_STATE: CheckpointState = {
  updatedSince: null,
  recentMessageIds: []
};

export class FileCheckpointStore {
  constructor(
    private readonly filePath: string,
    private readonly recentMessageLimit = 100
  ) {}

  async read(accountId: string): Promise<CheckpointState> {
    const state = await this.loadState();
    const checkpoint = state[accountId] ?? EMPTY_STATE;
    return {
      updatedSince: checkpoint.updatedSince,
      recentMessageIds: [...checkpoint.recentMessageIds]
    };
  }

  async write(accountId: string, checkpoint: CheckpointState): Promise<void> {
    const state = await this.loadState();
    state[accountId] = {
      updatedSince: checkpoint.updatedSince,
      recentMessageIds: checkpoint.recentMessageIds.slice(-this.recentMessageLimit)
    };
    await this.saveState(state);
  }

  async hasSeen(accountId: string, messageId: string): Promise<boolean> {
    const checkpoint = await this.read(accountId);
    return checkpoint.recentMessageIds.includes(messageId);
  }

  async markSeen(accountId: string, messageId: string): Promise<void> {
    const checkpoint = await this.read(accountId);
    checkpoint.recentMessageIds.push(messageId);
    checkpoint.recentMessageIds = checkpoint.recentMessageIds.slice(-this.recentMessageLimit);
    await this.write(accountId, checkpoint);
  }

  private async loadState(): Promise<PersistedState> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        return {};
      }
      throw error;
    }
    // An empty checkpoint file ("" or whitespace) shouldn't crash the
    // websocket handler — it happens when a previous `saveState` was
    // interrupted between mkdir and writeFile (e.g., container kill
    // mid-write), or when an external process truncated the file.
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return {};
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as PersistedState;
      }
      console.warn(
        `[checkpoints] ${this.filePath}: unexpected JSON shape (${typeof parsed}), resetting to empty state`
      );
      return {};
    } catch (error) {
      // Corrupted JSON would otherwise propagate up through hasSeen and
      // tear down the WebSocket inbound loop. Log + reset is the safer
      // default — the worst case is one duplicate message delivery after
      // a crash, vs. a permanent inbound outage for the whole account.
      console.warn(
        `[checkpoints] ${this.filePath}: failed to parse (${
          error instanceof Error ? error.message : String(error)
        }), resetting to empty state`
      );
      return {};
    }
  }

  private async saveState(state: PersistedState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(state, null, 2));
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
