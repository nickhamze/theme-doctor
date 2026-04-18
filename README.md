# 🩺 Theme Doctor

> AI-powered WooCommerce theme QA — crawl, judge, and auto-fix any registered theme set.

Theme Doctor examines a WooCommerce theme like a physician: takes vitals (rubric checks), runs diagnostics (layout signature → pixel diff → LLM judgement), prescribes treatment (triage agent), administers it (patch agent), and confirms recovery (verify agent) — all bounded by a strict safety regime.

## Features

- **Layout-agnostic** — works for one theme, a hundred, sibling repos, monorepo subfolders, git URLs, or marketplace zips.
- **Bring your own keys** — `ANTHROPIC_API_KEY` for AI, `GH_TOKEN` / `gh auth` for PRs. Both optional.
- **4-tier judgement ladder** — rubric → layout signature → pixel diff → Claude Haiku. Cheap tiers run first.
- **Triage → patch → verify** fix loop scoped strictly to each theme's own directory.
- **Shadow mode** — run in draft-only mode for weeks to calibrate thresholds before enabling auto-merge.
- **Circuit breaker** — 3 consecutive fails disable the bot for a theme until human reset.
- **Full audit log** — every Claude prompt, response, and tool call saved to `audit/<theme>/<run>.jsonl`.

## Quick start

```bash
# Zero-install (any directory)
npx theme-doctor init
npx theme-doctor add ../my-woo-theme
npx theme-doctor doctor     # verify deps
npx theme-doctor run
```

Or install globally:

```bash
npm install -g theme-doctor
theme-doctor init
theme-doctor add ../my-woo-theme
theme-doctor run
```

## Prerequisites

| Requirement | Notes |
|---|---|
| Node ≥ 20 | Required |
| `npx playwright install chromium` | Required for crawling |
| `ANTHROPIC_API_KEY` | Optional — enables AI judge + fixer |
| `gh auth login` or `GH_TOKEN` | Optional — enables PR creation |
| `wp-playground` CLI | Optional — faster sandbox (falls back to wp-env) |
| Docker + `@wordpress/env` | Optional — full-fidelity fallback sandbox |
| `odiff` | Optional — enables pixel diff tier |

## CLI reference

```
theme-doctor init                          # scaffold workspace in cwd
theme-doctor add <path-or-url> [--id X]   # register a theme
theme-doctor list                          # list registered themes + status
theme-doctor classify <id>                 # classify a theme (classic/hybrid/FSE)
theme-doctor run [--theme X]               # full pipeline: crawl → judge → fix → PR
theme-doctor crawl <id>                    # crawl only, emit evidence packet
theme-doctor judge <run-id>                # re-judge a previous crawl
theme-doctor fix <id> [--dry-run]          # triage + patch + verify
theme-doctor repro --theme X --url /cart --description "..."  # reproduce a bug
theme-doctor reset <id>                    # clear circuit breaker
theme-doctor goldens approve <id>          # approve new goldens
theme-doctor dashboard build               # build static HTML dashboard
theme-doctor doctor                        # self-check: deps, tokens, sandbox
```

All commands accept `--config <path>` to override the default `./theme-doctor.yaml`.

## Configuration (`theme-doctor.yaml`)

```yaml
version: 1

defaults:
  viewports: [375, 768, 1440]
  matrix:
    wp: ["latest"]
    wc: ["latest"]
    php: ["8.2"]
  sandbox: auto          # playground | wp-env | auto
  pr:
    create: true
    auto_merge_cosmetic: false   # keep off until shadow mode complete
  budget:
    max_cost_usd_per_run: 5

themes:
  # Local path
  - id: my-theme
    source: { type: path, path: ../my-theme }
    repo: myorg/my-theme      # for PR creation

  # Git URL
  - id: external-theme
    source: { type: git, url: https://github.com/org/theme.git, ref: main }

  # Zip
  - id: marketplace-theme
    source: { type: zip, url: https://example.com/theme.zip }

  # Auto-discover all Woo themes in a directory
  - source: { type: glob, pattern: ../themes/*, detect_woo: true }
```

## Safety

Before enabling auto-merge:

1. Run in shadow mode (`--shadow`) for ≥ 2 weeks.
2. Spot-check PRs weekly to calibrate judge thresholds.
3. Enable `pr.auto_merge_cosmetic: true` only after thresholds look good.
4. Circuit breaker trips after 3 consecutive bot failures — `theme-doctor reset <id>` to re-enable.

## CI / GitHub Actions

Copy workflow templates from `defaults/workflows/` into your project's `.github/workflows/`:

- `theme-doctor.yml` — main matrix (theme × shard × WP/WC/PHP)
- `theme-doctor-compat-nightly.yml` — plugin-compat shards
- `theme-doctor-dashboard.yml` — publish dashboard to GitHub Pages

## License

MIT
