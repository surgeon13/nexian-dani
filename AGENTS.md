# Agent instructions — Nexian Dani

## Cursor Cloud specific instructions

This repo is meant to keep the Nexian automation bot running **for the life of the Cloud Agent VM**.

### On every Cloud Agent / Automation start

1. The Environment `start` hook (`scripts/cursor-cloud-start.sh`) should already have:
   - Materialized `.env` from Cursor Secrets (`NEXIAN_DOTENV` preferred)
   - Started `npm run start:24-7` (tmux: `nexian-dani`, `nexian-keep`, `net-usage`)
2. Verify with:
   ```bash
   bash ./scripts/cursor-cloud-ensure.sh
   curl -sf http://127.0.0.1:3847/api/status | head -c 200
   tail -20 keep-alive.log
   ```
3. If ensure fails, fix secrets / deps, then re-run `bash ./scripts/cursor-cloud-start.sh`.

### When the user asks to run 24/7 (or an Automation named keep / 24-7 / nexian)

- **Do not end the agent session.** Stay alive and monitor.
- Do **not** kill tmux sessions `nexian-dani`, `nexian-keep`, or `net-usage`.
- Do **not** stop `login.js` or `keep-alive.sh` unless replacing them via `start-24-7`.
- Poll every few minutes: `bash ./scripts/cursor-cloud-ensure.sh` and check `keep-alive.log` heartbeats.
- Prefer changing live settings via the dashboard API / running session; restart only for code changes and say so.

### Secrets (Cursor dashboard → Cloud Agents → Secrets)

| Secret | Purpose |
|--------|---------|
| `NEXIAN_DOTENV` | **Preferred.** Full `.env` file body (paste from local `.env`). |
| `NEXIAN_USERNAME` / `NEXIAN_PASSWORD` / `GAME_HOST` / … | Fallback if `NEXIAN_DOTENV` unset (see `.env.example`). |
| `NEXIAN_TROOP_PLANS_JSON` | Optional `templates/troop_plans.json` body. |
| `NEXIAN_PROXY_LIST_JSON` | Optional `templates/proxy_list.json` body. |

Never commit `.env`, `storageState.json`, proxy lists, or troop plans.

### Continuity limit (honest)

Cursor Cloud VMs are **per agent run**. When the run is archived/killed, the VM dies and the bot stops. Inside Cursor, continuity means:

1. Environment auto-starts the bot on each new agent boot (this repo’s `.cursor/environment.json`).
2. Keep at least one Cloud Agent / Automation run **open** while you want the bot online.
3. Add a scheduled Automation (e.g. hourly) whose prompt is: ensure `cursor-cloud-ensure.sh` is healthy and **stay alive monitoring** — so a fresh VM picks up if the previous run died.

Dashboard: https://cursor.com/automations · Environments: https://cursor.com/dashboard/cloud-agents#environments

### Do not

- Put Master Builder or gold builds on unless the user explicitly asks.
- Commit secrets or runtime logs.
- Assume the previous VM’s browser session still exists after a new agent boots (fresh login via `.env` / storageState if present).
