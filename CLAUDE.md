# demo-apps

Two independent applications live here. Do not mix their code or conventions.

| Folder | What | Stack | Start here |
|---|---|---|---|
| `text2sql/` | **AskData** — text-to-SQL platform | Python / FastAPI, buildless ES-module front end | [`text2sql/CLAUDE.md`](text2sql/CLAUDE.md) — **read it fully before any change there** |
| `ovanta_crm/` | **Ovantaa CRM** | Node.js / Express | `ovanta_crm/README.md` |

Ground rules for the whole repository:

- Work on the branch you were given; do not open a pull request unless asked.
- Verify changes for real (tests and, for UI, a browser) before saying they work; say plainly what was
  not verified.
- The owner is a non-developer who updates by downloading the branch as a zip and keeping their data
  folder: never make a change that breaks an existing data folder.
- When a feature in one app is asked to work "like the other app", read the other app's
  implementation first and mirror its behaviour, not its code.
