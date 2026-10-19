# ad.network

Run ads, or earn from your site, in crypto. The simple front door to the
[crawlproof](https://crawlproof.com/ads) ad network, the way pay.agent is to CoinPay.

- **Advertisers**: paste a link and a daily budget. We read the page and write the
  ad. Add budget in USDC, BTC, ETH, SOL and more; your ads run until it runs out.
  About $0.20 a click, never per view.
- **Publishers**: name your site, paste one tag before `</body>`, add a USDC wallet.
  You earn about 5¢ of each paid click; withdraw from $5, straight to your wallet.

Sign in with CoinPay. No other account, no forms.

- **Web**: https://ad.network.pit.world
- **CLI / TUI**: `curl -fsSL https://ad.network.pit.world/install.sh | sh`, or `bunx @profullstack/adnetwork`
- **MCP**: `claude mcp add adnetwork -e ADNETWORK_KEY=an_… -- bunx @profullstack/adnetwork mcp`
- **API**: `POST /api/v1/ads {"url": "…", "daily_usd": 5}`, `POST /api/v1/deposits {"amount_usd": 25, "coin": "usdc_sol"}`,
  `POST /api/v1/sites {"site": "example.com"}`; full list at https://ad.network.pit.world/help#agents

```sh
adnetwork run https://example.com --daily 5     # an ad
adnetwork fund 25 usdc_sol                      # address + exact amount
adnetwork site example.com                      # the tag to paste
adnetwork wallet example.com 0x… usdc_pol
adnetwork withdraw example.com
```

## How it works

ad.network runs on two crawlproof accounts. One owns every advertiser's campaigns
and holds their budget; ad.network keeps each advertiser's share (deposits in, minus
what their ads spent) and pauses anyone who reaches zero, checking every five minutes.
The other owns every publisher's slots, each paying its own wallet through CoinPay,
so ad.network never holds a publisher's money. They are two accounts because
crawlproof books an ad served on its own owner's slot as a free self-deal.

Deposits buy ad budget at face value ($1 = $1 of clicks) through crawlproof's
partner deposit API. A site is yours once we see your tag on it: every tag carries a
claim code for one person, and withdrawals wait for it.

## Run it

```sh
bun install
ADNETWORK_KEY=$(openssl rand -hex 32) ADNETWORK_COINPAY_CLIENT_ID=cp_… \
ADNETWORK_ADVERTISER_TOKEN=crp_… ADNETWORK_PUBLISHER_TOKEN=crp_… bun src/server.ts
```

Settings: `ADNETWORK_KEY` (seals CoinPay tokens, signs claim codes),
`ADNETWORK_COINPAY_CLIENT_ID` / `_SECRET` (CoinPay OAuth client, scopes
`openid profile email wallet:read`), `ADNETWORK_ADVERTISER_TOKEN` /
`ADNETWORK_PUBLISHER_TOKEN` (crawlproof API tokens; the advertiser account must be
in crawlproof's `ADS_PARTNER_USER_IDS`), `ADNETWORK_DB`, `PORT` (8800),
`CRAWLPROOF_URL`, `CRAWLPROOF_SITE_ID` (analytics), `ADNETWORK_ORIGIN`.

Deploy: `bin/install.sh` (OpenInstall) on dev2, vault `profullstack/ad-network--prod`;
nginx vhost `ad.network.pit.world` with a cert from `pit-proxy-cert`.

MIT
