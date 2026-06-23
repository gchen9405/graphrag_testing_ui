import { spawn, ChildProcess, SpawnOptions } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { TextDecoder } from "util";
import type { WebSocket } from "ws";

import * as config from "./config";

// =============================================================================
// runner.ts -- everything that touches the filesystem or spawns processes.
//
// Streaming: Node is single-threaded, so there is no thread<->loop bridging like
// the original Python. child_process.spawn delivers stdout/stderr asynchronously
// as 'data' events on the event loop; we split them into lines, buffer them on
// the job, and push them to every connected WebSocket. A late/reconnecting
// client gets a full replay of the buffer, then resumes live.
// =============================================================================

export type JobStatus = "idle" | "running" | "success" | "failed" | "error";

export interface StagedFile {
  name: string;
  size: number;
}

export type WsMessage =
  | { type: "line"; data: string }
  | { type: "status"; data: { status: JobStatus; returncode: number | null; error: string | null } }
  | { type: "error"; data: string };

export interface QueryResult {
  ok: boolean;
  query?: string;
  answer: string | null;
  raw_output: string;
  returncode: number | null;
  error: string | null;
}

export interface IndexStats {
  ready: boolean;
  documents: number | null;
  artifacts: number | null;
  entities: number | null;
  relationships: number | null;
  communities: number | null;
}

// -----------------------------------------------------------------------------
// Small fs type-guards
// -----------------------------------------------------------------------------
function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Encoding-aware line splitting (handles utf-8 multibyte + windows-1252, etc.)
// -----------------------------------------------------------------------------
function normalizeEncoding(enc: string): string {
  const e = enc.trim().toLowerCase();
  if (e === "utf8" || e === "utf-8") return "utf-8";
  if (e === "cp1252" || e === "windows-1252") return "windows-1252";
  if (e === "latin1" || e === "iso-8859-1") return "iso-8859-1";
  return e;
}

function makeDecoder(enc: string): TextDecoder {
  try {
    return new TextDecoder(normalizeEncoding(enc), { fatal: false });
  } catch {
    return new TextDecoder("utf-8", { fatal: false });
  }
}

/** Accumulates decoded bytes and emits complete lines (trailing \r stripped). */
class LineSplitter {
  private decoder: TextDecoder;
  private buf = "";

  constructor(encoding: string) {
    this.decoder = makeDecoder(encoding);
  }

  push(chunk: Buffer, onLine: (line: string) => void): void {
    this.buf += this.decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      let line = this.buf.slice(0, nl);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      onLine(line);
      this.buf = this.buf.slice(nl + 1);
    }
  }

  flush(onLine: (line: string) => void): void {
    this.buf += this.decoder.decode(); // flush any pending bytes
    if (this.buf.length > 0) {
      let line = this.buf;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      onLine(line);
      this.buf = "";
    }
  }
}

