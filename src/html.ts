/**
 * Server-rendered pages. One small script (public/app.js) copies text and
 * follows a deposit's status; everything works without it except the live update.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Campaign, DepositRow, Site, User, Withdrawal } from './db.js'
import { pitFooter } from './pit-footer.js'
import { RING_PLACEHOLDER } from './ring.js'
import { ringFooter } from './ring-footer.js'
import { CLICK_CENTS, coinName, MAX_DAILY_USD, MIN_DAILY_USD, MIN_DEPOSIT_USD, MIN_PAYOUT_CENTS, PAYOUT_COINS, usd } from './service.js'

export const SITE = 'https://ad.network.pit.world'
export const REPO = 'https://github.com/moshcoder/ad.network'
const CRAWLPROOF = 'https://crawlproof.com'
const COINPAY = 'https://coinpayportal.com'

/** crawlproof analytics: one async script on every page. CRAWLPROOF_SITE_ID overrides; 'off' drops it. */
const TRACKER_SITE = process.env.CRAWLPROOF_SITE_ID ?? ''
const TRACKER = TRACKER_SITE && TRACKER_SITE !== 'off' ? `<script data-site="${TRACKER_SITE}" src="https://crawlproof.com/stats.js" async></script>` : ''

const asset = (name: string) => {
  const body = readFileSync(new URL(`../public/${name}`, import.meta.url))
  return `/${name}?v=${createHash('sha256').update(body).digest('hex').slice(0, 10)}`
}
const STYLE_URL = asset('style.css')
const SCRIPT_URL = asset('app.js')

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]!)
const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')

const LOGO = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="3.4" fill="currentColor"/><path d="M10.3 21.7a8 8 0 0 1 0-11.4M21.7 10.3a8 8 0 0 1 0 11.4M6.1 25.9a14 14 0 0 1 0-19.8M25.9 6.1a14 14 0 0 1 0 19.8" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>`

export type Ctx = { user: User | null; csrf: string; /** Free launch: ads run with no balance. */ free?: boolean }

type LayoutOptions = { title: string; description: string; path: string; body: string; ctx: Ctx; noindex?: boolean; script?: boolean; head?: string }

function layout(o: LayoutOptions): string {
  const signedIn = Boolean(o.ctx.user)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<meta name="referrer" content="strict-origin-when-cross-origin">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#07090c">
${o.noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${esc(SITE + o.path)}">`}
<meta property="og:type" content="website">
<meta property="og:site_name" content="ad.network">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${STYLE_URL}">
${o.head ?? ''}
${o.script ? `<script src="${SCRIPT_URL}" defer></script>` : ''}
${TRACKER}
</head>
<body>
${RING_PLACEHOLDER}
<header class="top">
  <a class="brand" href="/">${LOGO}<span>ad<b>.</b>network</span></a>
  <nav aria-label="Site">
    <a href="/advertise">Advertise</a>
    <a href="/publish">Publish</a>
    <a href="/help">Help</a>
    ${signedIn ? `<form method="post" action="/auth/logout"><input type="hidden" name="csrf" value="${esc(o.ctx.csrf)}"><button class="linkish">Sign out</button></form>` : '<a href="/auth/start">Sign in</a>'}
  </nav>
</header>
<main>
${o.body}
</main>
${ringFooter()}
${pitFooter()}
</body>
</html>`
}

/** Our own ad.network publisher claim (the head meta). The home page carries no ad unit. */
const AD_CLAIM = 'lUfznNYA2hxmzcKK'

const csrfField = (ctx: Ctx) => `<input type="hidden" name="csrf" value="${esc(ctx.csrf)}">`
const flashNote = (flash?: string, error = false) => (flash ? `<p class="note${error ? ' error' : ''}">${esc(flash)}</p>` : '')

export function homePage(ctx: Ctx): string {
  return layout({
    ctx,
    title: 'ad.network: run ads or earn from your site, in crypto',
    description: 'The simple ad network. Advertisers paste a link and a daily budget. Publishers paste one tag and get paid to their wallet. Crypto in, crypto out.',
    path: '/',
    head: `<meta name="ad.network" content="${AD_CLAIM}">`,
    body: `<section class="hero">
  <h1>Ads, the simple way.</h1>
  <p class="tag">Paste a link and a daily budget, and your ad runs across the network. Or paste one tag into your site and get paid to your wallet. Crypto in, crypto out, no forms.</p>
  ${ctx.free ? `<p class="tag"><b>Free while we launch:</b> advertising costs nothing right now. No deposit needed. Paste a link and your ad runs today.</p>` : ''}
