# GraphRAG Test UI

A small local web app (**Node.js + TypeScript** backend + vanilla JS frontend) that
wraps two Windows GraphRAG 2.7.0 executables so you can **drop in `.txt` files → run
indexing (with live logs) → ask questions** — all from the browser.

The backend is Node/TypeScript on purpose: the GraphRAG executables are PyInstaller
builds so the target machine needs **no Python**, and a Node backend keeps it that
way (the only Python-built artifacts are the self-contained `.exe` files themselves).

It ships with a **mock mode** (on by default) so you can click through the entire
flow on any OS *without* the real executables, then flip one flag to go live.

```
┌── Upload ──┐   ┌── Index ──────────────┐   ┌── Query ──────────┐
│ drag .txt  │ → │ graphrag_pipeline.exe │ → │ graphrag_querying │
│ files      │   │ live stdout/stderr    │   │ ask & get answer  │
└────────────┘   └───────────────────────┘   └───────────────────┘
        writes msgragtest\input\   →   reads/writes msgragtest\output\
```

---

## 1. Requirements

- Node.js 18+ (developed on 20/22/23)
- The two executables (only needed for **live** mode):
  - `graphrag_pipeline.exe` (indexing)
  - `graphrag_querying.exe` (querying)
  - plus their existing `settings.yaml` and `.env`, sitting next to them.

  The `msgragtest/` folder and its `prompts/` are **created automatically on startup**
  — `prompts/` is seeded from the bundled templates in `assets/prompts/` (your own
  prompts in `msgragtest/prompts/` are never overwritten). To change the seed, edit
  the files in `assets/prompts/`; to manage prompts entirely by hand, delete that
  folder and the app will just create an empty `prompts/` for you.

## 2. Install & run

```bash
npm install
npm start
```

Open **http://127.0.0.1:8000**.

`npm start` runs `tsc` first (so you get a full type-check) and then launches the
compiled server. By default `USE_MOCK = true`, so it runs immediately with fake
streamed logs, dummy artifacts, and a canned query answer — no executables needed.

Other scripts:

| command | what it does |
|---|---|
| `npm start` | type-check (`tsc`) + run `dist/index.js` |
| `npm run dev` | run from source with auto-reload (`tsx watch`) |
| `npm run build` | compile `src/` → `dist/` |
| `npm run typecheck` | type-check only (`tsc --noEmit`) |

## 3. Going live (real executables, on Windows)

1. Open **`src/config.ts`**.
2. Set `USE_MOCK = false`.
3. Point **`BASE_DIR`** at the folder that contains **both** executables **and** the
   `msgragtest` folder, e.g.:
   ```ts
   export const BASE_DIR: string = "C:\\graphrag";
   ```
4. `npm start`.

### Folder layout that `BASE_DIR` must point at

```
<BASE_DIR>\                       e.g. C:\graphrag
├── graphrag_pipeline.exe         ┐ you place these 4
├── graphrag_querying.exe         │
├── settings.yaml                 │
├── .env                          ┘
└── msgragtest\                   ← created by the app on startup
    ├── prompts\                  ← created + seeded from assets/prompts/ on startup
    │   ├── extract_graph.txt
    │   └── …
    ├── input\                    ← created by the app; uploaded corpus lands here
    └── output\                   ← created by the app; indexer writes artifacts here
```

