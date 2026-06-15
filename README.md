# Book Club Wheel

A weighted spinning wheel for monthly book club picks. Remembers suggestions, rewards regular attendees, and penalises recently-chosen books.

## How to use

**Workflow each month:**

1. **Meeting tab** — set the month, tick everyone who showed up, click *Save Attendance*
2. **Books tab** — any member can update their suggestion; unchanged books carry over automatically
3. **Spin tab** — click *SPIN!* and click *Record Result* when you're happy with the outcome

---

## Features

| | |
|---|---|
| **Persistent suggestions** | Books carry over every month unless a member updates theirs |
| **Attendance gating** | Only members ticked for today's meeting appear on the wheel |
| **Attendance weighting** | Σ 0.8^months_ago for each past meeting attended — recent months count more than old ones, and frequency adds up, so regular recent attenders score highest |
| **Recency penalty** | If someone's book was chosen recently, their weight is reduced by `1 − e^(−months/4)` — roughly half-strength after 4 months, nearly full after 12 |
| **History** | Every meeting's attendees and chosen book are stored |
| **Export / Import** | Download your data as JSON for backup; re-import on any device |

---

## Hosting for free on GitHub Pages

This is a static site (no server needed — data lives in your browser's localStorage).

1. Push this folder to a GitHub repository
2. Go to **Settings → Pages** in your repo
3. Set *Source* to **main branch / root**
4. GitHub gives you a URL like `https://yourname.github.io/book-club/`

That's it. Anyone with the URL can open it, but only the device running it has the data (localStorage is per-browser). Export a JSON backup after each meeting.

### Multi-device sync (optional)

If you want the data accessible from multiple devices, the simplest free option is to commit your exported JSON back to the repo and import it on the other device. For automatic sync, [Supabase](https://supabase.com) has a generous free tier and would require adding a small backend layer.
