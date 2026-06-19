# Packaging & shipping

How to turn this repo into the single-folder deliverable for the end user.

**Where this happens:** on the **Windows work computer** (where the two GraphRAG exes
+ `settings.yaml` + `.env` live). The end user is on Windows too — the GraphRAG exes
are Windows-only — so building on Windows means building on the deployment OS, with no
cross-compilation. Your personal Mac is for mock-mode development only.

---

## Mock vs. live is automatic

`src/config.ts` detects how it's running (see the `STANDALONE` check):

- **Run via a runtime** (`node` / `tsx` / `bun run`) → **mock mode** (no exes needed).
- **The compiled `.exe`** → **live mode** (runs the real exes).

No env vars required. To force either way: `set GRAPHRAG_USE_MOCK=1` (mock) or `=0` (live).

`BASE_DIR` and `uploads/` resolve **next to the running exe** in a compiled build, and
to the repo root in dev. The UI (`frontend/`) and prompt seeds (`assets/prompts/`) are
shipped **loose** next to the exe and read off disk.

---

## Prerequisites (work computer)

- Windows + admin (to install Bun)
- [Bun](https://bun.sh) — `npm i -g bun`, or the standalone installer
- Git access to this repo
- The four runtime files, already on this machine:
  - `graphrag_pipeline.exe`, `graphrag_querying.exe`
  - `settings.yaml`, `.env`

---

## Build steps

```powershell
# 1. Get the code + deps
git clone https://github.com/gchen9405/graphrag_testing_ui.git
cd graphrag_testing_ui
bun install

# 2. Put the four runtime files in place (creates the folders if needed)
#    - the two exes go directly in graphrag_runtime\
#    - settings.yaml + .env go in graphrag_runtime\msgragtest\
mkdir graphrag_runtime\msgragtest -Force
copy <path>\graphrag_pipeline.exe   graphrag_runtime\
copy <path>\graphrag_querying.exe   graphrag_runtime\
copy <path>\settings.yaml           graphrag_runtime\msgragtest\
copy <path>\.env                    graphrag_runtime\msgragtest\
```

```powershell
# 3. VERIFY THE CLI FLAGS (live) before compiling.
#    Run the app in live mode and do one index + one query through the UI:
set GRAPHRAG_USE_MOCK=0
bun run dev            # opens http://127.0.0.1:8000
```

If indexing or querying fails because the real exes expect different arguments, fix
`buildIndexCommand` / `buildQueryCommand` in `src/config.ts` (defaults are
`graphrag_pipeline.exe index` and `graphrag_querying.exe "<query>"`). Re-test until a
real index + query works end to end.

```powershell
# 4. Compile the wrapper into a single exe
npm run compile        # -> graphrag-ui.exe   (bun build --compile)
```

```powershell
# 5. Assemble the ship folder (run from the repo root)
$ship = "..\GraphRAG-UI"
New-Item -ItemType Directory -Force -Path $ship | Out-Null
Copy-Item graphrag-ui.exe $ship
Copy-Item -Recurse -Force frontend "$ship\frontend"
New-Item -ItemType Directory -Force -Path "$ship\assets" | Out-Null
Copy-Item -Recurse -Force assets\prompts "$ship\assets\prompts"
Copy-Item -Recurse -Force graphrag_runtime "$ship\graphrag_runtime"

# drop the dev corpus + any mock/test artifacts from the shipped copy:
Remove-Item -Recurse -Force "$ship\graphrag_runtime\msgragtest\input\*"  -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$ship\graphrag_runtime\msgragtest\output\*" -ErrorAction SilentlyContinue
```

```powershell
# 6. Smoke-test the assembled build, then zip it
..\GraphRAG-UI\graphrag-ui.exe        # double-click; UI should load + a live query should work
Compress-Archive -Path ..\GraphRAG-UI -DestinationPath ..\GraphRAG-UI.zip
```

Hand `GraphRAG-UI.zip` to the user: they unzip and double-click `graphrag-ui.exe`.

---

## Shipped folder layout

```
GraphRAG-UI\
├── graphrag-ui.exe              ← the wrapper (user double-clicks this)
├── frontend\                    ← UI, read off disk by the exe
├── assets\
│   └── prompts\                 ← prompt seed templates
└── graphrag_runtime\
    ├── graphrag_pipeline.exe
    ├── graphrag_querying.exe
    └── msgragtest\
        ├── settings.yaml
        ├── .env
        └── (input\, output\, prompts\ are created on first launch)
```

## Pre-zip checklist

- [ ] `graphrag_runtime\msgragtest\input\` and `output\` are empty (no dev corpus / mock artifacts)
- [ ] `settings.yaml` + `.env` are in `msgragtest\` (not next to the exes)
- [ ] you ran a real index + query against the assembled exe and it worked
- [ ] `settings.yaml` / `.env` contents are what you intend to share (the API key ships in `.env`)

> Note: `.env` carries your API key in plaintext inside the zip. That's accepted for a
> single trusted user — just confirm sharing it is within your employer's policy.