function decodeAll(chunks: Buffer[], enc: string): string {
  if (chunks.length === 0) return "";
  return makeDecoder(enc).decode(Buffer.concat(chunks));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// -----------------------------------------------------------------------------
// Filename safety + staging area
// -----------------------------------------------------------------------------
const SAFE_NAME_RE = /[^A-Za-z0-9._ -]/g;
// Windows reserved device names: forbidden as a basename even with an extension
// (CON.txt resolves to the console device, NUL.txt to the bit bucket, etc.).
const RESERVED_NAMES = new Set<string>([
  "CON", "PRN", "AUX", "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

export function sanitizeFilename(name: string): string {
  const slashed = name.replace(/\\/g, "/");
  let base = slashed.slice(slashed.lastIndexOf("/") + 1); // strip any directory part
  base = base.replace(SAFE_NAME_RE, "_").trim();
  base = base.replace(/[. ]+$/, ""); // Windows strips trailing dots/spaces
  base = base.replace(/^\.+/, ""); // avoid hidden/empty-stem ".txt"
  if (!base) return "file.txt";
  const first = base.split(".")[0].toUpperCase();
  if (RESERVED_NAMES.has(first)) base = "_" + base; // CON.txt -> _CON.txt
  return base;
}

export function isTxt(name: string): boolean {
  return name.toLowerCase().endsWith(".txt");
}

export function ensureStaging(): string {
  fs.mkdirSync(config.STAGING_DIR, { recursive: true });
  return config.STAGING_DIR;
}

export function listStagedFiles(): StagedFile[] {
  ensureStaging();
  const out: StagedFile[] = [];
  for (const entry of fs.readdirSync(config.STAGING_DIR)) {
    if (!isTxt(entry)) continue;
    const p = path.join(config.STAGING_DIR, entry);
    try {
      const st = fs.statSync(p);
      if (st.isFile()) out.push({ name: entry, size: st.size });
    } catch {
      /* ignore */
    }
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function uniqueDest(name: string): string {
  let dest = path.join(config.STAGING_DIR, name);
  if (!fs.existsSync(dest)) return dest;
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let i = 2;
  for (;;) {
    dest = path.join(config.STAGING_DIR, `${stem} (${i})${ext}`);
    if (!fs.existsSync(dest)) return dest;
    i += 1;
  }
}

/** Validate + persist one uploaded file. De-duplicates colliding names so an
 *  earlier file is never silently clobbered. Returns the actual on-disk name. */
export function saveUploadedFile(filename: string, data: Buffer): StagedFile {
  if (!isTxt(filename)) {
    throw new Error(`Only .txt files are accepted (got '${filename}').`);
  }
  ensureStaging();
  let safe = sanitizeFilename(filename);
  if (!isTxt(safe)) safe += ".txt";
  const dest = uniqueDest(safe);
  fs.writeFileSync(dest, data);
  return { name: path.basename(dest), size: data.length };
}

export function removeStagedFile(name: string): boolean {
  // Strip any directory part (both separators, platform-independent) as the
  // traversal guard -- but do NOT re-run sanitizeFilename here. A de-duplicated
  // staged name like "report (2).txt" would be rewritten to "report _2_.txt"
  // (parentheses aren't in the safe set), which no longer matches the file on
  // disk, so the delete would 404 and the file could never be x'd out. Staged
  // names are already sanitized at upload time, so basename + the escape check
  // and the within-staging isFile() check below are sufficient.
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "";
  if (!base || base === "." || base === "..") return false;
  const root = path.resolve(config.STAGING_DIR);
  const target = path.resolve(root, base);
  const rel = path.relative(root, target);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return false; // escape guard
  if (isFile(target)) {
    fs.unlinkSync(target);
    return true;
  }
  return false;
}

export function clearStaging(): void {
  if (!fs.existsSync(config.STAGING_DIR)) return;
  for (const entry of fs.readdirSync(config.STAGING_DIR)) {
    if (!isTxt(entry)) continue;
    try {
      fs.unlinkSync(path.join(config.STAGING_DIR, entry));
    } catch {
      /* ignore */
    }
  }
}

// -----------------------------------------------------------------------------
// Pre-flight checks + index detection
// -----------------------------------------------------------------------------
export function supportFilesStatus(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const name of config.REQUIRED_SUPPORT_FILES) {
    out[name] = isFile(path.join(config.MSGRAG_DIR, name));
  }
  return out;
}

/** True if prompts/ exists and contains at least one prompt file. */
export function hasPrompts(): boolean {
  try {
    return fs.readdirSync(config.PROMPTS_DIR).some((e) => isFile(path.join(config.PROMPTS_DIR, e)));
  } catch {
    return false;
  }
}

export function hasArtifacts(): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(config.OUTPUT_DIR);
  } catch {
    return false;
  }
  if (entries.some((e) => e.toLowerCase().endsWith(config.READY_ARTIFACT_EXTENSION))) {
    return true;
  }
  // Lenient fallback: any non-hidden file counts as "something was produced".
  return entries.some((e) => !e.startsWith(".") && isFile(path.join(config.OUTPUT_DIR, e)));
}

export function preflightIndex(): string[] {
  const problems: string[] = [];
  if (listStagedFiles().length === 0) {
    problems.push("No .txt files uploaded. Add at least one file to the corpus.");
  }
  if (config.USE_MOCK) return problems; // exe / settings checks irrelevant in mock mode
  if (!isDir(config.BASE_DIR)) problems.push(`BASE_DIR does not exist: ${config.BASE_DIR}`);
  if (!isFile(config.INDEXER_EXE)) problems.push(`Indexer executable not found: ${config.INDEXER_EXE}`);
  for (const [name, present] of Object.entries(supportFilesStatus())) {
    if (!present) problems.push(`Missing required file in ${config.MSGRAG_DIR}: ${name}`);
  }
  if (!hasPrompts()) {
    problems.push(`Prompts folder missing or empty: ${config.PROMPTS_DIR} (the indexer needs prompt files here).`);
  }
  return problems;
}

export function preflightQuery(): string[] {
  const problems: string[] = [];
  if (!hasArtifacts()) {
    problems.push("No index found. Run indexing successfully before querying.");
  }
  if (config.USE_MOCK) return problems;
  if (!isFile(config.QUERIER_EXE)) problems.push(`Querier executable not found: ${config.QUERIER_EXE}`);
  for (const [name, present] of Object.entries(supportFilesStatus())) {
    if (!present) problems.push(`Missing required file in ${config.MSGRAG_DIR}: ${name}`);
  }
  return problems;
}

// -----------------------------------------------------------------------------
// Input/output preparation
// -----------------------------------------------------------------------------
/** Recursively delete a path, clearing the Windows read-only bit on the way
 *  (the common cause of EPERM when removing *.parquet artifacts). */
function forceRemove(p: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch {
    return; // already gone
  }
  try {
    fs.chmodSync(p, 0o666);
  } catch {
    /* best effort */
  }
  if (st.isDirectory()) {
    for (const entry of fs.readdirSync(p)) forceRemove(path.join(p, entry));
    fs.rmdirSync(p);
  } else {
    fs.unlinkSync(p);
  }
}

/** Delete everything inside `dir`. Returns the paths that survived (could not be
 *  removed) so the caller can decide whether to abort. */
function clearDir(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  for (const entry of fs.readdirSync(dir)) {
    try {
      forceRemove(path.join(dir, entry));
    } catch {
      /* genuine failures are detected by the re-read below */
    }
  }
  try {
    return fs.readdirSync(dir).map((e) => path.join(dir, e));
  } catch {
    return [];
  }
}

/** Create the msgragtest skeleton (input/output/prompts) on startup so the user
 *  doesn't have to, and seed prompts/ from the bundled templates if it has none
 *  yet. Idempotent and non-destructive (never clears output, never overwrites an
 *  existing prompt); logs and continues on any error so startup can't be blocked. */
export function ensureScaffold(): void {
  try {
    fs.mkdirSync(config.INPUT_DIR, { recursive: true });
    fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });
    fs.mkdirSync(config.PROMPTS_DIR, { recursive: true });

    if (!hasPrompts() && fs.existsSync(config.SEED_PROMPTS_DIR)) {
      let copied = 0;
      for (const entry of fs.readdirSync(config.SEED_PROMPTS_DIR)) {
        const src = path.join(config.SEED_PROMPTS_DIR, entry);
        try {
          if (fs.statSync(src).isFile()) {
            fs.copyFileSync(src, path.join(config.PROMPTS_DIR, entry));
            copied += 1;
          }
        } catch {
          /* skip an unreadable seed file */
        }
      }
      if (copied) console.log(`[scaffold] created ${config.MSGRAG_DIR} and seeded ${copied} prompt file(s).`);
    }
  } catch (e) {
    console.error(`[scaffold] could not prepare ${config.MSGRAG_DIR}: ${(e as Error).message}`);
  }
}

