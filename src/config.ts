import * as fs from "fs";
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

// In development we run via a runtime (node/bun/tsx), whose binary is process.execPath;
// in a shipped single-file build, process.execPath IS our own exe. Two defaults below
// key off this difference: where runtime data lives, and whether mock mode is on.
// Heuristic: the dev runtime's exe is named node*/bun* -- so don't name the shipped exe that.
const RUNTIME_EXE = path.basename(process.execPath).toLowerCase();
const STANDALONE = !(RUNTIME_EXE.startsWith("node") || RUNTIME_EXE.startsWith("bun"));

// Source-tree root in dev (relative to the compiled JS). Holds the EMBEDDED assets
// (frontend/, assets/prompts/). NOTE: in a single-file build this points inside the
// binary's virtual FS, so disk-relative reads of those folders need the embed step.
const PROJECT_ROOT = path.resolve(__dirname, "..");

// Where on-disk RUNTIME DATA lives (graphrag_runtime/, uploads/): the project root in
// dev, or the folder holding the shipped exe in a standalone build -- i.e. right next
// to graphrag-ui.exe, which is where graphrag_runtime/ ships.
const APP_DIR = STANDALONE ? path.dirname(process.execPath) : PROJECT_ROOT;

// MOCK MODE: true = don't launch the real exes (fake logs + dummy artifacts +
// canned answer; runs on any OS). false = run the real exes.
// Default keys off the build: mock in development (no exes on the dev machine), live
// in a shipped standalone build. Override either way:  set GRAPHRAG_USE_MOCK=0 / =1
export const USE_MOCK: boolean = envFlag("GRAPHRAG_USE_MOCK", !STANDALONE);

// The folder that contains BOTH executables AND the msgragtest folder. Defaults to
// graphrag_runtime/ next to the app (project root in dev; the shipped exe's folder in a
// standalone build). Override with an absolute path:  set GRAPHRAG_BASE_DIR=C:\graphrag
export const BASE_DIR: string = path.resolve(
  expandUser(process.env.GRAPHRAG_BASE_DIR ?? path.join(APP_DIR, "graphrag_runtime"))
);

// Executable file names.
export const INDEXER_EXE_NAME = "graphrag_pipeline.exe";
export const QUERIER_EXE_NAME = "graphrag_querying.exe";

// Locate each exe. The exes are PyInstaller *onedir* builds: a .exe is NOT
// self-contained -- it must sit beside its own _internal/ folder (the bundled
// python3XX.dll etc.), found relative to the exe's own location. So the two
// bundles live in SEPARATE subfolders of BASE_DIR (otherwise their _internal/
// folders would collide). The subfolder is named after the exe's stem, which is
// exactly PyInstaller's dist/<name>/ output -- so you just copy your two dist
// folders into BASE_DIR as-is:
//
//   <BASE_DIR>\graphrag_pipeline\graphrag_pipeline.exe  + _internal\
//   <BASE_DIR>\graphrag_querying\graphrag_querying.exe  + _internal\
//
// cwd is still BASE_DIR at launch (see runner.spawnOptions), so the exes'
// hard-coded relative msgragtest\ path resolves no matter where the .exe lives.
// A flat .exe directly in BASE_DIR (e.g. a future --onefile build) is accepted
// as a fallback, so the old self-contained layout keeps working too.
function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
function resolveExe(name: string): string {
  const stem = path.basename(name, path.extname(name)); // graphrag_pipeline.exe -> graphrag_pipeline
  const inSubdir = path.join(BASE_DIR, stem, name); // onedir bundle (preferred)
  const flat = path.join(BASE_DIR, name); // self-contained .exe (fallback)
  if (fileExists(inSubdir)) return inSubdir;
  if (fileExists(flat)) return flat;
  return inSubdir; // neither present yet: report the onedir path in errors
}
export const INDEXER_EXE = resolveExe(INDEXER_EXE_NAME);
export const QUERIER_EXE = resolveExe(QUERIER_EXE_NAME);

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

// On startup the app creates the msgragtest skeleton and, if prompts/ is empty,
// seeds it from these bundled templates (tracked in the repo, so a fresh clone is
// ready to index). Existing prompts are never overwritten. Delete this folder if
// you'd rather the app only create an empty prompts/ for you to fill yourself.
// Shipped LOOSE next to the exe (under APP_DIR), so a compiled build reads the seed
// templates off disk -- assets/prompts/ ships alongside graphrag-ui.exe. In dev,
// APP_DIR is the repo root, so this resolves to the repo's assets/prompts/.
export const SEED_PROMPTS_DIR = path.join(APP_DIR, "assets", "prompts");

// Files that must sit inside msgragtest/ -- the GraphRAG project root the exes read
// (checked for friendly errors in live mode).
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
export const STAGING_DIR = path.join(APP_DIR, "uploads"); // pre-index staging (written next to the exe at runtime)
// Static UI served to the browser. Shipped LOOSE next to the exe (under APP_DIR):
// frontend/ ships alongside graphrag-ui.exe; in dev APP_DIR is the repo root.
export const FRONTEND_DIR = path.join(APP_DIR, "frontend");
export const HOST = "127.0.0.1";
export const PORT = 8000;
