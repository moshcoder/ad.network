/**
 * What ad.network does, apart from pages.
 *
 * Advertisers: paste a link and a daily budget, add budget in crypto, done.
 * Their campaigns run on crawlproof under ad.network's advertiser account, which
 * holds everyone's budget in one balance, so the line between advertisers is
 * kept here: a campaign runs only while its owner's own balance (deposits in,
 * minus what their campaigns spent) is above zero. The sweep re-reads spend
 * every few minutes and pauses anyone who has run out, so the most anyone can
 * overspend is one sweep of one day's budget.
 *
 * Publishers: name a site, paste one tag, add a wallet, withdraw. Each site is
 * its own crawlproof slot that pays its own wallet; ad.network never holds a
 * publisher's money. A site belongs to whoever proves it: the tag carries a
 * claim code per person, and withdrawals wait until we have seen it on the page.
 */
import { createHmac, randomBytes } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { COINS, CoinPay } from '@profullstack/coinpay-onboard'
import { refresh as refreshTokens } from '@profullstack/coinpay-onboard/oauth'
import { Crawlproof, CrawlproofError } from './crawlproof.js'
import type { Campaign, DepositRow, Site, Store, User } from './db.js'

export type Config = {
  coinpayBase: string
  clientId: string
  clientSecret?: string
  crawlproofBase: string
  /** crp_ token of the account that owns every advertiser's campaigns. */
  advertiserToken: string
  /** crp_ token of the account that owns every publisher's slots. */
  publisherToken: string
  /** Signs claim codes. */
  key: string
  fetch?: typeof fetch
  /** Fetches a publisher's page to look for their tag; tests swap it. */
  fetchPage?: (url: string) => Promise<string>
}

export class UserError extends Error {
  constructor(message: string, readonly field?: string, readonly status = 400) {
    super(message)
  }
}

export const MIN_DAILY_USD = 1
export const MAX_DAILY_USD = 1000
export const MIN_DEPOSIT_USD = 5
export const MAX_DEPOSIT_USD = 10_000
/** What one click costs at the default bid, in cents: 4 credits at 5c. */
export const CLICK_CENTS = 20
export const MIN_PAYOUT_CENTS = 500
/** How long a claim may sit unproven before someone who proves the site can take it. */
export const CLAIM_GRACE_MS = 24 * 3600_000

/** Coins a deposit can be paid in, stablecoins first. */
export const DEPOSIT_COINS = COINS.map((c) => c.id) as string[]
/** Coins crawlproof pays publishers in. */
export const PAYOUT_COINS = ['usdc_pol', 'usdc_sol', 'usdc_base', 'usdc_eth'] as const

export function coinName(id: string): string {
  return COINS.find((c) => c.id === id)?.name ?? id.toUpperCase()
}

export const usd = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** A destination URL for an ad: https or http, a public-looking host. */
export function cleanUrl(input: string): string {
  let raw = String(input ?? '').trim()
  if (!raw) throw new UserError('Paste the link people should land on.', 'url')
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new UserError('That is not a link.', 'url')
  }
  if (!publicHostname(u.hostname)) throw new UserError('That link is not on the public web.', 'url')
  u.hash = ''
  return u.toString()
}