/** Point each exe's *own-folder* `msgragtest` at the one real shared project.
 *
 *  The GraphRAG exes resolve their `msgragtest` project root RELATIVE TO THE
 *  EXECUTABLE'S OWN LOCATION, not the working directory we launch them with. With
 *  the old --onefile build the exe sat directly in BASE_DIR, so "next to the exe"
 *  and BASE_DIR/msgragtest were the same folder and it worked by coincidence. The
 *  --onedir build moves each exe down into its own bundle subfolder
 *  (BASE_DIR/graphrag_pipeline/, BASE_DIR/graphrag_querying/), so each exe now
 *  looks for BASE_DIR/<exe>/msgragtest -- which doesn't exist -- and dies with
 *  "Invalid config path: ...msgragtest is not a directory".
 *
 *  Both exes must share ONE msgragtest (the indexer writes output/, the querier
 *  reads it), so we can't just give each its own copy. Instead we create a Windows
 *  directory junction inside each exe's folder pointing at the real shared
 *  BASE_DIR/msgragtest. Junctions need no admin rights. Idempotent, best-effort:
 *  logs and continues on any error so startup is never blocked. */
export function ensureExeProjectLinks(): void {
  if (config.USE_MOCK) return; // mock mode never launches the real exes
  const base = path.resolve(config.BASE_DIR);
  const realMsgrag = path.resolve(config.MSGRAG_DIR);

  for (const exe of [config.INDEXER_EXE, config.QUERIER_EXE]) {
    try {
      const exeDir = path.resolve(path.dirname(exe));
      // Flat (--onefile) layout: the exe is in BASE_DIR, so its sibling msgragtest
      // already IS the real one -- nothing to link.
      if (exeDir === base) continue;
      // Exe folder absent (exe missing / unexpected layout): nothing to link.
      if (!isDir(exeDir)) continue;

      const link = path.join(exeDir, "msgragtest");
      let st: fs.Stats | undefined;
      try {
        st = fs.lstatSync(link);
      } catch {
        /* nothing there yet */
      }

      if (st?.isSymbolicLink()) {
        // Already a link: keep it if it still resolves to the real msgragtest,
        // otherwise replace a stale one. Resolve BOTH sides with realpathSync so
        // symlinked path components (e.g. /var -> /private/var), Windows 8.3 short
        // names, or drive-letter casing don't cause a spurious mismatch.
        let good = false;
        try {
          good = fs.realpathSync(link) === fs.realpathSync(realMsgrag);
        } catch {
          /* broken link */
        }
        if (good) continue;
        fs.rmSync(link, { recursive: true, force: true });
      } else if (st) {
        // A REAL folder sits where the link should go -- don't clobber it; the exe
        // will read that folder instead of the shared one, so warn loudly.
        console.error(
          `[scaffold] ${link} already exists as a real folder, so the indexer/querier ` +
            `won't see the shared corpus/output in ${realMsgrag}. Remove it (or move its ` +
            `contents into ${realMsgrag}) so a junction can be created.`
        );
        continue;
      }

      fs.symlinkSync(realMsgrag, link, "junction");
      console.log(`[scaffold] linked ${link} -> ${realMsgrag} (onedir msgragtest junction).`);
    } catch (e) {
      console.error(`[scaffold] could not link msgragtest for ${exe}: ${(e as Error).message}`);
    }
  }
}

