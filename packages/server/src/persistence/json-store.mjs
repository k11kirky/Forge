import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class JsonSnapshotStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async init() {}

  async load() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async save(snapshot) {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(snapshot, null, 2), "utf8");
  }

  async close() {}
}