You only place the **4 files** (exes + `settings.yaml` + `.env`). The app creates
`msgragtest\` with `input\`, `output\`, and a seeded `prompts\` for you on startup.
On each run it rebuilds only `input\` from your staged corpus; **`output\` is
preserved** (so a long index is never lost by starting a run — wipe it only with the
**Clear output** button), and **`prompts\` (and anything else under `msgragtest\`) is
left untouched.**

The app launches each executable with its working directory set to `BASE_DIR`, so
the exe's hard-coded relative `msgragtest\` path resolves correctly. **No copying or
syncing between folders happens** — both exes share the one `msgragtest` folder.

You can also override without editing the file, via environment variables:

```bat
set GRAPHRAG_USE_MOCK=0
set GRAPHRAG_BASE_DIR=C:\graphrag
npm start
```

---

## 4. Config constants you'll likely need to edit (all in `src/config.ts`)

Listed in rough order of how likely you are to touch them:

| Constant / function | What it is | When to change it |
|---|---|---|
| **`USE_MOCK`** | mock vs. real executables | Set `false` to use the real exes. |
| **`BASE_DIR`** | folder holding the exes + `msgragtest` | **Almost always** — point it at your real path (absolute). |
| **`buildQueryCommand(query)`** | the querier's full argv array | Default is `graphrag_querying.exe "<query>"`. Edit if your exe takes different arguments. |
| **`buildIndexCommand()`** | the indexer's full argv array | Default is `graphrag_pipeline.exe index`. Edit if your exe takes different arguments. |
| `INDEXER_EXE_NAME` / `QUERIER_EXE_NAME` | exe filenames | If your exes are named differently. |
| `SUBPROCESS_ENCODING` | stdout decode | Switch to `"windows-1252"` if you see garbled (mojibake) characters on Windows. |
| `QUERY_TIMEOUT_SECONDS`, `INDEX_TIMEOUT_SECONDS` | timeouts | Tune for slow models / large corpora. |
| `READY_ARTIFACT_EXTENSION` | how "index is ready" is detected | If your output artifacts aren't `.parquet`. |
| `MAX_UPLOAD_BYTES` | per-file upload cap | Raise/lower the 50 MB limit. |
| `HOST`, `PORT` | server bind | If port 8000 is taken. |

> The defaults are `graphrag_pipeline.exe index` and `graphrag_querying.exe "<query>"`.
> If your exes take different arguments, the two `build*Command` functions in
> `src/config.ts` are the only thing you edit.

---

## 5. How it works (brief)

- **Upload**: drag-and-drop individual `.txt` files **or a whole folder** (dropped
  or via "Choose a folder"); folders are walked recursively and non-`.txt` files
  are ignored. Files upload in batches so large corpora work, with `.txt`-only
  validation, a per-file size cap, and filenames sanitized (path-traversal +
  Windows reserved-name safe), staged under `uploads/` (not yet in `msgragtest`).
  List/remove via `GET`/`DELETE /api/files`.
- **Index** (`POST /api/index/start`): pre-flight checks → rebuilds `msgragtest\input\`
  from the staged corpus → `spawn`s the indexer. It does **not** touch
  `msgragtest\output\`, so an in-progress or completed index is never wiped just by
  starting a run. Merged stdout/stderr is streamed over **WebSocket `/ws/index`**; the
  log is also buffered so a reconnecting/late browser gets a full replay then resumes live.
- **Clear output** (`POST /api/output/clear`): explicit, destructive — wipes
  `msgragtest\output\` for a fresh index. Confirmed in the UI and blocked while a run
  is in progress.
- **Query** (`POST /api/query`): pre-flight (must have an index) → runs the querier
  as `exe "<query>"`, returns the answer (from stdout) plus the raw output
  (stdout+stderr) in an expandable panel. Ask as many questions as you like without
  re-indexing.

### Mock mode specifics
- Indexing emits fake log lines (~5 s) then writes **placeholder** files named like
  real artifacts (`entities.parquet`, …) into `msgragtest\output\`. These are
  **not** valid parquet — they only let the UI detect "index ready".
- Querying returns a canned response that echoes your question.

---

## 6. Known limitations / gotchas

- **Live-log buffering with frozen exes (the big one).** PyInstaller-frozen exes
  often **block-buffer** stdout on Windows, and `PYTHONUNBUFFERED` is typically a
  no-op for them. So in live mode the log may arrive in **bursts** (or only at
  process exit) rather than smoothly line-by-line. The indexing result is still
  correct; only the *liveness* of the log is affected. (Mock mode always streams
  smoothly.)
- **`.exe` is Windows-only.** Live mode requires Windows. Mock mode runs anywhere.
- **Single user.** No auth, no concurrency control beyond "one index run at a time"
  — by design for a local tool.
- The dummy mock artifacts are not loadable by the real querier; mock query returns
  a canned answer instead of reading them.

---

## 7. Project layout

```
graphrag-test-frontend/
├── src/
│   ├── config.ts     # ALL tunable constants + command builders (start here)
│   ├── runner.ts     # subprocess job manager, streaming, mock + real workers
│   ├── server.ts     # Express routes + WebSocket
│   └── index.ts      # entry point (http server + listen)
├── frontend/
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── package.json · tsconfig.json · README.md
```

Generated (git-ignored): `node_modules/`, `dist/` (compiled JS), `uploads/` (staged
files), and — in mock mode — `graphrag_runtime/msgragtest/`.
