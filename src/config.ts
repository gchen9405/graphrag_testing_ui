import * as os from "os";
import * as path from "path";

// =============================================================================
// GraphRAG Test UI -- backend configuration.
// The handful of things you might change are near the top. Defaults match:
//   indexing:  graphrag_pipeline.exe index
//   querying:  graphrag_querying.exe "<query>"
// =============================================================================

function envFlag(name: string, def: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return def;
  return !["0", "false", "no", "off", ""].includes(raw.trim().toLowerCase());
}

function expandUser(p: string): string {
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(1));
  return p;
}

const PROJECT_ROOT = path.resolve(__dirname, "..");

// MOCK MODE: true = don't launch the real exes (fake logs + dummy artifacts +
// canned answer; runs on any OS). false = run the real exes.
// Override at runtime:  set GRAPHRAG_USE_MOCK=0
export const USE_MOCK: boolean = envFlag("GRAPHRAG_USE_MOCK", true);

// The folder that contains BOTH executables AND the msgragtest folder. Must be
// absolute -- on Windows the exe is found by full path, not via cwd. Hard-code it
// for real use, e.g.  "C:\\graphrag".   Override:  set GRAPHRAG_BASE_DIR=C:\graphrag
export const BASE_DIR: string = path.resolve(
  expandUser(process.env.GRAPHRAG_BASE_DIR ?? path.join(PROJECT_ROOT, "graphrag_runtime"))
);

// Executable file names (inside BASE_DIR).
export const INDEXER_EXE_NAME = "graphrag_pipeline.exe";
export const QUERIER_EXE_NAME = "graphrag_querying.exe";
export const INDEXER_EXE = path.join(BASE_DIR, INDEXER_EXE_NAME);
export const QUERIER_EXE = path.join(BASE_DIR, QUERIER_EXE_NAME);

// The two commands. Each array item is ONE argv token; spawn runs without a
// shell, so a query containing spaces is passed safely as a single argument
// (no quoting needed -- this is the exact equivalent of  exe "<query>"  ).
// Edit these if your exes take different arguments.
export function buildIndexCommand(): string[] {
  return [INDEXER_EXE, "index"];
}
export function buildQueryCommand(query: string): string[] {
  return [QUERIER_EXE, query];
}

// msgragtest layout (standard GraphRAG): corpus in input/, artifacts in output/,
// and your prompt files in prompts/. You provide prompts/ (the indexer needs it);
// the app preserves it -- only input/ and output/ are cleared between runs.
export const MSGRAG_DIR = path.join(BASE_DIR, "msgragtest");
export const INPUT_DIR = path.join(MSGRAG_DIR, "input");
export const OUTPUT_DIR = path.join(MSGRAG_DIR, "output");
export const PROMPTS_DIR = path.join(MSGRAG_DIR, "prompts");

// Files that must sit next to the exes (checked for friendly errors in live mode).
export const REQUIRED_SUPPORT_FILES = ["settings.yaml", ".env"];
// An index counts as "ready" once output/ contains a file with this extension.
export const READY_ARTIFACT_EXTENSION = ".parquet";

// Limits / misc.
export const QUERY_TIMEOUT_SECONDS = 600; // max seconds for a single query
export const INDEX_TIMEOUT_SECONDS: number | null = null; // null = no timeout
export const MAX_LOG_LINES = 5000; // live-log lines kept in memory
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // per-file upload cap (50 MB)
export const SUBPROCESS_ENCODING = "utf-8"; // try "windows-1252" if output looks garbled

// Server + paths.
export const STAGING_DIR = path.join(PROJECT_ROOT, "uploads"); // pre-index staging
export const FRONTEND_DIR = path.join(PROJECT_ROOT, "frontend");
export const HOST = "127.0.0.1";
export const PORT = 8000;