/** Rebuild input/ from the currently-staged corpus, then return the file count.
 *  output/ is deliberately LEFT INTACT -- a long index is never thrown away by
 *  starting a run; clear it explicitly with clearOutput(). */
export function prepareRunDirs(): number {
  fs.mkdirSync(config.INPUT_DIR, { recursive: true });
  fs.mkdirSync(config.OUTPUT_DIR, { recursive: true }); // ensure it exists; do NOT clear it

  // Only input/ is rebuilt each run so it matches the staged corpus. (It's cheap
  // and fully reconstructable, unlike the expensive output/ artifacts.)
  const leftover = clearDir(config.INPUT_DIR);
  if (leftover.length > 0) {
    const names = leftover.slice(0, 6).map((p) => path.basename(p)).join(", ");
    const more = leftover.length > 6 ? "..." : "";
    throw new Error(
      `Could not clear ${leftover.length} stale file(s) from ${config.INPUT_DIR} ` +
        `(${names}${more}). They may be open in another program. Close them and try again.`
    );
  }

  let count = 0;
  for (const f of listStagedFiles()) {
    fs.copyFileSync(path.join(config.STAGING_DIR, f.name), path.join(config.INPUT_DIR, f.name));
    count += 1;
  }
  return count;
}

/** Explicitly wipe the indexed artifacts in output/. Destructive -- only invoked
 *  from the manual "Clear output" action, never automatically by a run. Throws
 *  if a file can't be removed (e.g. still held open). */
