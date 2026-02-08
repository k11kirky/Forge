import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);

function asPromise(method, context, ...args) {
  return new Promise((resolve, reject) => {
    method.call(context, ...args, (error, value) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(value);
    });
  });
}

function isNotFoundError(error) {
  if (!error) {
    return false;
  }
  if (error.notFound === true) {
    return true;
  }
  const code = typeof error.code === "string" ? error.code.toLowerCase() : "";
  if (code.includes("not_found") || code.includes("notfound")) {
    return true;
  }
  const message =
    typeof error.message === "string" ? error.message : String(error);
  const normalized = message.toLowerCase();
  return normalized.includes("notfound");
}

export class RocksSnapshotStore {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }

  async init() {
    await mkdir(dirname(this.dbPath), { recursive: true });

    let rocksdbFactory;
    try {
      rocksdbFactory = require("rocksdb");
    } catch {
      throw new Error(
        "rocksdb package is required. Run `npm install` before starting forge-server."
      );
    }

    this.db = rocksdbFactory(this.dbPath);
    await asPromise(this.db.open, this.db, {
      createIfMissing: true
    });
  }

  async load() {
    try {
      const value = await asPromise(this.db.get, this.db, "snapshot", {
        asBuffer: false
      });
      return value ? JSON.parse(value) : null;
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  async save(snapshot) {
    await asPromise(
      this.db.put,
      this.db,
      "snapshot",
      JSON.stringify(snapshot)
    );
  }

  async close() {
    if (!this.db) {
      return;
    }
    await asPromise(this.db.close, this.db);
  }
}