</section>
<div class="grid2">
  <a class="card pick" href="/advertise"><h2>Advertise</h2><p class="muted">${ctx.free ? 'Paste the page people should land on. We write the ad from it and it runs across the network, free during the launch.' : 'Paste the page people should land on. We write the ad from it. Add budget in USDC, BTC, ETH or SOL. It runs until the budget does.'}</p><span class="btn">${ctx.free ? 'Run a free ad' : 'Run an ad'}</span></a>
  <a class="card pick" href="/publish"><h2>Publish</h2><p class="muted">Name your site, paste one tag before <code>&lt;/body&gt;</code>, add a wallet. Withdraw what you earn whenever it passes ${usd(MIN_PAYOUT_CENTS)}.${ctx.free ? ' And advertise your own site across the network for free.' : ''}</p><span class="btn">Earn from my site</span></a>
</div>
<div class="grid3">
  <div class="card"><h2><span class="step-n">1</span>Sign in</h2><p class="muted">With your CoinPay account (free; you can make one on the way).</p></div>
  <div class="card"><h2><span class="step-n">2</span>One field</h2><p class="muted">A link to advertise, or a site to earn from. That is the whole setup.</p></div>
  <div class="card"><h2><span class="step-n">3</span>Crypto</h2><p class="muted">Advertisers top up in crypto. Publishers are paid in USDC to their own wallet.</p></div>
</div>
<div class="card" id="agents">
  <h2>Built for agents too</h2>
  <p class="muted">Everything is an API, a CLI and an MCP server. An agent can run its own ads:</p>
  <pre>bunx @profullstack/adnetwork run https://example.com --daily 5
bunx @profullstack/adnetwork fund 25
claude mcp add adnetwork -- bunx @profullstack/adnetwork mcp</pre>
  <p class="muted small"><a href="/help#agents">API and keys</a></p>
</div>`,
  })
}

export function helpPage(ctx: Ctx): string {
  return layout({
    ctx,
    title: 'Help · ad.network',
    description: 'How ad.network works for advertisers and publishers: budgets, prices, payouts, the API, CLI and MCP.',
    path: '/help',
    body: `<section class="hero"><h1>Help</h1><p class="tag">Everything about ad.network on one page.</p></section>
<div class="card"><h2>What is it?</h2><p>ad.network is the simple front door to the <a href="${CRAWLPROOF}/ads">crawlproof</a> ad network. crawlproof writes the ads, runs the auction, serves them across its sites and counts honestly (bots and repeat clicks are not charged). <a href="${COINPAY}">CoinPay</a> moves the money. You sign in with CoinPay; there is no other account.</p></div>
<div class="card" id="advertisers"><h2>Advertisers</h2><ol>
  <li><a href="/advertise">Paste a link</a> and pick a daily budget ($${MIN_DAILY_USD} to $${MAX_DAILY_USD}). We read the page and write the ad: headline, text and a banner.</li>
  <li>${ctx.free ? `<b>Free while we launch:</b> your ads run with no budget at all. When paid ads open you can add budget (from $${MIN_DEPOSIT_USD}) in any coin or PayPal; until then nothing is charged.` : `Add budget: pick an amount (from $${MIN_DEPOSIT_USD}) and pay on CoinPay in any coin or PayPal. Your ads start as soon as it arrives.`}</li>
  <li>You pay for clicks, about ${usd(CLICK_CENTS)} each, never for views. The bid adjusts itself to spend your daily budget evenly.</li>
  <li>When your balance runs out your ads pause. Add more and they start again. Pause, change the budget or delete an ad any time.</li>
</ol><p class="muted small">Your balance is what you added minus what your ads spent. We check every few minutes, so an ad can run a few cents past zero; that is on us.</p></div>
<div class="card" id="publishers"><h2>Publishers</h2><ol>
  <li><a href="/publish">Name your site</a>. You get one tag to paste before <code>&lt;/body&gt;</code>. It shows a 300×250 ad and counts visits.</li>
  <li>Publish the page. We look for your tag (it carries a code that is yours alone), or press <b>Check my site</b>.</li>
  <li>Add a wallet for USDC (Polygon, Solana, Base or Ethereum).</li>
  <li>You earn about 5¢ of every ${usd(CLICK_CENTS)} paid click on your site. Withdraw any time you have ${usd(MIN_PAYOUT_CENTS)} or more; it goes straight from crawlproof to your wallet.</li>