export function clearOutput(): void {
  fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });
  const leftover = clearDir(config.OUTPUT_DIR);
  if (leftover.length > 0) {
    const names = leftover.slice(0, 6).map((p) => path.basename(p)).join(", ");
    const more = leftover.length > 6 ? "..." : "";
    throw new Error(
      `Could not clear ${leftover.length} file(s) from ${config.OUTPUT_DIR} ` +
        `(${names}${more}). They may be open in another program (a running indexer, ` +
        `antivirus, or Windows Search). Close them and try again.`
    );
  }
}

// -----------------------------------------------------------------------------
// Subprocess plumbing (Windows-friendly)
// -----------------------------------------------------------------------------
/** Kill a child AND its descendants. A PyInstaller exe spawns worker subprocesses;
 *  on Windows child.kill() only terminates the launcher and would orphan those
 *  workers (which keep output/*.parquet handles open, breaking the next run's
 *  cleanup). taskkill /T kills the whole tree. */
function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) {
    child.kill("SIGKILL");
    return;
  }
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      child.kill("SIGKILL");
    }
  } else {
    child.kill("SIGKILL");
  }
}

function spawnOptions(): SpawnOptions {
  return {
    cwd: config.BASE_DIR, // exe resolves ./msgragtest from here
    env: {
      ...process.env,
      // Best-effort nudge to flush. For a PyInstaller-FROZEN exe this is often a
      // no-op on Windows, so live output may arrive in bursts (see README).
      PYTHONUNBUFFERED: "1",
      PYTHONIOENCODING: config.SUBPROCESS_ENCODING,
    },
    windowsHide: true, // suppress the child console window (CREATE_NO_WINDOW equiv.)
    stdio: ["ignore", "pipe", "pipe"],
  };
}

// -----------------------------------------------------------------------------
// Indexing job + manager
// -----------------------------------------------------------------------------
export class IndexingJob {
  logLines: string[] = [];
  status: JobStatus = "running";
  returncode: number | null = null;
  error: string | null = null;
  startedAt = Date.now();
  finishedAt: number | null = null;
  proc: ChildProcess | null = null;
  private subscribers = new Set<WebSocket>();

  /** Replay the buffer to a freshly-connected client, then either keep it for
   *  live lines (running) or send the terminal message and close (finished). */
  subscribe(ws: WebSocket): void {
    for (const line of this.logLines) this.sendTo(ws, { type: "line", data: line });
    if (this.status !== "running") {
      this.sendTo(ws, this.terminalMessage());
      this.closeWs(ws);
      return;
    }
    this.subscribers.add(ws);
  }

  unsubscribe(ws: WebSocket): void {
    this.subscribers.delete(ws);
  }

  addLine(line: string): void {
    this.logLines.push(line);
    if (this.logLines.length > config.MAX_LOG_LINES) {
      this.logLines.splice(0, this.logLines.length - config.MAX_LOG_LINES);
    }
    const msg: WsMessage = { type: "line", data: line };
    for (const ws of this.subscribers) this.sendTo(ws, msg);
  }

  finish(status: JobStatus, returncode: number | null, error: string | null): void {
    if (this.status !== "running") return; // idempotent: 'error' + 'close' may both fire
    this.status = status;
    this.returncode = returncode;
    this.error = error;
    this.finishedAt = Date.now();
    const msg = this.terminalMessage();
    for (const ws of this.subscribers) {
      this.sendTo(ws, msg);
      this.closeWs(ws);
    }
    this.subscribers.clear();
  }