/** A publisher's site as a bare hostname. */
export function cleanHost(input: string): string {
  const raw = String(input ?? '').trim().toLowerCase()
  if (!raw) throw new UserError('Name your site, e.g. example.com.', 'site')
  let host: string
  try {
    host = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`).hostname
  } catch {
    throw new UserError('That is not a site name.', 'site')
  }
  host = host.replace(/^www\./, '').replace(/\.$/, '')
  if (!publicHostname(host)) throw new UserError('Use a site on the public web, e.g. example.com.', 'site')
  return host
}

function publicHostname(host: string): boolean {
  const h = host.toLowerCase()
  if (!h.includes('.') || isIP(h.replace(/^\[|\]$/g, ''))) return false
  return !/(^|\.)(localhost|local|internal|lan|home|test|invalid|example)$/.test(h)
}

/** Addresses a server must never fetch for a user. */
export function privateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase()
    if (v === '::1' || v === '::') return true
    if (v.startsWith('::ffff:')) return privateAddress(v.slice(7))
    return /^(fc|fd|fe8|fe9|fea|feb)/.test(v)
  }
  const [a, b] = ip.split('.').map(Number) as [number, number]
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
}

/** Fetches a public page's HTML, refusing private addresses at every hop. */
export async function fetchPublicPage(url: string, hops = 3): Promise<string> {
  let current = url
  for (let i = 0; i <= hops; i++) {
    const u = new URL(current)
    if (!/^https?:$/.test(u.protocol)) throw new UserError('Your site redirects somewhere we cannot follow.')
    const addrs = await lookup(u.hostname, { all: true }).catch(() => [])
    if (!addrs.length) throw new UserError(`We could not find ${u.hostname}.`)
    if (addrs.some((a) => privateAddress(a.address))) throw new UserError(`${u.hostname} is not on the public web.`)
    const r = await fetch(current, { redirect: 'manual', headers: { 'user-agent': 'ad.network-verify/1 (+https://ad.network.pit.world/help#publishers)', accept: 'text/html' }, signal: AbortSignal.timeout(10_000) })
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      current = new URL(r.headers.get('location')!, current).toString()
      continue
    }
    if (!r.ok) throw new UserError(`${u.hostname} answered ${r.status}.`)
    const reader = r.body?.getReader()
    if (!reader) return ''
    let html = ''
    const decoder = new TextDecoder()
    while (html.length < 2_000_000) {
      const { done, value } = await reader.read()
      if (done) break
      html += decoder.decode(value, { stream: true })
    }
    reader.cancel().catch(() => {})
    return html
  }
  throw new UserError('Your site redirects too many times.')
}

export class AdNetwork {
  readonly ads: Crawlproof
  readonly pubs: Crawlproof
  private refreshing = new Map<string, Promise<CoinPay>>()

  constructor(
    readonly store: Store,
    readonly config: Config,
  ) {
    this.ads = new Crawlproof(config.crawlproofBase, config.advertiserToken, config.fetch)
    this.pubs = new Crawlproof(config.crawlproofBase, config.publisherToken, config.fetch)
  }

  // ---- CoinPay, as the person (only to suggest their own payout wallet) ----

  clientFor(sub: string): Promise<CoinPay> {
    const pending = this.refreshing.get(sub)
    if (pending) return pending
    const tokens = this.store.tokens(sub)
    if (!tokens) return Promise.reject(new UserError('Sign in with CoinPay again.'))
    const make = (token: string) => new CoinPay({ base: this.config.coinpayBase, token, ...(this.config.fetch ? { fetch: this.config.fetch } : {}) })
    if (tokens.expiresAt - Date.now() > 60_000) return Promise.resolve(make(tokens.accessToken))
    if (!tokens.refreshToken) return Promise.reject(new UserError('Your CoinPay sign-in has expired. Sign in again.'))
    const job = refreshTokens({
      refreshToken: tokens.refreshToken,
      clientId: this.config.clientId,
      ...(this.config.clientSecret ? { clientSecret: this.config.clientSecret } : {}),
      base: this.config.coinpayBase,
      ...(this.config.fetch ? { fetch: this.config.fetch } : {}),
    })
      .then((next) => {
        this.store.saveTokens(sub, { accessToken: next.accessToken, refreshToken: next.refreshToken ?? tokens.refreshToken, expiresAt: next.expiresAt })
        return make(next.accessToken)
      })
      .finally(() => this.refreshing.delete(sub))
    this.refreshing.set(sub, job)
    return job
  }

  /** Their CoinPay payout wallets in coins crawlproof pays out in, to prefill the form. */
  async walletSuggestions(sub: string): Promise<{ coin: string; address: string }[]> {
    try {
      const wallets = await (await this.clientFor(sub)).wallets('account')
      return wallets
        .map((w) => ({ coin: String(w.cryptocurrency ?? '').toLowerCase(), address: String(w.address ?? w.wallet_address ?? '') }))
        .filter((w) => (PAYOUT_COINS as readonly string[]).includes(w.coin) && w.address)
    } catch {
      return []
    }
  }

  // ---- advertisers ----------------------------------------------------------

  balanceCents(sub: string): number {
    return this.store.balanceCents(sub)
  }

  /** A new ad for `url`. It starts running as soon as its owner has budget. */
  async runAd(user: User, input: { url: string; dailyBudgetUsd: number; name?: string }): Promise<Campaign> {
    const url = cleanUrl(input.url)
    const daily = Math.round(Number(input.dailyBudgetUsd) * 100)
    if (!Number.isFinite(daily) || daily < MIN_DAILY_USD * 100 || daily > MAX_DAILY_USD * 100) throw new UserError(`A daily budget is $${MIN_DAILY_USD} to $${MAX_DAILY_USD}.`, 'budget')
    if (this.store.campaigns(user.sub).length >= 50) throw new UserError('You have 50 ads already. Delete one first.')
    const funded = this.balanceCents(user.sub) > 0
    let c
    try {
      c = await this.ads.createCampaign({ url, ...(input.name?.trim() ? { name: input.name.trim().slice(0, 80) } : {}), daily_budget_cents: daily, status: funded ? 'active' : 'draft' })
    } catch (e) {
      throw new UserError(e instanceof CrawlproofError && e.status < 500 ? e.message : 'The ad service did not answer. Try again in a minute.', 'url', 502)
    }
    // crawlproof answers an existing live campaign for the same page (query
    // string ignored) instead of making a second one. If it is someone else's
    // that is a refusal; one nobody here owns is ours to adopt (a create whose
    // answer never reached us).
    const mine = this.store.campaign(c.id)
    if (mine) {
      if (mine.sub !== user.sub) throw new UserError('Someone already runs an ad for that page. Link a different page of yours (the part after ? does not count).', 'url', 409)
      return mine
    }
    const creative = Array.isArray(c.creatives) ? (c.creatives.find((k) => k.headline) ?? c.creatives[0]) : undefined
    // crawlproof's own form of the page (it drops the query string) is the one it serves.
    const row = this.store.addCampaign({ id: c.id, ref: c.ref_slug, sub: user.sub, url: c.destination_url || url, name: c.name, dailyBudgetCents: daily, status: c.status, headline: creative?.headline ?? '', body: creative?.body ?? '' })
    await this.enforce(user.sub).catch(() => {})
    return this.store.campaign(row.id)!
  }

  private own(user: User, ref: string): Campaign {
    const c = this.store.campaign(ref)
    if (!c || c.sub !== user.sub) throw new UserError('No such ad.', undefined, 404)
    return c
  }

  async setRunning(user: User, ref: string, running: boolean): Promise<Campaign> {
    const c = this.own(user, ref)
    this.store.updateCampaign(c.id, { wanted: running ? 'active' : 'paused' })
    await this.enforce(user.sub)
    return this.store.campaign(c.id)!
  }

  async setDailyBudget(user: User, ref: string, dailyUsd: number): Promise<Campaign> {
    const c = this.own(user, ref)
    const daily = Math.round(Number(dailyUsd) * 100)
    if (!Number.isFinite(daily) || daily < MIN_DAILY_USD * 100 || daily > MAX_DAILY_USD * 100) throw new UserError(`A daily budget is $${MIN_DAILY_USD} to $${MAX_DAILY_USD}.`, 'budget')
    await this.ads.updateCampaign(c.id, { daily_budget_cents: daily })
    this.store.updateCampaign(c.id, { dailyBudgetCents: daily })
    return this.store.campaign(c.id)!
  }

  async deleteAd(user: User, ref: string): Promise<void> {
    const c = this.own(user, ref)
    await this.refreshCampaign(c).catch(() => {})
    // Pause rather than delete on crawlproof: its spend history is the record of what this person's money bought.
    await this.ads.updateCampaign(c.id, { status: 'paused' }).catch((e) => {
      if (!(e instanceof CrawlproofError && e.status === 404)) throw e
    })
    this.store.removeCampaign(c.id)
  }

  /** Re-reads a campaign's numbers from crawlproof. */
  async refreshCampaign(c: Campaign): Promise<Campaign> {
    const fresh = await this.ads.campaign(c.id)
    const s = fresh.stats
    this.store.updateCampaign(c.id, {
      status: fresh.status,
      ...(s ? { impressions: s.impressions + s.free_impressions, clicks: s.clicks + s.free_clicks, spentCents: Math.max(c.spentCents, Math.round(s.spent_cents)) } : {}),
      syncedAt: Date.now(),
    })
    return this.store.campaign(c.id)!
  }

  /**
   * Runs what should run and pauses what should not: an ad runs when its owner
   * wants it to and their balance is above zero.
   */
  async enforce(sub: string): Promise<void> {
    const funded = this.balanceCents(sub) > 0
    for (const c of this.store.campaigns(sub)) {
      const target = c.wanted === 'active' && funded ? 'active' : 'paused'
      const current = c.status === 'active' ? 'active' : 'paused'
      if (target === current) continue
      // A draft with nothing to pause stays a draft until it is funded.
      if (target === 'paused' && c.status === 'draft') continue
      try {
        const r = await this.ads.updateCampaign(c.id, { status: target })
        this.store.updateCampaign(c.id, { status: r.status ?? target })
      } catch (e) {
        // 409: crawlproof is still writing the ad. The next sweep tries again.
        if (!(e instanceof CrawlproofError && e.status === 409)) throw e
      }
    }
  }

  async fund(user: User, input: { amountUsd: number; coin?: string }): Promise<DepositRow> {
    const amount = Math.round(Number(input.amountUsd) * 100) / 100
    if (!Number.isFinite(amount) || amount < MIN_DEPOSIT_USD || amount > MAX_DEPOSIT_USD) throw new UserError(`Add $${MIN_DEPOSIT_USD} to $${MAX_DEPOSIT_USD.toLocaleString('en-US')}.`, 'amount')
    const coin = input.coin && DEPOSIT_COINS.includes(input.coin) ? input.coin : 'usdc_pol'
    if (this.store.pendingDeposits(user.sub).length >= 5) throw new UserError('You have five unpaid deposits open. Pay one or wait for them to expire.')
    let d
    try {
      d = await this.ads.deposit({ amount_usd: amount, currency: coin, reference: `ad.network:${user.sub}` })
    } catch (e) {
      throw new UserError(e instanceof CrawlproofError && e.status < 500 ? e.message : 'The payment service did not answer. Try again in a minute.', undefined, 502)
    }
    return this.store.addDeposit({ id: d.payment_id, sub: user.sub, amountCents: Math.round(amount * 100), coin, address: d.address ?? '', amountCrypto: d.amount_crypto ?? '', status: 'pending', expiresAt: d.expires_at ?? null })
  }

  /** A deposit's status, asked of crawlproof while it is open; a paid one starts the owner's ads. */
  async followDeposit(id: string): Promise<DepositRow | null> {
    const row = this.store.deposit(id)
    if (!row || row.status !== 'pending') return row
    try {
      const d = await this.ads.depositStatus(id)
      if (d.status !== row.status) {
        this.store.setDepositStatus(id, d.status)
        if (d.status === 'complete') await this.enforce(row.sub).catch(() => {})
      }
    } catch {
      // crawlproof unreachable: show what we last knew.
    }
    return this.store.deposit(id)
  }

  // ---- publishers -------------------------------------------------------------

  /** The code this person's tag carries for this site, so a page proves who placed it. */
  claimCode(sub: string, host: string): string {
    return createHmac('sha256', this.config.key).update(`claim:${sub}:${host}`).digest('base64url').slice(0, 16)
  }

  /** The tag to paste: crawlproof's unit, carrying our claim code. */
  embedFor(site: Site): string {
    return site.embed.replace('<aside data-cp-ad', `<aside data-ad-network="${this.claimCode(site.sub, site.host)}" data-cp-ad`)
  }

  async addSite(user: User, input: string): Promise<Site> {
    const host = cleanHost(input)
    const existing = this.store.site(host)
    if (existing?.sub === user.sub) return existing
    if (existing) {
      if (existing.verifiedAt) throw new UserError(`${host} is already earning with ad.network.`, 'site', 409)
      // Unproven: whoever shows their own claim code on the site can have it.
      const proven = await this.pageCarries(host, this.claimCode(user.sub, host)).catch(() => false)
      if (!proven && Date.now() - existing.createdAt < CLAIM_GRACE_MS) {
        throw new UserError(`${host} was claimed by someone else and is waiting for their tag. If it is yours, add <meta name="ad.network" content="${this.claimCode(user.sub, host)}"> to your home page and try again.`, 'site', 409)
      }
      return this.store.claimSite({ slotId: existing.slotId, sub: user.sub, host, embed: existing.embed })
    }
    if (this.store.sites(user.sub).length >= 25) throw new UserError('You have 25 sites already.')
    let slot
    try {
      slot = await this.pubs.createSlot(host)
    } catch (e) {
      throw new UserError(e instanceof CrawlproofError && e.status < 500 ? e.message : 'The ad service did not answer. Try again in a minute.', 'site', 502)
    }
    // Another publisher's slot for the same host would come back as `existing`; the host check above already handled it.
    return this.store.claimSite({ slotId: slot.id, sub: user.sub, host, embed: slot.embed ?? '' })
  }

  private ownSite(user: User, idOrHost: string): Site {
    const s = this.store.site(idOrHost)
    if (!s || s.sub !== user.sub) throw new UserError('No such site.', undefined, 404)
    return s
  }

  private async pageCarries(host: string, code: string): Promise<boolean> {
    const html = await (this.config.fetchPage ?? fetchPublicPage)(`https://${host}/`)
    return html.includes(code)
  }

  /** Looks for the tag (or the claim meta) on the site's home page. */
  async verifySite(user: User, idOrHost: string): Promise<Site> {
    const s = this.ownSite(user, idOrHost)
    if (s.verifiedAt) return s
    const found = await this.pageCarries(s.host, this.claimCode(user.sub, s.host))
    if (!found) throw new UserError(`We did not find your tag on https://${s.host}/ yet. Paste it into the page (before </body>), publish, and check again.`)
    this.store.updateSite(s.slotId, { verifiedAt: Date.now() })
    return this.store.site(s.slotId)!
  }

  async setWallet(user: User, idOrHost: string, address: string, coin?: string): Promise<Site> {
    const s = this.ownSite(user, idOrHost)
    const a = String(address ?? '').trim()
    if (!/^[A-Za-z0-9:_-]{20,120}$/.test(a)) throw new UserError('Paste a wallet address.', 'address')
    const c = coin && (PAYOUT_COINS as readonly string[]).includes(coin) ? coin : 'usdc_pol'
    await this.pubs.updateSlot(s.slotId, { payout_address: a, payout_currency: c })
    this.store.updateSite(s.slotId, { payoutAddress: a, payoutCoin: c })
    return this.store.site(s.slotId)!
  }

  async refreshSite(s: Site): Promise<Site> {
    const m = await this.pubs.slot(s.slotId)
    this.store.updateSite(s.slotId, { earnedCents: m.earned_cents, availableCents: m.available_cents, syncedAt: Date.now() })
    return this.store.site(s.slotId)!
  }

  async withdraw(user: User, idOrHost: string): Promise<{ amountCents: number; status: string }> {
    const s = this.ownSite(user, idOrHost)
    if (!s.verifiedAt) throw new UserError('Withdrawals start once we have seen your tag on the site. Press "Check my site".')
    if (!s.payoutAddress) throw new UserError('Add a wallet first.', 'address')
    try {
      const r = await this.pubs.withdraw(s.slotId)
      this.store.addWithdrawal({ slotId: s.slotId, sub: user.sub, amountCents: r.amount_cents, status: r.status })
      await this.refreshSite(s).catch(() => {})
      return { amountCents: r.amount_cents, status: r.status }
    } catch (e) {
      if (e instanceof CrawlproofError && e.status < 500) throw new UserError(e.message)
      throw e
    }
  }

  async removeSite(user: User, idOrHost: string): Promise<void> {
    const s = this.ownSite(user, idOrHost)
    await this.pubs.updateSlot(s.slotId, { status: 'paused' }).catch(() => {})
    this.store.removeSite(s.slotId)
  }

  // ---- the sweep ----------------------------------------------------------------

  /** Everything for one person, fresh: spend, deposits, run/pause, earnings. */
  async sync(sub: string): Promise<void> {
    for (const c of this.store.campaigns(sub)) await this.refreshCampaign(c).catch(() => {})
    for (const d of this.store.pendingDeposits(sub)) await this.followDeposit(d.id)
    await this.enforce(sub).catch((e) => console.error(`enforce ${sub}: ${e instanceof Error ? e.message : e}`))
    for (const s of this.store.sites(sub)) {
      if (!s.verifiedAt && (await this.pageCarries(s.host, this.claimCode(sub, s.host)).catch(() => false))) this.store.updateSite(s.slotId, { verifiedAt: Date.now() })
      await this.refreshSite(s).catch(() => {})
    }
  }

  async sweep(): Promise<void> {
    const people = new Set([...this.store.advertisers(), ...(this.store.db.query('SELECT DISTINCT sub FROM sites').all() as { sub: string }[]).map((r) => r.sub)])
    for (const sub of people) await this.sync(sub).catch((e) => console.error(`sync ${sub}: ${e instanceof Error ? e.message : e}`))
  }

  startSweep(everyMs = 5 * 60_000): () => void {
    let running = false
    const tick = () => {
      if (running) return
      running = true
      this.sweep().finally(() => (running = false))
    }
    const timer = setInterval(tick, everyMs)
    timer.unref?.()
    setTimeout(tick, 5_000).unref?.()
    return () => clearInterval(timer)
  }
}

export const newApiKey = () => `an_${randomBytes(24).toString('base64url')}`
