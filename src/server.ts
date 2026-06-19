import type { Server } from "http";

import busboy from "busboy";
import express, { Request, Response } from "express";
import { WebSocketServer } from "ws";

import * as config from "./config";
import * as runner from "./runner";

export const app = express();

// JSON body parsing for /api/query etc. (multipart bodies are untouched and are
// handled by busboy in the upload route).
app.use(express.json());

// FastAPI returned errors as {"detail": <string | {problems: [...]}>}; the
// frontend reads `body.detail`, so we mirror that shape exactly.
function httpError(res: Response, status: number, detail: unknown): void {
  res.status(status).json({ detail });
}

// -----------------------------------------------------------------------------
// Status / config
// -----------------------------------------------------------------------------
app.get("/api/status", (_req: Request, res: Response) => {
  res.json(runner.statusSnapshot());
});

// -----------------------------------------------------------------------------
// Upload / staging
// -----------------------------------------------------------------------------
app.get("/api/files", (_req: Request, res: Response) => {
  res.json({ files: runner.listStagedFiles() });
});

app.post("/api/upload", (req: Request, res: Response) => {
  const cap = config.MAX_UPLOAD_BYTES;
  let bb: ReturnType<typeof busboy>;
  try {
    bb = busboy({ headers: req.headers, limits: { fileSize: cap, files: 200 } });
  } catch {
    httpError(res, 400, "Invalid multipart upload.");
    return;
  }

  const saved: runner.StagedFile[] = [];
  const rejected: { name: string; reason: string }[] = [];
  let responded = false;
  const respond = (): void => {
    if (responded) return;
    responded = true;
    res.json({ saved, rejected, files: runner.listStagedFiles() });
  };

  bb.on("file", (_field, stream, info) => {
    const filename = info.filename ?? "";
    if (!runner.isTxt(filename)) {
      rejected.push({ name: filename, reason: "not a .txt file" });
      stream.resume(); // drain so busboy continues
      return;
    }
    const chunks: Buffer[] = [];
    let tooBig = false;
    stream.on("data", (d: Buffer) => {
      if (!tooBig) chunks.push(d);
    });
    stream.on("limit", () => {
      tooBig = true; // busboy truncated this file at the size cap (bounded memory)
      chunks.length = 0;
    });
    stream.on("close", () => {
      if (tooBig) {
        rejected.push({ name: filename, reason: `exceeds ${Math.floor(cap / (1024 * 1024))} MB limit` });
        return;
      }
      const data = Buffer.concat(chunks);
      if (data.length === 0) {
        rejected.push({ name: filename, reason: "empty file" });
        return;
      }
      try {
        saved.push(runner.saveUploadedFile(filename, data));
      } catch (e) {
        rejected.push({ name: filename, reason: (e as Error).message });
      }
    });
  });

  bb.on("filesLimit", () => {
    // busboy silently skips files past the cap; surface it so the user is told.
    rejected.push({ name: "(additional files)", reason: "exceeds 200-file per-upload limit" });
  });
  bb.on("close", respond);
  bb.on("error", (e: unknown) => {
    if (responded) return;
    responded = true;
    httpError(res, 400, `Upload failed: ${(e as Error).message ?? e}`);
  });

  req.pipe(bb);
});

app.delete("/api/files/:name", (req: Request, res: Response) => {
  const removed = runner.removeStagedFile(req.params.name);
  if (!removed) {
    httpError(res, 404, `No staged file named '${req.params.name}'.`);
    return;
  }
  res.json({ removed: req.params.name, files: runner.listStagedFiles() });
});