  private terminalMessage(): WsMessage {
    return { type: "status", data: { status: this.status, returncode: this.returncode, error: this.error } };
  }

  private sendTo(ws: WebSocket, msg: WsMessage): void {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        /* client went away */
      }
    }
  }

  private closeWs(ws: WebSocket): void {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
}

class JobManager {
  current: IndexingJob | null = null;

  get isRunning(): boolean {
    return this.current !== null && this.current.status === "running";
  }

  start(fileCount: number): IndexingJob {
    const job = new IndexingJob();
    this.current = job;
    if (config.USE_MOCK) {
      void mockIndexWorker(job, fileCount);
    } else {
      realIndexWorker(job, fileCount);
    }
    return job;
  }
}

export const manager = new JobManager();

// -----------------------------------------------------------------------------
// Indexing workers
// -----------------------------------------------------------------------------
function realIndexWorker(job: IndexingJob, fileCount: number): void {
  const cmd = config.buildIndexCommand();
  job.addLine(`[runner] Launching: ${cmd.join(" ")}`);
  job.addLine(`[runner] Working directory: ${config.BASE_DIR}`);
  job.addLine(`[runner] Corpus: ${fileCount} file(s) in ${config.INPUT_DIR}`);

  let child: ChildProcess;
  try {
    child = spawn(cmd[0], cmd.slice(1), spawnOptions());
  } catch (e) {
    job.finish("error", null, `Failed to launch indexer: ${(e as Error).message}`);
    return;
  }
  job.proc = child;

  // Separate splitters per stream: keeps each stream's lines intact (no partial
  // line cross-contamination). Both feed the one merged log.
  const outSplit = new LineSplitter(config.SUBPROCESS_ENCODING);
  const errSplit = new LineSplitter(config.SUBPROCESS_ENCODING);
  child.stdout?.on("data", (c: Buffer) => outSplit.push(c, (l) => job.addLine(l)));
  child.stderr?.on("data", (c: Buffer) => errSplit.push(c, (l) => job.addLine(l)));

  let indexTimer: NodeJS.Timeout | null = null;
  const clearIndexTimer = (): void => {
    if (indexTimer) {
      clearTimeout(indexTimer);
      indexTimer = null;
    }
  };

  child.on("error", (e: NodeJS.ErrnoException) => {
    clearIndexTimer();
    if (e.code === "ENOENT") job.finish("error", null, `Executable not found: ${cmd[0]}`);
    else job.finish("error", null, `Failed to launch indexer: ${e.message}`);
  });

  child.on("close", (code, signal) => {
    clearIndexTimer();
    outSplit.flush((l) => job.addLine(l));
    errSplit.flush((l) => job.addLine(l));
    if (code === 0) {
      job.addLine("[runner] Indexer exited successfully.");
      job.finish("success", 0, null);
    } else {
      const how = code !== null ? `code ${code}` : `signal ${signal}`;
      job.addLine(`[runner] Indexer exited with ${how}.`);
      job.finish("failed", code, `Indexer exited with ${how}.`);
    }
  });

  if (config.INDEX_TIMEOUT_SECONDS != null) {
    indexTimer = setTimeout(() => {
      if (job.status === "running") {
        killProcessTree(child);
        job.finish("error", null, "Indexing timed out and was terminated.");
      }
    }, config.INDEX_TIMEOUT_SECONDS * 1000);
  }
}

