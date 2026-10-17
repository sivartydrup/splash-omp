# splash-omp

Makes [oh-my-pi](https://github.com/can1357/oh-my-pi) (**omp**) self-sufficient for a local
[Splash](https://github.com/incoai/splash) model server. One file, no dependencies:

- An **omp extension** that probes the local server, spawns `splash serve` (detached) if it is
  down, shows load progress on the status line, and holds the first prompt until the model is
  ready — so `omp` just *works* even when the server isn't running yet.
- The **omp config** (provider catalog + model roles) from a working setup, ready to reuse on
  another Mac or to re-apply here.

The spawned server keeps running after omp exits (it is a normal detached process).

## How it works

```
omp session start
  └─ probe http://127.0.0.1:8000/ready
       ├─ 200 → done (fast path, one request)
       └─ refused → spawn: splash serve --model <SPLASH_M1_MODEL>   (detached)
            └─ background poller: status line "splash: loading…" → clears + notifies on ready

before each prompt
  └─ still not ready? wait up to ~22 s (bounded) → dispatch the prompt
```

Splash semantics the extension relies on (verified against Splash 1.3.2-m1.1):

- the port binds before the model loads, but the socket only accepts after the runtime is ready,
  so a loading server answers `ECONNREFUSED` — the probe is unambiguous;
- once accepting, `/ready` is `200` iff ready, `503` while recovering;
- idle weight release keeps `/ready` at `200`; the next request restores the weights, so no
  special handling is needed;
- a duplicate `serve` on an occupied port fails fast at bind time, so concurrent omp instances
  cannot pile up servers.

## Requirements

- Apple silicon Mac; [Homebrew](https://brew.sh)
- Splash: `brew install incoai/tap/splash` (provides the `splash` CLI)
- omp ("Oh My Pi") with config dir `~/.omp/agent/`
- Unified memory for the model: 4-bit Qwen3.8-27B needs ≥ 36 GB (48 GB recommended); smaller
  GGUF variants run on 24 GB Macs (see upstream [models](https://github.com/incoai/splash#models))

The first serve downloads the model and its matching DFlash2 draft from Hugging Face; later
starts reuse the cache.

## Quick start

```bash
git clone https://github.com/sivartydrup/splash-omp.git ~/coding/splash-omp
cd ~/coding/splash-omp
./scripts/install.sh
omp            # from any project; the server comes up automatically
```

`install.sh` is idempotent and never overwrites in place: it installs
`extensions/splash-m1.ts` → `~/.omp/agent/extensions/`, copies `config/models.yml` /
`config/config.yml` when they don't exist, and only appends provider blocks that are missing
from an existing `models.yml`. Every pre-existing file gets a `.bak-<timestamp>` copy first.

Use `./scripts/install.sh --uninstall` to remove what it installed.

## Configuration

All knobs are environment variables, read when omp starts (see the header of
[`extensions/splash-m1.ts`](extensions/splash-m1.ts)):

| Variable | Meaning | Default |
| --- | --- | --- |
| `SPLASH_M1_URL` | server base URL | `http://127.0.0.1:8000` |
| `SPLASH_M1_MODEL` | model for `splash serve --model` | `mlx-community/Qwen3.8-27B-4bit` |
| `SPLASH_M1_PROVIDERS` | comma-separated provider names in `models.yml` that this extension manages | `splash-m1` |
| `SPLASH_M1_BIN` | explicit splash binary path | `which splash-m1` then `which splash` |
| `SPLASH_M1_DISABLE` | `1` turns the extension off | — |

Example — serve the GGUF build instead of the MLX build:

```bash
SPLASH_M1_MODEL=unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M omp
```

The provider catalog and roles live in omp's config (installed from
[`config/models.yml`](config/models.yml) and [`config/config.yml`](config/config.yml)):
- `models.yml` declares the `splash-m1` provider (`http://127.0.0.1:8000/v1`, OpenAI
  completions, no auth) with its models, plus `splash-review` (bounded-context review copy)
  and `splash-local` (manual) — all on the same server.
- `config.yml` maps roles: the main session runs
  `splash-m1/mlx-community/Qwen3.8-27B-4bit:low` (low reasoning effort), and task agents
  (`local-worker`, `task`) run the same served model.

## Serving a different model

**One server = one model.** The `model` field of a request is validated against the model the
server loaded; naming any other model — even one listed in `models.yml` — returns `404`.
(Verified: the served MLX id and an empty string get `200`; a non-served id gets `404`.)

So the pattern is always: **serve X → point your roles at X**.

- Switch the whole setup: `SPLASH_M1_MODEL=<owner/repo[:variant]> omp` and edit `modelRoles`
  in `~/.omp/agent/config.yml` to match.
- Keep both catalogs in `models.yml`; they are just a menu. Only the served one works at a time.
- **Aliases** (same weights, another name): `splash serve --model X --served-model-name Y`
  accepts requests naming `Y` too, but responds as `X` — useful when a client hard-codes a name.
- **Two different models** (e.g. a big model for the main session, a small one for subagents):
  run two servers on two ports (`splash serve --model small --port 8001`) and add a second
  provider in `models.yml` (`baseUrl: http://127.0.0.1:8001/v1`). Point the roles at the two
  providers, and set `SPLASH_M1_PROVIDERS=splash-m1,splash-small` so the extension manages
  both servers.

Models Splash supports (upstream list): Qwen3.8-27B and Qwen3.6-35B-A3B as
`unsloth/<name>-GGUF` (1–8-bit variants) or `mlx-community/<name>-4bit`, e.g.:

```
mlx-community/Qwen3.8-27B-4bit            4-bit MLX, 36 GB+ recommended
unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M        4.5-bit GGUF, 36 GB+ recommended
unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q4_K_M    MoE, 24 GB-friendly variants exist
```

Per-model omp flags to copy from [`config/models.yml`](config/models.yml): `thinkingFormat:
qwen-chat-template`, `supportsReasoningEffort` (true for models that take `reasoning_effort`),
`contextWindow` / `maxTokens`, `supportsTools`, `input: [text, image]`.

## What's where

| Path | Purpose |
| --- | --- |
| `~/.omp/agent/extensions/splash-m1.ts` | the extension (auto-loaded at omp start) |
| `~/.omp/agent/models.yml` | provider catalog (installed/merged by `install.sh`) |
| `~/.omp/agent/config.yml` | model roles (copied only when absent) |
| `"$TMPDIR"/splash-m1-serve-<port>.log` | server output of the spawned process |
| `~/Library/Application Support/Splash/` | Splash data: model cache, runtime, catalog |

Stop the server: `pkill -f 'server\.server .*--port 8000'` (or Ctrl+C if you started it in a
terminal). Disable the extension for one session: `SPLASH_M1_DISABLE=1 omp`.

## Troubleshooting

- **`splash: server not ready` in the status line** — the model is still loading (first load
  can take many minutes while weights download/warm up). The background poller clears it when
  the server is ready; if the prompt went out before readiness, send it again.
- **Prompt proceeded before the model was ready** — the gate timed out; check the log in
  `"$TMPDIR"/splash-m1-serve-<port>.log`. A download or a memory-pressure stall is the usual
  cause; `--max-memory 28G` on the serve line leaves headroom.
- **`404 model_not_found`** — a request named a model the server isn't serving. Serve that
  model (`SPLASH_M1_MODEL=… omp`) or fix the role.
- **Port already in use / server won't start** — something else owns the port; a stale
  splash server is the common case (`pkill -f 'server\.server'`), otherwise change
  `SPLASH_M1_URL` to another port.
- **Different splash build installed** (`splash-m1` vs `splash`) — the extension tries
  `splash-m1` then `splash` on PATH; point `SPLASH_M1_BIN` at the one you have.

## Upstream

Splash is Apache-2.0 open source: [incoai/splash](https://github.com/incoai/splash)
(`brew install incoai/tap/splash`), with a built-in chat page at `http://127.0.0.1:8000`.
This repo only packages the omp-side glue and config — it ships no Splash code or weights,
which keep their own licenses.