</ol><p class="muted small">Someone else claimed your site? If they never placed their tag, add <code>&lt;meta name="ad.network" content="your code"&gt;</code> (the code is shown when you try) and claim it again.</p></div>
<div class="card" id="credit"><h2>Credit codes and invites</h2><p>A credit code adds ad credit to your balance (<a href="/me#redeem">redeem it</a>). Each account has three invites; when someone new joins with yours, you both get ad credit. Ad credit runs your ads like budget you paid for, but it is not money: it cannot be withdrawn or refunded, and clicks bought with it pay publishers nothing.</p></div>
<div class="card"><h2>Fees</h2><p>ad.network adds none. crawlproof keeps 30% of the publisher side of each click; the network fee for sending crypto is the sender's, as always.</p></div>
<div class="card" id="agents"><h2>Agents: API, CLI, MCP</h2>
<p>Make a key on <a href="/me">your page</a>, then:</p>
<pre>GET    /api/v1/me                         balance, ads, sites
POST   /api/v1/ads                        {"url": "https://…", "daily_usd": 5}
GET    /api/v1/ads/:ref                   one ad, fresh numbers
PATCH  /api/v1/ads/:ref                   {"running": false} or {"daily_usd": 10}
DELETE /api/v1/ads/:ref
POST   /api/v1/deposits                   {"amount_usd": 25} -> checkout_url: pay there in any coin or PayPal
GET    /api/v1/deposits/:id               pending, complete or failed
POST   /api/v1/sites                      {"site": "example.com"} -> the tag to paste
GET    /api/v1/sites/:site
POST   /api/v1/sites/:site/check          look for the tag now
PATCH  /api/v1/sites/:site                {"wallet": "0x…", "coin": "usdc_pol"}
POST   /api/v1/sites/:site/withdraw
DELETE /api/v1/sites/:site
POST   /api/v1/credits/redeem             {"code": "AD-…"} -> ad credit (spend-only)
GET    /api/v1/invites                    your invites, 3 each
POST   /api/v1/invites                    {"note": "for Sam"} -> an invite link
POST   /api/v1/invites/accept             {"code": "INV-…"} (new accounts)

-H 'authorization: Bearer an_…'</pre>
<pre>curl -fsSL ${SITE}/install.sh | sh          installs the adnetwork CLI (needs bun)
adnetwork                                  the TUI
adnetwork run https://example.com --daily 5
adnetwork fund 25
adnetwork site example.com
claude mcp add adnetwork -- bunx @profullstack/adnetwork mcp</pre></div>
<div class="card"><h2>Your data</h2><p>We keep your CoinPay name and email, your sign-in (encrypted), which ads and sites are yours, and your deposits. Delete it all on <a href="/me">your page</a>.</p></div>
<div class="card"><h2>Reaching ad.network</h2><p>It lives at <a href="${SITE}/">ad.network.pit.world</a>, part of the <a href="https://pit.world">Moshpit</a> network.</p></div>`,
  })
}

// ---- advertisers ---------------------------------------------------------------

function adRow(c: Campaign): string {
  const shown = c.status === 'active' ? 'running' : c.status === 'draft' ? 'waiting for budget' : c.wanted === 'active' ? 'paused: no budget' : 'paused'
  return `<tr><td><a href="/ads/${esc(c.ref)}">${esc(c.name || c.url)}</a><br><span class="muted small">${esc(c.url)}</span></td><td>${usd(c.dailyBudgetCents)}/day</td><td>${c.impressions.toLocaleString('en-US')}</td><td>${c.clicks.toLocaleString('en-US')}</td><td>${usd(c.spentCents)}</td><td><span class="status ${esc(c.status)}">${esc(shown)}</span></td></tr>`
}

function fundForm(ctx: Ctx, values: { amount?: string } = {}): string {
  return `<form method="post" action="/advertise/fund" class="row">${csrfField(ctx)}
  <input name="amount" inputmode="decimal" placeholder="Amount (USD)" value="${esc(values.amount ?? '25')}" aria-label="Amount in USD">
  <button class="btn">Add budget</button></form>`
}

export function advertisePage(ctx: Ctx, o: { balanceCents: number; campaigns: Campaign[]; deposits: DepositRow[]; flash?: string; error?: string; values?: Record<string, string> }): string {
  const v = o.values ?? {}
  return layout({
    ctx,
    noindex: true,
    title: 'Advertise · ad.network',
    description: 'Run an ad: paste a link, pick a daily budget, add budget in crypto.',
    path: '/advertise',
    body: `<section class="hero" style="padding-bottom:1rem"><h1>Advertise</h1><p class="tag">${ctx.free ? '<b>Free while we launch.</b> Your ads run with no balance. ' : ''}Balance <b>${usd(Math.max(0, o.balanceCents))}</b>${!ctx.free && o.balanceCents <= 0 ? ' · add budget to start your ads' : ''}</p></section>