async function mockIndexWorker(job: IndexingJob, fileCount: number): Promise<void> {
  const fakeLines = [
    "[runner] MOCK MODE -- not launching the real executable.",
    `[runner] Corpus: ${fileCount} file(s) in ${config.INPUT_DIR}`,
    "INFO  graphrag.index: Starting pipeline run.",
    "INFO  graphrag.index: Loading input documents...",
    `INFO  graphrag.index: Found ${fileCount} text document(s).`,
    "INFO  graphrag.index: Running workflow: create_base_text_units",
    "INFO  graphrag.index: Running workflow: extract_graph",
    "INFO  graphrag.index: Extracting entities and relationships...",
    "INFO  graphrag.index: Running workflow: create_communities",
    "INFO  graphrag.index: Summarizing community reports...",
    "INFO  graphrag.index: Running workflow: generate_text_embeddings",
    "INFO  graphrag.index: Writing artifacts to output/...",
    "INFO  graphrag.index: Pipeline run complete.",
  ];
  for (const line of fakeLines) {
    if (job.status !== "running") return;
    job.addLine(line);
    await sleep(400);
  }
  try {
    writeMockArtifacts(fileCount);
  } catch (e) {
    job.finish("error", null, `Failed to write mock artifacts: ${(e as Error).message}`);
    return;
  }
  job.addLine("[runner] MOCK indexing finished; dummy artifacts written.");
  job.finish("success", 0, null);
}

/** Write placeholder files that look like a GraphRAG output/ folder. NOTE: these
 *  are NOT valid parquet -- they exist only so the UI can detect a finished
 *  index and so the mock querier has something to point at. */
function writeMockArtifacts(fileCount: number): void {
  fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });
  const artifactNames = [
    "documents.parquet",
    "text_units.parquet",
    "entities.parquet",
    "relationships.parquet",
    "communities.parquet",
    "community_reports.parquet",
  ];
  for (const name of artifactNames) {
    fs.writeFileSync(path.join(config.OUTPUT_DIR, name), "MOCK GraphRAG artifact -- not a real parquet file.\n");
  }
  const stats = {
    mock: true,
    generated_at: new Date().toISOString(),
    input_files: fileCount,
    num_documents: fileCount,
    // Plausible derived counts so the post-index count-up has data to show in mock
    // mode (everything here is fake -- the hero shows a MOCK MODE badge).
    entities: fileCount * 23 + 11,
    relationships: fileCount * 37 + 5,
    communities: Math.max(1, Math.round(fileCount * 1.8)),
    artifacts: artifactNames,
  };
  fs.writeFileSync(path.join(config.OUTPUT_DIR, "stats.json"), JSON.stringify(stats, null, 2));
}

// -----------------------------------------------------------------------------
// Querying
// -----------------------------------------------------------------------------
export function runQuery(query: string): Promise<QueryResult> {
  if (config.USE_MOCK) return mockQuery(query);

  const cmd = config.buildQueryCommand(query);
  return new Promise<QueryResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd[0], cmd.slice(1), spawnOptions());
    } catch (e) {
      resolve(queryError(`Failed to launch querier: ${(e as Error).message}`));
      return;
    }

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout?.on("data", (c: Buffer) => outChunks.push(c));
    child.stderr?.on("data", (c: Buffer) => errChunks.push(c));

    let settled = false;
    let timedOut = false;
    const finish = (r: QueryResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, config.QUERY_TIMEOUT_SECONDS * 1000);

    child.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") finish(queryError(`Querier executable not found: ${cmd[0]}`));
      else finish(queryError(`Failed to launch querier: ${e.message}`));
    });

    child.on("close", (code, signal) => {
      const stdout = decodeAll(outChunks, config.SUBPROCESS_ENCODING);
      const stderr = decodeAll(errChunks, config.SUBPROCESS_ENCODING);
      const raw = combineStreams(stdout, stderr);
      if (timedOut) {
        finish(queryError(`Query timed out after ${config.QUERY_TIMEOUT_SECONDS}s.`, raw));
        return;
      }
      if (code !== 0) {
        const how = code !== null ? `code ${code}` : `signal ${signal}`;
        finish(queryError(`Querier exited with ${how}.`, raw, code));
        return;
      }
      finish({
        ok: true,
        query,
        answer: stdout.trim(), // the exe prints the answer to stdout
        raw_output: raw,
        returncode: code,
        error: null,
      });
    });
  });
}