// -----------------------------------------------------------------------------
// Indexing
// -----------------------------------------------------------------------------
app.post("/api/index/start", (_req: Request, res: Response) => {
  if (runner.manager.isRunning) {
    httpError(res, 409, "Indexing is already running.");
    return;
  }
  const problems = runner.preflightIndex();
  if (problems.length > 0) {
    httpError(res, 400, { problems });
    return;
  }
  let fileCount: number;
  try {
    fileCount = runner.prepareRunDirs();
  } catch (e) {
    httpError(res, 500, `Could not prepare run folders: ${(e as Error).message}`);
    return;
  }
  if (fileCount === 0) {
    httpError(res, 400, { problems: ["Corpus is empty."] });
    return;
  }
  runner.manager.start(fileCount);
  res.json({ started: true, file_count: fileCount, use_mock: config.USE_MOCK });
});

app.get("/api/index/status", (_req: Request, res: Response) => {
  const job = runner.manager.current;
  if (job === null) {
    res.json({ status: "idle", lines: [], returncode: null, error: null });
    return;
  }
  res.json({
    status: job.status,
    lines: [...job.logLines],
    returncode: job.returncode,
    error: job.error,
    index_ready: runner.hasArtifacts(),
  });
});

// Manually wipe the indexed artifacts in output/ (explicit, destructive).
app.post("/api/output/clear", (_req: Request, res: Response) => {
  if (runner.manager.isRunning) {
    httpError(res, 409, "Cannot clear output while indexing is running.");
    return;
  }
  try {
    runner.clearOutput();
  } catch (e) {
    httpError(res, 500, (e as Error).message);
    return;
  }
  res.json({ cleared: true, index_ready: runner.hasArtifacts() });
});

// -----------------------------------------------------------------------------
// Querying
// -----------------------------------------------------------------------------
app.post("/api/query", async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as { query?: unknown };
    // Validate at runtime -- the JSON body is untrusted `any`, so don't trust the cast.
    const query = (typeof body.query === "string" ? body.query : "").trim();
    if (!query) {
      httpError(res, 400, "Query text is empty.");
      return;
    }
    const problems = runner.preflightQuery();
    if (problems.length > 0) {
      httpError(res, 409, { problems });
      return;
    }
    const result = await runner.runQuery(query);
    // 200 even when ok=false, so the frontend can show raw_output alongside the error.
    res.json(result);
  } catch (e) {
    httpError(res, 500, `Query failed: ${(e as Error).message}`);
  }
});

// -----------------------------------------------------------------------------
// Reset
// -----------------------------------------------------------------------------
app.post("/api/reset", (_req: Request, res: Response) => {
  if (runner.manager.isRunning) {
    httpError(res, 409, "Cannot reset while indexing is running.");
    return;
  }
  runner.clearStaging();
  runner.manager.current = null;
  res.json({ reset: true, files: runner.listStagedFiles() });
});

// -----------------------------------------------------------------------------
// Static frontend (registered AFTER /api routes so those win)
// -----------------------------------------------------------------------------
app.get("/", (_req: Request, res: Response) => {
  res.sendFile("index.html", { root: config.FRONTEND_DIR });
});
app.use(express.static(config.FRONTEND_DIR));

// -----------------------------------------------------------------------------
// WebSocket: /ws/index  (live indexing log stream)
// -----------------------------------------------------------------------------
export function attachWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws/index" });
  // ws re-emits the http server's 'error' onto the WebSocketServer; without a
  // handler here that re-emit would throw (Node's unhandled 'error' event) and
  // crash before index.ts's server 'error' handler can report it cleanly. We
  // swallow the duplicate EADDRINUSE (index.ts reports it + exits) and log the rest.
  wss.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EADDRINUSE") console.error("[ws] server error:", err.message);
  });
  wss.on("connection", (ws) => {
    const job = runner.manager.current;
    if (job === null) {
      try {
        ws.send(JSON.stringify({ type: "error", data: "No indexing job is running." }));
        ws.close();
      } catch {
        /* ignore */
      }
      return;
    }
    ws.on("close", () => job.unsubscribe(ws));
    ws.on("error", () => job.unsubscribe(ws));
    job.subscribe(ws); // replays the buffer, then streams live lines
  });
  return wss;
}
