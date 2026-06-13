import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export async function walkFiles(root: string, predicate: (filePath: string) => boolean): Promise<string[]> {
  const results: string[] = [];

  async function visit(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }

    await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          await visit(fullPath);
          return;
        }

        if (entry.isFile()) {
          results.push(fullPath);
          return;
        }

        if (entry.isSymbolicLink()) {
          const fileStat = await stat(fullPath);
          if (fileStat.isFile() && predicate(fullPath)) {
            results.push(fullPath);
          }
        }
      }),
    );
  }

  await visit(root);
  return results.filter(predicate).sort();
}