${flashNote(o.flash)}${flashNote(o.error, true)}
<form method="post" action="/advertise" class="card">${csrfField(ctx)}
  <h2>New ad</h2>
  <label for="url">Link people land on</label>
  <input id="url" name="url" required placeholder="https://example.com/your-page" value="${esc(v.url ?? '')}" autocomplete="url" spellcheck="false">
  <label for="daily">Daily budget (USD)</label>
  <input id="daily" name="daily" required inputmode="decimal" value="${esc(v.daily ?? '5')}">
  <p class="muted small">About ${usd(CLICK_CENTS)} a click; $5 a day is roughly 25 clicks. We write the ad from your page; it takes up to a minute.</p>
  <p><button class="btn wide big">Run my ad</button></p>
</form>
<div class="card"><h2>Add budget</h2><p class="muted small">From $${MIN_DEPOSIT_USD}. You pay on CoinPay in any coin (USDC, USDT, BTC, ETH, SOL and more) or PayPal. Your ads start the moment it lands.</p>${fundForm(ctx, { amount: v.amount })}</div>
<div class="card"><h2>Your ads</h2>${o.campaigns.length ? `<table><thead><tr><th>Ad</th><th>Budget</th><th>Views</th><th>Clicks</th><th>Spent</th><th></th></tr></thead><tbody>${o.campaigns.map(adRow).join('')}</tbody></table>` : '<p class="muted">None yet.</p>'}</div>
${o.deposits.length ? `<div class="card"><h2>Deposits</h2><table><thead><tr><th>When</th><th>Amount</th><th>Coin</th><th>Status</th></tr></thead><tbody>${o.deposits.map((d) => `<tr><td>${when(d.createdAt)}</td><td>${usd(d.amountCents)}</td><td>${esc(coinName(d.coin))}</td><td><a class="status ${esc(d.status)}" href="/deposits/${esc(d.id)}">${esc(d.status)}</a></td></tr>`).join('')}</tbody></table></div>` : ''}`,
  })
}

export function adPage(ctx: Ctx, o: { c: Campaign; flash?: string; error?: string }): string {
  const c = o.c
  const ctr = c.impressions ? ((c.clicks / c.impressions) * 100).toFixed(1) : '0.0'
  return layout({
    ctx,
    noindex: true,
    title: `${c.name || c.ref} · ad.network`,
    description: 'One of your ads.',
    path: `/ads/${c.ref}`,
    body: `<section class="hero" style="padding-bottom:1rem"><h1>${esc(c.name || c.ref)}</h1><p class="tag"><a href="${esc(c.url)}" rel="noopener">${esc(c.url)}</a></p></section>
${flashNote(o.flash)}${flashNote(o.error, true)}
${c.headline ? `<div class="card ad-preview"><p class="muted small">Your ad</p><p class="ad-headline">${esc(c.headline)}</p><p>${esc(c.body)}</p></div>` : ''}
<div class="grid3">
  <div class="card center"><p class="muted small">Views</p><p class="big-number">${c.impressions.toLocaleString('en-US')}</p></div>
  <div class="card center"><p class="muted small">Clicks</p><p class="big-number">${c.clicks.toLocaleString('en-US')}</p><p class="muted small">${ctr}%</p></div>
  <div class="card center"><p class="muted small">Spent</p><p class="big-number">${usd(c.spentCents)}</p></div>
</div>
<div class="card"><h2>Settings</h2>
<form method="post" action="/ads/${esc(c.ref)}/budget" class="row">${csrfField(ctx)}<input name="daily" inputmode="decimal" value="${(c.dailyBudgetCents / 100).toFixed(2)}" aria-label="Daily budget"><button class="btn">Set daily budget</button></form>
<form method="post" action="/ads/${esc(c.ref)}/${c.wanted === 'active' ? 'pause' : 'resume'}">${csrfField(ctx)}<button class="copy">${c.wanted === 'active' ? 'Pause this ad' : 'Run this ad'}</button></form>
<details><summary>Delete</summary><form method="post" action="/ads/${esc(c.ref)}/delete">${csrfField(ctx)}<button class="copy bad">Delete this ad</button></form><p class="muted small">What it spent stays on your balance.</p></details>
<p class="muted small">Numbers from ${esc(when(c.syncedAt || c.createdAt))} UTC · ref ${esc(c.ref)}</p></div>
<p class="center"><a href="/advertise">All my ads</a></p>`,
  })
}

export function depositPage(ctx: Ctx, o: { d: DepositRow; qr: string }): string {
  const d = o.d
  const paid = d.status === 'complete'
  return layout({
    ctx,
    noindex: true,
    script: true,
    title: `Add ${usd(d.amountCents)} · ad.network`,
    description: d.checkoutUrl ? 'Pay on CoinPay in any coin or PayPal.' : 'Send the exact amount to the address shown.',
    path: `/deposits/${d.id}`,
    body: `<section class="payee" style="padding-top:2rem"><p class="muted" style="margin:0">Ad budget</p>
