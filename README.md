# TasteBridge

**Common ground for two tastes.** TasteBridge is an agentic tool that finds movies, shows, books, music, podcasts, games, places or travel destinations that *two* people will both enjoy. It runs on the [Qloo Taste AI API](https://docs.qloo.com/) and is available three ways: a web demo, a CLI and an **MCP server** that any AI agent can call.

Built for the Qloo Agentic Hackathon. Every title, score and tag it shows comes from a Qloo API response: TasteBridge uses no LLM and never invents results.

## Try it

- **Demo video (2 min):** https://youtu.be/ngbumwRlxSo (a screen recording of the public demo and of live MCP calls, with English captions)
- **Live web demo:** https://tastebridge-qloo.onrender.com/ (free hosting: the first request after a quiet period can take up to a minute while the server wakes up)
- **Live MCP endpoint (Streamable HTTP):** `https://tastebridge-qloo.onrender.com/mcp` with 5 read-only tools; see [MCP tools](#mcp-tools)
- **Health check:** https://tastebridge-qloo.onrender.com/health
- The public server is rate-limited to 30 requests per minute per IP and keeps the Qloo API key server-side.

## The problem

Most recommenders serve one person. Real choices are shared: a couple picking a film, friends choosing a book-club title, travel buddies looking for a bar in a new city. Splitting the difference by hand usually ends with whatever one person already likes.

TasteBridge is for anyone who has to agree on something with someone else, and for AI assistants that need a reliable, explainable "what would we both like?" tool instead of guessing.

## What it does

1. Takes two people and up to 5 favorites each (any domain: "Amelie", "artist: Daft Punk", "book: Dune").
2. Resolves every favorite to a Qloo entity.
3. Compares the two taste profiles: shared taste tags and what is distinctive to each person.
4. Asks Qloo for candidates in the target category, scored against *both* people's favorites, with per-favorite explainability.
5. Re-ranks for fairness, so a pick that only one person would love does not win just on raw affinity.
6. Explains every pick with Qloo data: affinity, the share of the signal coming from each person (and their strongest favorite), and the shared tags the pick carries.

## How Qloo is used

All calls are `GET` requests to `https://hackathon.api.qloo.com` with the `X-Api-Key` header.

| Step | Endpoint | Key parameters | Purpose |
|---|---|---|---|
| Resolve | `GET /search` | `query`, `types` (optional, from a `movie:`/`book:`/... prefix), `take=5` | Name to entity ID. Result types that `/v2/insights` cannot use (albums, localities) are skipped. |
| Compare | `GET /v2/insights/compare` | `a.signal.interests.entities`, `b.signal.interests.entities`, `take` | Shared tags (`results.tags`) and each side's tags (`results.a`, `results.b`). |
| Recommend | `GET /v2/insights` | `filter.type`, `signal.interests.entities`, `filter.exclude.entities`, `feature.explainability=true`, `take`, `filter.location.query` (places, destinations) | Candidates with `query.affinity` and `query.explainability` (contribution of each input entity). |
| Explain | `GET /v2/insights` + `GET /entities` | `filter.results.entities=<candidate>`, `feature.explainability=true`; `entity_ids` | Scores one candidate against the seeds and finds the tags it shares with each seed. |

Supported `filter.type` values: `urn:entity:movie`, `tv_show`, `book`, `artist`, `podcast`, `videogame`, `place`, `destination`, `brand`. (The hackathon API accepts `urn:entity:videogame`; `urn:entity:video_game` returns HTTP 400. Verified live on 2026-10-21.)

Responses are cached privately in server memory for 10 minutes. No Qloo response data is stored in this repository: the offline tests use clearly fictional fixtures.

## The agent loop

The agent is deterministic and fully inspectable. Each run returns its plan and a trace of every Qloo call (endpoint, HTTP status, latency).

```
plan      validate input, choose filter.type, decide whether a location is required
resolve   GET /search for each favorite
compare   GET /v2/insights/compare (person A vs person B)
recommend GET /v2/insights with all favorites as signals and explainability on
rank      group score = affinity x (0.6 + 0.4 x balance)
explain   reasons built only from Qloo fields
```

**Balance** comes from Qloo's explainability: the contribution scores of each person's favorites are summed into a per-person share, and `balance = 1 - (max share - min share)`. A 50/50 pick has balance 1. A pick driven 90/10 by one person has balance 0.2, which lowers its group score even if its raw affinity is higher. Ties are broken by affinity, then name, then ID, so the same Qloo response always gives the same ranking.

If a step fails, the agent stops at that step with a clear message (for example, no usable match for one person's favorites). A failed taste comparison is not fatal: recommendations still use both people's favorites.

## Architecture

```
            +--------------------------- server.mjs (127.0.0.1:4793) ---------------------------+
 browser -> |  /             web demo (public/index.html, app.js, style.css)                     |
            |  /api/common-ground   -> agent.findCommonGround()                                  |
 AI agent ->|  /mcp          MCP Streamable HTTP (spec 2025-11-25), 5 tools -> src/tools.mjs     |
            |  /health                                                                         |
            +------------------------------------------+---------------------------------------+
                                                       |
                 cli.mjs -> agent.findCommonGround()   |
                                                       v
                                  src/qloo.mjs  QlooClient (GET, X-Api-Key, timeout, cache, error codes)
                                                       |
                                                       v
                                         https://hackathon.api.qloo.com
```

| File | Role |
|---|---|
| `server.mjs` | HTTP server: MCP endpoint, web demo, JSON API, security headers, Host/Origin validation, per-IP rate limit |
| `src/qloo.mjs` | Qloo client and response normalization |
| `src/agent.mjs` | Plan, resolve, compare, recommend, rank, explain |
| `src/tools.mjs` | The five MCP tools with Zod input schemas |
| `cli.mjs` | Command-line agent |
| `scripts/smoke.mjs` | Live smoke test (writes only status, counts and latency to `logs/`) |
| `tests/` | Unit, MCP/HTTP and live tests (`node:test`) |

## MCP tools

| Tool | What it does |
|---|---|
| `qloo_resolve_entities` | Names to Qloo entities (`/search`) |
| `qloo_recommend` | Recommendations for one category from seed entity IDs, with explainability |
| `qloo_compare_tastes` | Shared and distinctive taste tags for two sets of entities |
| `qloo_explain_match` | Why a candidate fits a set of seeds: affinity, per-seed contribution, shared tags |
| `tastebridge_common_ground` | The whole agent loop for two people in one call |

All tools are read-only (`readOnlyHint: true`). The server uses the official MCP TypeScript SDK (`@modelcontextprotocol/server` and `@modelcontextprotocol/node`) in stateless Streamable HTTP mode (protocol revision 2025-11-25) and only accepts localhost Host/Origin headers by default.

Point any MCP client that supports Streamable HTTP at `http://127.0.0.1:4793/mcp`. A raw JSON-RPC call looks like this:

```bash
curl -s http://127.0.0.1:4793/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-11-25' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"tastebridge_common_ground","arguments":{"people":[{"name":"Alex","favorites":["Amelie","artist: Daft Punk"]},{"name":"Sam","favorites":["Blade Runner","Interstellar"]}],"category":"movies","count":3}}}'
```

PowerShell (2025-11-25 requests are answered as a short SSE stream, so the snippet reads the `data:` line):

```powershell
$body = @{jsonrpc='2.0'; id=1; method='tools/list'; params=@{}} | ConvertTo-Json -Depth 8
$resp = Invoke-WebRequest -UseBasicParsing -Uri http://127.0.0.1:4793/mcp -Method Post -ContentType 'application/json' `
  -Headers @{Accept='application/json, text/event-stream'; 'MCP-Protocol-Version'='2025-11-25'} -Body $body
$text = [Text.Encoding]::UTF8.GetString($resp.RawContentStream.ToArray())
$json = if ($text.TrimStart().StartsWith('{')) { $text } else { ($text -split '\r?\n' | Where-Object { $_ -like 'data: *' } | Select-Object -First 1).Substring(6) }
($json | ConvertFrom-Json).result.tools.name
```

## Setup and run

Requirements: Node.js 22 or newer and a Qloo hackathon API key.

**Windows (PowerShell)**

```powershell
cd 03-qloo-taste-agent
npm.cmd install
Set-Content -Path .env -Value 'QLOO_API_KEY=your_key_here'
npm.cmd start            # http://127.0.0.1:4793
npm.cmd test             # unit + MCP/HTTP tests; the live test runs only when a key is set
npm.cmd run smoke        # live smoke test against the Qloo API
```

(`npm.cmd` avoids the PowerShell execution-policy prompt that `npm` can trigger.)

**macOS / Linux**

```bash
cd 03-qloo-taste-agent
npm install
echo 'QLOO_API_KEY=your_key_here' > .env
npm start
npm test
```

**CLI**

```bash
node cli.mjs --a-name Alex --a "Amelie; artist: Daft Punk; book: Dune" \
             --b-name Sam  --b "Blade Runner; Interstellar" --category movies --count 5
node cli.mjs --a "Amelie" --b "Arctic Monkeys" --category places --location Lisbon --json
node cli.mjs --a "Amelie" --b "Blade Runner" --plan-only     # prints the plan, no API call
```

Categories: `movies`, `tv`, `books`, `music`, `podcasts`, `games`, `places` (needs `--location`), `destinations`, `brands`.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `QLOO_API_KEY` | (none) | Qloo hackathon key. Read from the environment or `.env`; never logged or returned. |
| `PORT` | `4793` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address. Anything other than localhost requires `ALLOWED_HOSTS`. |
| `ALLOWED_HOSTS` | (none) | Comma-separated public hostnames accepted in `Host`/`Origin` when deployed behind a public URL. |

The JSON API and MCP endpoint share a per-IP limit of 30 requests per minute to protect the API quota.

## Tests

`npm test` runs `node --test`:

- **Qloo client**: request format (GET, base URL, `X-Api-Key`), missing key fails closed without a request, HTTP error mapping, timeouts, caching, key never serialized, best-match selection, image host filtering.
- **Tools and agent**: every MCP tool with mocked HTTP, fairness ranking, explanations, stage errors, input validation, and a check that every returned title exists in the mocked Qloo response.
- **MCP over HTTP**: `initialize`, `tools/list`, `tools/call` for all five tools, tool errors, the web demo files, the REST endpoint, Origin checks and the rate limiter.
- **Live**: one end-to-end run against the real API, skipped automatically when `QLOO_API_KEY` is not set (set `QLOO_LIVE=0` to skip it on purpose).

## Limitations

- Exactly two people per request; the Qloo compare endpoint is pairwise.
- Results depend on Qloo hackathon data coverage. Some favorites may not resolve, and some places or regions may have little data.
- Places need a city or area; recommendations without one would not be useful.
- Qloo explainability only lists inputs with a meaningful contribution, so a person whose favorites barely influence a candidate gets a 0% share for it. When explainability is missing, balance is treated as neutral.
- Shared-tag explanations depend on the tags Qloo returns; some picks have none.
- The UI is English only and keeps no history or accounts.

## Privacy and data

- The API key lives only in `.env` (git-ignored) or the process environment.
- No Qloo responses are written to disk except the smoke-test summary (status codes, counts and latency only).
- The web page loads images only from `images.qloo.com`, under a strict Content Security Policy.

## License

MIT. See [LICENSE](LICENSE).