function combineStreams(stdout: string, stderr: string): string {
  const parts: string[] = [];
  if (stdout) parts.push(stdout.replace(/\s+$/, ""));
  if (stderr && stderr.trim()) parts.push("----- stderr -----\n" + stderr.replace(/\s+$/, ""));
  return parts.join("\n");
}

function queryError(message: string, rawOutput = "", returncode: number | null = null): QueryResult {
  return { ok: false, answer: null, raw_output: rawOutput, returncode, error: message };
}

async function mockQuery(query: string): Promise<QueryResult> {
  await sleep(1000); // pretend the LLM is thinking
  const answer =
    "**[MOCK response]**\n\n" +
    `You asked: "${query}"\n\n` +
    "This is a canned answer returned because USE_MOCK is true. The real " +
    "graphrag_querying.exe would search the indexed msgragtest/output artifacts " +
    "and return a grounded answer here.\n\n" +
    "Set USE_MOCK = false in src/config.ts to query for real.";
  // The answer is stdout; logs go to stderr (kept in the raw-output panel).
  const fakeStderr =
    "INFO  graphrag.query: Loading artifacts from output/...\n" +
    "INFO  graphrag.query: Running search.";
  return {
    ok: true,
    query,
    answer,
    raw_output: combineStreams(answer, fakeStderr),
    returncode: 0,
    error: null,
  };
}

// -----------------------------------------------------------------------------
// Status snapshot for the frontend (keys must match the original API exactly)
// -----------------------------------------------------------------------------
export function statusSnapshot(): Record<string, unknown> {
  const job = manager.current;
  const indexStatus: JobStatus = job === null ? "idle" : job.status;
  return {
    use_mock: config.USE_MOCK,
    base_dir: config.BASE_DIR,
    msgragtest_dir: config.MSGRAG_DIR,
    msgragtest_present: isDir(config.MSGRAG_DIR),
    prompts_dir: config.PROMPTS_DIR,
    prompts_present: hasPrompts(),
    input_dir: config.INPUT_DIR,
    output_dir: config.OUTPUT_DIR,
    indexer_exe: config.INDEXER_EXE,
    indexer_present: isFile(config.INDEXER_EXE),
    querier_exe: config.QUERIER_EXE,
    querier_present: isFile(config.QUERIER_EXE),
    support_files: supportFilesStatus(),
    staged_files: listStagedFiles(),
    index_status: indexStatus,
    index_ready: hasArtifacts(),
    index_running: manager.isRunning,
  };
}

// -----------------------------------------------------------------------------
// Best-effort numeric summary of the finished index, for the UI count-up (#4).
// Truthful + partial: counts what's cheap to know (input docs, output files) and
// passes through entity/relationship/community counts only when stats.json carries
// them. Real GraphRAG .parquet row-counts are NOT parsed (no parquet dependency),
// so those stay null in live mode until that's wired; mock mode writes them.
// -----------------------------------------------------------------------------
export function indexStats(): IndexStats {
  const out: IndexStats = {
    ready: hasArtifacts(),
    documents: null,
    artifacts: null,
    entities: null,
    relationships: null,
    communities: null,
  };
  try {
    out.documents = fs.readdirSync(config.INPUT_DIR).filter(isTxt).length;
  } catch {
    /* no input dir yet */
  }
  try {
    out.artifacts = fs
      .readdirSync(config.OUTPUT_DIR)
      .filter((e) => !e.startsWith(".") && isFile(path.join(config.OUTPUT_DIR, e))).length;
  } catch {
    /* no output dir yet */
  }
  try {
    const s = JSON.parse(
      fs.readFileSync(path.join(config.OUTPUT_DIR, "stats.json"), "utf-8")
    ) as Record<string, unknown>;
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    out.entities = num(s.entities);
    out.relationships = num(s.relationships);
    out.communities = num(s.communities);
    if (out.documents == null) out.documents = num(s.num_documents) ?? num(s.input_files);
  } catch {
    /* no/unreadable stats.json */
  }
  return out;
}