<p class="amount">${usd(d.amountCents)}</p>
<p><span class="status ${esc(d.status)}" id="status" data-deposit="${esc(d.id)}">${paid ? 'paid' : esc(d.status)}</span></p></section>
<div class="card center" id="checkout-box" ${paid || !d.checkoutUrl || d.status !== 'pending' ? 'hidden' : ''}>
  <p>Pay on CoinPay in any coin (USDC, USDT, BTC, ETH, SOL and more) or PayPal.</p>
  <p><a class="btn big" href="${esc(d.checkoutUrl)}" rel="noopener">Pay ${usd(d.amountCents)}</a></p>
  <p class="muted small">${d.expiresAt ? `Open until ${esc(new Date(d.expiresAt).toUTCString().replace(' GMT', ' UTC'))}. ` : ''}Paid already? This page updates by itself once it lands.</p>
</div>
<div class="card" id="pay-box" ${paid || !d.address ? 'hidden' : ''}>
  <p class="center">Send exactly</p>
  <p class="amount" style="font-size:1.6rem">${esc(d.amountCrypto)} <span class="muted">${esc(coinName(d.coin))}</span></p>
  <div class="address"><code>${esc(d.amountCrypto)}</code><button class="copy" type="button" data-copy="${esc(d.amountCrypto)}">Copy amount</button></div>
  ${o.qr}
  <p class="center muted small">to this address</p>
  <div class="address"><code>${esc(d.address)}</code><button class="copy" type="button" data-copy="${esc(d.address)}">Copy</button></div>
  <p class="muted small center">${d.expiresAt ? `Good until ${esc(new Date(d.expiresAt).toUTCString().replace(' GMT', ' UTC'))}. ` : ''}One payment, on the right network. This page updates by itself.</p>
</div>
<div class="card center" id="paid-box" ${paid ? '' : 'hidden'}><h2 class="ok">Budget added.</h2><p class="muted">Your ads are running.</p><a class="btn" href="/advertise">Back to my ads</a></div>
${!paid && d.status !== 'pending' ? `<p class="note">This deposit ${esc(d.status)}. <a href="/advertise">Start another</a>.</p>` : ''}
<p class="center muted small"><a href="/advertise">Back</a> · Deposit ${esc(d.id)}</p>`,
  })
}

// ---- publishers -----------------------------------------------------------------

export function publishPage(ctx: Ctx, o: { sites: Site[]; withdrawals: Withdrawal[]; flash?: string; error?: string; values?: Record<string, string> }): string {
  const v = o.values ?? {}
  const earned = o.sites.reduce((n, s) => n + s.earnedCents, 0)
  return layout({
    ctx,
    noindex: true,
    title: 'Publish · ad.network',
    description: 'Earn from your site: paste one tag, add a wallet, withdraw.',
    path: '/publish',
    body: `<section class="hero" style="padding-bottom:1rem"><h1>Publish</h1><p class="tag">${o.sites.length ? `Your sites have earned <b>${usd(earned)}</b>.` : 'Put ads on your site and get paid in USDC.'}</p></section>
${flashNote(o.flash)}${flashNote(o.error, true)}
<form method="post" action="/publish" class="card">${csrfField(ctx)}
  <h2>Add a site</h2>
  <label for="site">Your site</label>
  <div class="row"><input id="site" name="site" required placeholder="example.com" value="${esc(v.site ?? '')}" spellcheck="false" autocapitalize="none"><button class="btn">Get my tag</button></div>
</form>
<div class="card"><h2>Your sites</h2>${o.sites.length ? `<table><thead><tr><th>Site</th><th>Tag</th><th>Earned</th><th>Can withdraw</th></tr></thead><tbody>${o.sites
      .map((s) => `<tr><td><a href="/sites/${esc(s.host)}">${esc(s.host)}</a></td><td>${s.verifiedAt ? '<span class="status complete">live</span>' : '<span class="status pending">not seen yet</span>'}</td><td>${usd(s.earnedCents)}</td><td>${usd(s.availableCents)}</td></tr>`)
      .join('')}</tbody></table>` : '<p class="muted">None yet.</p>'}</div>
