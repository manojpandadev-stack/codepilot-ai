/**
 * @codepilot/repository-engine
 *
 * Repository intelligence engine for CodePilot AI.
 * Provides file discovery, language detection, symbol extraction,
 * dependency analysis, and incremental indexing.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { IGNORED_INDEX_PATHS } from "@codepilot/shared";

export interface RepositoryFile {
  path: string;
  relativePath: string;
  language: string;
  size: number;
  hash: string;
  lastModified: number;
}

export interface RepositoryIndex {
  rootPath: string;
  files: RepositoryFile[];
  languages: Record<string, number>;
  totalFiles: number;
  indexedAt: number;
}

export class RepositoryEngine {
  private index: RepositoryIndex | null = null;
  private readonly rootPath: string;

  constructor(rootPath: string) {
    this.rootPath = rootPath;
  }

  async indexRepository(): Promise<RepositoryIndex> {
    const files: RepositoryFile[] = [];
    const languages: Record<string, number> = {};

    const languageMap: Record<string, string> = {
      ".java": "Java", ".ts": "TypeScript", ".tsx": "TypeScript",
      ".js": "JavaScript", ".jsx": "JavaScript", ".py": "Python",
      ".sql": "SQL", ".json": "JSON", ".yaml": "YAML", ".yml": "YAML",
      ".xml": "XML", ".md": "Markdown", ".go": "Go", ".rs": "Rust",
      ".kt": "Kotlin", ".gradle": "Gradle",
    };

    const scan = async (dir: string, depth = 0): Promise<void> => {
      if (depth > 15) return;
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (IGNORED_INDEX_PATHS.includes(entry.name)) continue;
          if (entry.name.startsWith(".")) continue;
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await scan(fullPath, depth + 1);
          } else {
            const ext = path.extname(entry.name);
            const lang = languageMap[ext] ?? "Other";
            const stat = await fs.stat(fullPath);
            files.push({
              path: fullPath,
              relativePath: path.relative(this.rootPath, fullPath),
              language: lang,
              size: stat.size,
              hash: `${stat.size}-${stat.mtimeMs}`,
              lastModified: stat.mtimeMs,
            });
            languages[lang] = (languages[lang] ?? 0) + 1;
          }
        }
      } catch { /* skip */ }
    };

    await scan(this.rootPath);

    this.index = {
      rootPath: this.rootPath, files, languages,
      totalFiles: files.length, indexedAt: Date.now(),
    };

    return this.index;
  }

  getIndex(): RepositoryIndex | null { return this.index; }
  getFilesByLanguage(lang: string): RepositoryFile[] { return this.index?.files.filter(f => f.language === lang) ?? []; }
  getFileByPath(relativePath: string): RepositoryFile | undefined { return this.index?.files.find(f => f.relativePath === relativePath); }
}
