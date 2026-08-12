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

### Proxy rotate + check egress IP

```bash
# Next proxy in pool + logout/relogin
curl -sS -X POST http://127.0.0.1:3847/api/proxy-settings \
  -H 'Content-Type: application/json' \
  -d '{"action":"next"}'

# Session loop: play/rest + rotate through full pool on each rest→wake
curl -sS -X POST http://127.0.0.1:3847/api/session-loop \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true,"playMinMinutes":40,"playMaxMinutes":55,"restMinMinutes":10,"restMaxMinutes":20,"proxyRotateOnSessionRest":true}'

# After automation.reason is online:
curl -sS http://127.0.0.1:3847/api/status | python3 -c '
import json,sys
s=json.load(sys.stdin)["status"]
print((s.get("proxy") or {}).get("activeDisplay"))
print((s.get("account") or {}).get("publicAddress"))
print("session:", s.get("sessionLoop"))
'
```

Other proxy actions: `apply`, `disable`, `save`. Do not commit `templates/proxy_list.json`.
Session rest rotates **once** per cycle (wake retries stay on the same `#N`); with a pool of N, all addresses are used in order over N rest cycles.

### Secrets (Cursor dashboard → Cloud Agents → Secrets)

| Secret | Purpose |
|--------|---------|
| `NEXIAN_DOTENV` | **Preferred.** Full `.env` file body (paste from local `.env`). |
| `NEXIAN_USERNAME` / `NEXIAN_PASSWORD` / `GAME_HOST` / … | Fallback if `NEXIAN_DOTENV` unset (see `.env.example`). |
| `NEXIAN_TROOP_PLANS_JSON` | Optional `templates/troop_plans.json` body. |
| `NEXIAN_PROXY_LIST_JSON` | Optional `templates/proxy_list.json` body. |

Never commit `.env`, `storageState.json`, proxy lists, or troop plans.

### Continuity limit (honest)

Cursor Cloud VMs are **per agent run**. When the run is archived/killed, the VM dies and the bot stops.

**Preferred for 24/7:** run on an always-on **PC** (or VPS):

```bash
npm run setup:pc
npm run start:24-7:pc
# Windows: setup-pc.cmd then start-24-7.cmd
# Optional Windows logon task: .\scripts\register-pc-task.ps1
```

Inside Cursor, continuity means Environment auto-start + a kept-open / scheduled Automation — use that only as a backup; the PC process is the source of truth.

### Troop counts / village status

- When the user asks for **troop counts**, **army strength**, or **current village status** troop lines, scrape **Account Overview → Troops**:
  - `https://s1.nexian.world/overview.php?t=4` (or `{GAME_HOST}/overview.php?t=4`)
- That table is **own troops per village (home + away)** plus a **Sum** row — prefer it over village1 `#troops` (at-home only).
- Village Status (menu **0**) already appends overview own-troops for the selected village and account totals.

### Do not

- Put Master Builder or gold builds on unless the user explicitly asks.
- Commit secrets or runtime logs.
- Assume the previous VM’s browser session still exists after a new agent boots (fresh login via `.env` / storageState if present).