${o.withdrawals.length ? `<div class="card"><h2>Withdrawals</h2><table><thead><tr><th>When</th><th>Amount</th><th>Status</th></tr></thead><tbody>${o.withdrawals.map((w) => `<tr><td>${when(w.createdAt)}</td><td>${usd(w.amountCents)}</td><td>${esc(w.status)}</td></tr>`).join('')}</tbody></table></div>` : ''}`,
  })
}

export function sitePage(ctx: Ctx, o: { s: Site; embed: string; suggestions: { coin: string; address: string }[]; flash?: string; error?: string }): string {
  const s = o.s
  const canWithdraw = Boolean(s.verifiedAt && s.payoutAddress && s.availableCents >= MIN_PAYOUT_CENTS)
  return layout({
    ctx,
    noindex: true,
    script: true,
    title: `${s.host} · ad.network`,
    description: 'Your site on ad.network.',
    path: `/sites/${s.host}`,
    body: `<section class="hero" style="padding-bottom:1rem"><h1>${esc(s.host)}</h1><p class="tag">${s.verifiedAt ? 'Your tag is live.' : 'Paste your tag, publish, and you are in.'}</p></section>
${flashNote(o.flash)}${flashNote(o.error, true)}
<div class="card"><h2><span class="step-n">1</span>Your tag</h2><p class="muted small">Paste it where the ad should show, or before <code>&lt;/body&gt;</code>. It is yours: it carries a code only you have.</p>
<pre class="tag-code">${esc(o.embed)}</pre><p><button class="copy" type="button" data-copy="${esc(o.embed)}">Copy the tag</button></p>
${s.verifiedAt ? `<p class="ok small">Seen on https://${esc(s.host)}/ ${esc(when(s.verifiedAt))} UTC.</p>` : `<form method="post" action="/sites/${esc(s.host)}/check">${csrfField(ctx)}<button class="btn">Check my site</button></form>`}</div>
<div class="card"><h2><span class="step-n">2</span>Your wallet</h2><p class="muted small">Where crawlproof sends what you earn, in USDC.</p>
<form method="post" action="/sites/${esc(s.host)}/wallet">${csrfField(ctx)}
  <div class="row"><select name="coin" aria-label="Coin">${PAYOUT_COINS.map((c) => `<option value="${c}" ${s.payoutCoin === c ? 'selected' : ''}>${esc(coinName(c))}</option>`).join('')}</select>
  <input name="address" placeholder="Wallet address" value="${esc(s.payoutAddress || o.suggestions[0]?.address || '')}" spellcheck="false" autocomplete="off"></div>
  ${!s.payoutAddress && o.suggestions.length ? `<p class="muted small">Filled in from your CoinPay wallet (${esc(coinName(o.suggestions[0]!.coin))}).</p>` : ''}
  <p><button class="btn">${s.payoutAddress ? 'Change wallet' : 'Save wallet'}</button></p></form></div>
<div class="card"><h2><span class="step-n">3</span>Get paid</h2>
<p>Earned <b>${usd(s.earnedCents)}</b> · can withdraw <b>${usd(s.availableCents)}</b></p>
<form method="post" action="/sites/${esc(s.host)}/withdraw">${csrfField(ctx)}<button class="btn" ${canWithdraw ? '' : 'disabled'}>Withdraw ${usd(s.availableCents)}</button></form>
<p class="muted small">${!s.verifiedAt ? 'Withdrawals start once your tag is seen. ' : ''}${!s.payoutAddress ? 'Add a wallet first. ' : ''}Minimum ${usd(MIN_PAYOUT_CENTS)}. Numbers from ${esc(when(s.syncedAt || s.createdAt))} UTC.</p></div>
<details class="card"><summary>Remove this site</summary><form method="post" action="/sites/${esc(s.host)}/delete">${csrfField(ctx)}<button class="copy bad">Stop ads on ${esc(s.host)}</button></form><p class="muted small">Withdraw first: earnings stay with the site.</p></details>
<p class="center"><a href="/publish">All my sites</a></p>`,
  })
}

/** "Have a code?": redeem a credit code for ad credit. */
function redeemCard(ctx: Ctx, code = ''): string {
  return `<form method="post" action="/me/redeem" class="card" id="redeem">${csrfField(ctx)}<h2>Have a code?</h2>
<p class="muted small">A credit code adds ad credit to your balance. Ad credit runs your ads like budget you paid for; it cannot be withdrawn.</p>
<div class="row"><input name="code" required placeholder="AD-XXXX-XXXX-XXXX-XXXX" value="${esc(code)}" autocomplete="off" spellcheck="false" aria-label="Credit code"><button class="btn">Redeem</button></div></form>`
}

export function mePage(ctx: Ctx, o: { user: User; balanceCents: number; apiKey?: string; flash?: string; error?: string }): string {
  const u = o.user
  return layout({
    ctx,
    noindex: true,
    script: true,
    title: 'Me · ad.network',
    description: 'Your ad.network account.',
    path: '/me',
    body: `<section class="hero" style="padding-bottom:1rem"><h1>Hi${u.name ? `, ${esc(u.name.split(' ')[0])}` : ''}.</h1><p class="tag">Signed in with CoinPay as ${esc(u.email || u.name)}.</p></section>
${flashNote(o.flash)}${flashNote(o.error, true)}
<div class="grid2"><a class="card pick" href="/advertise"><h2>Advertise</h2><p class="muted">Balance ${usd(Math.max(0, o.balanceCents))}</p></a><a class="card pick" href="/publish"><h2>Publish</h2><p class="muted">Your sites and earnings</p></a></div>
${redeemCard(ctx)}
<div class="card"><h2>Invites</h2><p class="muted small">Hand out up to three invites. When someone new joins with one, you both get ad credit. <a href="/invites">Your invites</a></p></div>
<div class="card"><h2>API key</h2>${o.apiKey ? `<p>Your key, shown once:</p><div class="address"><code>${esc(o.apiKey)}</code><button class="copy" type="button" data-copy="${esc(o.apiKey)}">Copy</button></div><p class="muted small">export ADNETWORK_KEY=${esc(o.apiKey)}</p>` : `<p class="muted small">For the API, the CLI and MCP. ${u.apiKeyHash ? 'You have one; making a new one replaces it.' : ''}</p>`}
<form method="post" action="/me/key">${csrfField(ctx)}<button class="copy">${u.apiKeyHash ? 'Replace my key' : 'Make a key'}</button></form></div>
<details class="card"><summary>Delete my account</summary><form method="post" action="/me/delete">${csrfField(ctx)}<button class="copy bad">Stop my ads and sites and delete everything ad.network keeps</button></form><p class="muted small">Withdraw your earnings first. Unspent ad budget is not refunded automatically: ask on <a href="${REPO}/issues">GitHub</a>.</p></details>`,
  })
}

/** What a signed-out visitor sees on /advertise or /publish: the offer, then one button to sign in. */
export function pitchPage(ctx: Ctx, kind: 'advertise' | 'publish'): string {
  const start = `/auth/start?next=/${kind}`
  const advertise = kind === 'advertise'
  const points = advertise
    ? [
        ['Paste one link', 'We read your page and write the ad: headline, text and a banner. No design work.'],
        [ctx.free ? 'Free while we launch' : 'Pay per click', ctx.free ? 'No deposit needed. Your ad runs across the network today and nothing is charged.' : `About ${usd(CLICK_CENTS)} a click, never for views. Add budget in USDC, BTC, ETH, SOL and more, or PayPal.`],
        ['Honest counts', 'Bots and repeat clicks are filtered out by crawlproof before anything is counted.'],
      ]
    : [
        ['One tag', 'Paste one tag before </body>. It shows a small ad and counts visits.'],
        ['Paid to your wallet', `You earn a share of every paid click, in USDC, sent to your own wallet. Withdraw from ${usd(MIN_PAYOUT_CENTS)}.`],
        ['Advertise back, free', ctx.free ? 'Every publisher can run an ad for their own site across the network, free during the launch.' : 'Run ads for your own site from the same account.'],
      ]
  return layout({
    ctx,
    title: advertise ? 'Advertise on ad.network' : 'Earn from your site with ad.network',
    description: advertise ? 'Run an ad from one link. Free while we launch, crypto when you scale.' : 'Paste one tag, add a wallet, get paid in USDC. And advertise your own site free.',
    path: `/${kind}`,
    body: `<section class="hero"><h1>${advertise ? (ctx.free ? 'Advertise free while we launch' : 'Advertise from one link') : 'Earn from your site'}</h1>
<p class="tag">${advertise ? 'Paste the page people should land on. That is the whole setup.' : 'Indie sites, blogs, docs and tools: one tag, one wallet, done.'}</p>
<p><a class="btn big" href="${start}">${advertise ? (ctx.free ? 'Run my free ad' : 'Run my ad') : 'Add my site'}</a></p>
<p class="muted small">Sign in with CoinPay (free; you can make an account on the way).</p></section>
<div class="grid3">${points.map(([h, t], i) => `<div class="card"><h2><span class="step-n">${i + 1}</span>${esc(h!)}</h2><p class="muted">${esc(t!)}</p></div>`).join('')}</div>
<p class="muted small"><a href="/help#${advertise ? 'advertisers' : 'publishers'}">How it works</a></p>`,
  })
}

export function messagePage(ctx: Ctx, o: { title: string; message: string }): string {
  return layout({ ctx, noindex: true, title: `${o.title} · ad.network`, description: o.message, path: '/', body: `<section class="hero"><h1>${esc(o.title)}</h1><p class="tag">${esc(o.message)}</p><a class="btn" href="/">Home</a></section>` })
}

export function installScript(): string {
  return `#!/bin/sh
# ad.network CLI installer: curl -fsSL ${SITE}/install.sh | sh
set -e
if ! command -v bun >/dev/null 2>&1; then
  echo "Installing bun (https://bun.sh) first..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi
bun add -g @profullstack/adnetwork
echo
echo "Installed: adnetwork. Make a key at ${SITE}/me, then:"
echo "  export ADNETWORK_KEY=an_..."
echo "  adnetwork"
`
}

export type InviteView = { id: string; note: string; createdAt: number; expiresAt: number | null; usedBy: string | null; usedAt: number | null; revokedAt?: number | null }

/** /invites: your scarce invites, an invite code to accept, and a credit code to redeem. */
export function invitesPage(
  ctx: Ctx,
  o: { quota: { total: number; used: number; left: number }; invites: InviteView[]; bonusCents: number; canInvite: string | null; myBonus: { paid: boolean; reason: string | null } | null; link?: string; flash?: string; error?: string; code?: string },
): string {
  const now = Date.now()
  const state = (i: InviteView) => (i.usedBy ? `used ${when(i.usedAt ?? now)}` : i.revokedAt ? 'withdrawn' : i.expiresAt && i.expiresAt < now ? 'expired' : `open until ${when(i.expiresAt ?? now).slice(0, 10)}`)
  return layout({
    ctx,
    noindex: true,
    script: true,
    title: 'Invites · ad.network',
    description: 'Your ad.network invites and credit codes.',
    path: '/invites',
    body: `<section class="hero" style="padding-bottom:1rem"><h1>Invites</h1><p class="tag">Invites are scarce on purpose: ${o.quota.total} each, one use, 30 days. When someone new joins with yours, you both get <b>${usd(o.bonusCents)}</b> of ad credit.</p></section>
${flashNote(o.flash)}${flashNote(o.error, true)}
<div class="card"><h2>Your invites <span class="muted small">${o.quota.left} of ${o.quota.total} left</span></h2>
${o.link ? `<p>Your new invite link, shown once:</p><div class="address"><code>${esc(o.link)}</code><button class="copy" type="button" data-copy="${esc(o.link)}">Copy</button></div>` : ''}
${o.canInvite ? `<p class="muted small">${esc(o.canInvite)}</p>` : o.quota.left > 0 ? `<form method="post" action="/invites" class="row">${csrfField(ctx)}<input name="note" maxlength="80" placeholder="Who is it for? (optional)" aria-label="Note"><button class="btn">Make an invite</button></form>` : '<p class="muted small">No invites left.</p>'}
${o.invites.length ? `<table><thead><tr><th>For</th><th>Made</th><th>Status</th></tr></thead><tbody>${o.invites.map((i) => `<tr><td>${esc(i.note || 'invite')}</td><td>${when(i.createdAt).slice(0, 10)}</td><td>${esc(state(i))}</td></tr>`).join('')}</tbody></table>` : '<p class="muted small">None yet.</p>'}</div>
<div class="card"><h2>Have an invite code?</h2>${o.myBonus ? `<p class="muted small">You joined with an invite${o.myBonus.paid ? ' and the ad credit is on your balance.' : '.'}</p>` : `<p class="muted small">New accounts (under a week old) can accept one invite.</p><form method="post" action="/invites/accept" class="row">${csrfField(ctx)}<input name="code" required placeholder="INV-XXXX-XXXX-XXXX" value="${esc(o.code ?? '')}" autocomplete="off" spellcheck="false" aria-label="Invite code"><button class="btn">Accept</button></form>`}</div>
${redeemCard(ctx)}`,
  })
}

/** /i/<code>: someone sent you an invite. */
export function inviteLandingPage(ctx: Ctx, o: { code: string | null; bonusCents: number }): string {
  return layout({
    ctx,
    noindex: true,
    title: "You're invited · ad.network",
    description: 'Someone invited you to ad.network: run ads, or earn from your site, in crypto.',
    path: '/',
    body: o.code
      ? `<section class="hero"><h1>You're invited</h1><p class="tag">Someone on ad.network wants you in. Sign in with CoinPay and you both get <b>${usd(o.bonusCents)}</b> of ad credit to run your first ads.</p>
<p><a class="btn big" href="${ctx.user ? `/invites?code=${encodeURIComponent(o.code)}` : '/auth/start?next=/invites'}">${ctx.user ? 'Accept on my account' : 'Sign in with CoinPay'}</a></p>
<p class="muted small">Invite <code>${esc(o.code)}</code>. For new accounts, one per account. On another device? Paste the code at <a href="/invites">/invites</a>.</p></section>`
      : `<section class="hero"><h1>Not an invite</h1><p class="tag">That invite link is not right. Ask for a fresh one.</p><a class="btn" href="/">Home</a></section>`,
  })
}
