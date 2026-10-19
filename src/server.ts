/**
 * The ad.network web server: pages, the JSON API, and Sign in with CoinPay.
 *
 * ad.network lives at https://ad.network.pit.world. (.network is a real ICANN
 * ending, so it cannot be a Moshpit name; pit.world is ours, so this host is.)
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import QRCode from 'qrcode'
import { authorizeUrl, exchangeCode, pkce } from '@profullstack/coinpay-onboard/oauth'
import { CoinPay } from '@profullstack/coinpay-onboard'
import { Sealer, Store, type Campaign, type DepositRow, type Site, type User } from './db.js'
import { adPage, advertisePage, depositPage, helpPage, homePage, installScript, mePage, messagePage, publishPage, sitePage, SITE, type Ctx } from './html.js'
import { RING_PLACEHOLDER, ringBar, startRingRefresh } from './ring.js'
import { AdNetwork, newApiKey, UserError, type Config } from './service.js'
import { VERSION } from './version.js'

export { VERSION }

const SELF = 'ad.network.pit.world'
const SESSION = 'an_session'
const SCOPES = ['openid', 'profile', 'email', 'wallet:read']

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' https://crawlproof.com; img-src 'self' data:; connect-src 'self' https://crawlproof.com; form-action 'self' https://coinpayportal.com; base-uri 'none'; frame-ancestors 'none'",
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-content-type-options': 'nosniff',
  'permissions-policy': 'interest-cohort=(), browsing-topics=(), camera=(), microphone=(), geolocation=()',
  'cross-origin-opener-policy': 'same-origin',
}

export type Deps = { store: Store; config: Config; origin?: string; publicDir?: string; secureCookies?: boolean }

type Env = { Bindings: { ip?: string } }

/** A small fixed-window limit per key, in memory: enough to stop a loop, not a fortress. */
class Limiter {
  private hits = new Map<string, { n: number; reset: number }>()
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  allow(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key)
    if (!h || h.reset < now) {
      if (this.hits.size > 50_000) this.hits.clear()
      this.hits.set(key, { n: 1, reset: now + this.windowMs })
      return true
    }
    h.n += 1
    return h.n <= this.max
  }
}

async function qrSvg(text: string): Promise<string> {
  if (!text) return ''
  const svg = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
  return svg.replace('<svg ', '<svg class="qr" role="img" aria-label="QR code" ')
}

const toUsd = (s: unknown) => Number(String(s ?? '').replace(/[$,\s]/g, ''))

export function createApp(deps: Deps) {
  const { store, config } = deps
  const net = new AdNetwork(store, config)
  const ORIGIN = deps.origin ?? SITE
  const app = new Hono<Env>()
  const writeLimit = new Limiter(30, 10 * 60_000)
  const authLimit = new Limiter(30, 10 * 60_000)

  const ip = (c: Context<Env>) => c.env?.ip ?? 'local'
  const sessionId = (c: Context) => getCookie(c, SESSION)
  const csrfFor = (sid: string | undefined) => (sid ? createHmac('sha256', config.key).update(`csrf:${sid}`).digest('hex').slice(0, 32) : '')
  const userOf = (c: Context) => store.session(sessionId(c))
  const ctxOf = (c: Context): Ctx => ({ user: userOf(c), csrf: csrfFor(sessionId(c)) })
  const csrfOk = (c: Context, given: unknown) => {
    const expected = csrfFor(sessionId(c))
    const g = Buffer.from(String(given ?? ''))
    const e = Buffer.from(expected)
    return expected !== '' && g.length === e.length && timingSafeEqual(g, e)
  }
  const page = (c: Context, html: string, status = 200) => c.html(html.replace(RING_PLACEHOLDER, ringBar(SELF, false)), status as 200)
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
  const statusOf = (e: unknown) => (e instanceof UserError ? e.status : 502)

  app.use('*', async (c, next) => {
    await next()
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.header(k, v)
  })

  app.get('/health', (c) => c.json({ ok: true, version: VERSION }))

  const TYPES: Record<string, string> = { css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', svg: 'image/svg+xml', crt: 'application/x-x509-ca-cert' }
  app.get('/:file{(style\\.css|app\\.js|favicon\\.svg|moshpit-root-ca\\.crt)}', async (c) => {
    const name = c.req.param('file')
    const file = Bun.file(new URL(`../public/${name}`, import.meta.url))
    return c.body(await file.arrayBuffer(), 200, { 'content-type': TYPES[name.split('.').pop()!]!, 'cache-control': 'public, max-age=86400' })
  })
  app.get('/install.sh', (c) => c.body(installScript(), 200, { 'content-type': 'text/x-shellscript; charset=utf-8', 'cache-control': 'public, max-age=3600' }))
  // c.text() loses its content-type once the header middleware touches the response; say it outright.
  const plain = (c: Context, text: string) => c.body(text, 200, { 'content-type': 'text/plain; charset=utf-8' })
  app.get('/robots.txt', (c) => plain(c, 'User-agent: *\nDisallow: /api/\nDisallow: /auth/\nSitemap: ' + ORIGIN + '/sitemap.xml\n'))
  app.get('/sitemap.xml', (c) =>
    c.body(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/help'].map((p) => `<url><loc>${ORIGIN}${p}</loc></url>`).join('')}</urlset>`, 200, { 'content-type': 'application/xml' }),
  )
  app.get('/llms.txt', (c) =>
    plain(c, `# ad.network\n\n> Run ads, or earn from your site, in crypto. Sign in with CoinPay. Ads by crawlproof.\n\n- Help and API: ${ORIGIN}/help\n- CLI: bunx @profullstack/adnetwork\n- MCP: claude mcp add adnetwork -- bunx @profullstack/adnetwork mcp\n`),
  )

  app.get('/', (c) => page(c, homePage(ctxOf(c))))
  app.get('/help', (c) => page(c, helpPage(ctxOf(c))))

  // ---- Sign in with CoinPay -----------------------------------------------------

  app.get('/auth/start', (c) => {
    if (!authLimit.allow(`auth:${ip(c)}`)) return page(c, messagePage(ctxOf(c), { title: 'Slow down', message: 'Too many sign-in attempts. Try again in a few minutes.' }), 429)
    // Where to land after sign-in rides in the state CoinPay echoes back: "<random>.<path>".
    const next = c.req.query('next') ?? ''
    const state = `${randomBytes(16).toString('base64url')}.${/^\/[a-z]{1,20}$/.test(next) ? next.slice(1) : 'me'}`
    const { verifier, challenge } = pkce()
    const redirectUri = `${ORIGIN}/auth/callback`
    store.saveState(state, verifier, redirectUri)
    return c.redirect(authorizeUrl({ clientId: config.clientId, redirectUri, state, challenge, scopes: SCOPES, base: config.coinpayBase }))
  })

  app.get('/auth/callback', async (c) => {
    const ctx = ctxOf(c)
    const error = c.req.query('error')
    if (error) return page(c, messagePage(ctx, { title: 'Not signed in', message: c.req.query('error_description') ?? 'CoinPay did not sign you in.' }), 400)
    const state = c.req.query('state') ?? ''
    const saved = state ? store.takeState(state) : null
    const code = c.req.query('code')
    if (!saved || !code) return page(c, messagePage(ctx, { title: 'Sign-in expired', message: 'That sign-in link is old. Start again.' }), 400)
    try {
      const tokens = await exchangeCode({ code, verifier: saved.verifier, clientId: config.clientId, ...(config.clientSecret ? { clientSecret: config.clientSecret } : {}), redirectUri: saved.redirectUri, base: config.coinpayBase, ...(config.fetch ? { fetch: config.fetch } : {}) })
      const me = await new CoinPay({ base: config.coinpayBase, token: tokens.accessToken, ...(config.fetch ? { fetch: config.fetch } : {}) }).userinfo()
      const user = store.upsertUser(me.sub, me.name ?? '', me.email ?? '', tokens)
      const sid = store.newSession(user.sub)
      setCookie(c, SESSION, sid, { httpOnly: true, secure: deps.secureCookies ?? true, sameSite: 'Lax', path: '/', maxAge: 30 * 86400 })
      return c.redirect(`/${state.split('.')[1] ?? 'me'}`)
    } catch (e) {
      return page(c, messagePage(ctx, { title: 'Sign-in failed', message: e instanceof Error ? e.message : 'CoinPay did not answer.' }), 502)
    }
  })

  app.post('/auth/logout', async (c) => {
    const form = await c.req.parseBody()
    if (csrfOk(c, form.csrf)) store.endSession(sessionId(c))
    deleteCookie(c, SESSION, { path: '/' })
    return c.redirect('/')
  })

  /** Signed-in pages: the user, or a redirect to sign in that comes back here. */
  const LANDING: Record<string, string> = { advertise: 'advertise', ads: 'advertise', deposits: 'advertise', publish: 'publish', sites: 'publish' }
  const need = (c: Context): User | Response => userOf(c) ?? c.redirect(`/auth/start?next=/${LANDING[c.req.path.split('/')[1] ?? ''] ?? 'me'}`)
  const formOf = async (c: Context) => (await c.req.parseBody()) as Record<string, string>

  // ---- advertisers --------------------------------------------------------------

  const advertise = (c: Context, user: User, extra: { flash?: string; error?: string; values?: Record<string, string> } = {}, status = 200) =>
    page(c, advertisePage(ctxOf(c), { balanceCents: net.balanceCents(user.sub), campaigns: store.campaigns(user.sub), deposits: store.deposits(user.sub), ...extra }), status)

  app.get('/advertise', (c) => {
    const user = need(c)
    return user instanceof Response ? user : advertise(c, user)
  })

  app.post('/advertise', async (c) => {
    const user = need(c)
    if (user instanceof Response) return user
    const form = await formOf(c)
    if (!csrfOk(c, form.csrf)) return advertise(c, user, { error: 'That form went stale. Try again.', values: form }, 400)
    if (!writeLimit.allow(`w:${user.sub}`)) return advertise(c, user, { error: 'Too many changes. Wait a few minutes.', values: form }, 429)
    try {
      const ad = await net.runAd(user, { url: form.url ?? '', dailyBudgetUsd: toUsd(form.daily) })
      return c.redirect(`/ads/${ad.ref}?made=1`)
    } catch (e) {
      return advertise(c, user, { error: message(e), values: form }, statusOf(e))
    }
  })

  app.post('/advertise/fund', async (c) => {
    const user = need(c)
    if (user instanceof Response) return user
    const form = await formOf(c)
    if (!csrfOk(c, form.csrf)) return advertise(c, user, { error: 'That form went stale. Try again.' }, 400)
    if (!writeLimit.allow(`w:${user.sub}`)) return advertise(c, user, { error: 'Too many changes. Wait a few minutes.' }, 429)
    try {
      const d = await net.fund(user, { amountUsd: toUsd(form.amount), coin: form.coin })
      return c.redirect(`/deposits/${d.id}`)
    } catch (e) {
      return advertise(c, user, { error: message(e), values: form }, statusOf(e))
    }
  })

  const ownAd = (user: User, ref: string): Campaign | null => {
    const ad = store.campaign(ref)
    return ad && ad.sub === user.sub ? ad : null
  }

  app.get('/ads/:ref', async (c) => {
    const user = need(c)
    if (user instanceof Response) return user
    let ad = ownAd(user, c.req.param('ref'))
    if (!ad) return page(c, messagePage(ctxOf(c), { title: 'No such ad', message: 'That ad is not yours, or it is gone.' }), 404)
    if (Date.now() - ad.syncedAt > 60_000) ad = await net.refreshCampaign(ad).catch(() => ad!)
    const made = c.req.query('made') ? (net.balanceCents(user.sub) > 0 ? 'Your ad is running.' : 'Your ad is ready. Add budget and it starts.') : undefined
    return page(c, adPage(ctxOf(c), { c: ad!, ...(made ? { flash: made } : {}) }))
  })

  app.post('/ads/:ref/:action{(pause|resume|budget|delete)}', async (c) => {
    const user = need(c)
    if (user instanceof Response) return user
    const ad = ownAd(user, c.req.param('ref'))
    if (!ad) return page(c, messagePage(ctxOf(c), { title: 'No such ad', message: 'That ad is not yours, or it is gone.' }), 404)
    const form = await formOf(c)
    if (!csrfOk(c, form.csrf)) return page(c, adPage(ctxOf(c), { c: ad, error: 'That form went stale. Try again.' }), 400)
    try {
      switch (c.req.param('action')) {
        case 'pause':
        case 'resume': {
          const next = await net.setRunning(user, ad.ref, c.req.param('action') === 'resume')
          const flash = next.wanted === 'active' && next.status !== 'active' ? 'It runs again as soon as you add budget.' : next.wanted === 'active' ? 'Running.' : 'Paused.'
          return page(c, adPage(ctxOf(c), { c: next, flash }))
        }
        case 'budget':
          return page(c, adPage(ctxOf(c), { c: await net.setDailyBudget(user, ad.ref, toUsd(form.daily)), flash: 'Daily budget saved.' }))
        case 'delete':
          await net.deleteAd(user, ad.ref)
          return advertise(c, user, { flash: 'Deleted.' })
      }
    } catch (e) {
      return page(c, adPage(ctxOf(c), { c: store.campaign(ad.id) ?? ad, error: message(e) }), statusOf(e))
    }
    return c.redirect(`/ads/${ad.ref}`)
  })

  const ownDeposit = (c: Context, id: string): DepositRow | null => {
    const user = userOf(c)
    const d = store.deposit(id)
    return user && d && d.sub === user.sub ? d : null
  }

  app.get('/deposits/:id{[^/]+\\.json}', async (c) => {
    const id = c.req.param('id').replace(/\.json$/, '')
    if (!ownDeposit(c, id)) return c.json({ error: 'not found' }, 404)
    const d = await net.followDeposit(id)
    return c.json({ id: d!.id, status: d!.status })
  })

  app.get('/deposits/:id', async (c) => {
    const user = need(c)
    if (user instanceof Response) return user
    if (!ownDeposit(c, c.req.param('id'))) return page(c, messagePage(ctxOf(c), { title: 'No such deposit', message: 'That deposit is not yours.' }), 404)
    const d = (await net.followDeposit(c.req.param('id')))!
    return page(c, depositPage(ctxOf(c), { d, qr: await qrSvg(d.address) }))
  })

  // ---- publishers -----------------------------------------------------------------

  const publish = (c: Context, user: User, extra: { flash?: string; error?: string; values?: Record<string, string> } = {}, status = 200) =>
    page(c, publishPage(ctxOf(c), { sites: store.sites(user.sub), withdrawals: store.withdrawals(user.sub), ...extra }), status)

  app.get('/publish', (c) => {
    const user = need(c)
    return user instanceof Response ? user : publish(c, user)
  })

  app.post('/publish', async (c) => {
    const user = need(c)
    if (user instanceof Response) return user
    const form = await formOf(c)
    if (!csrfOk(c, form.csrf)) return publish(c, user, { error: 'That form went stale. Try again.', values: form }, 400)
    if (!writeLimit.allow(`w:${user.sub}`)) return publish(c, user, { error: 'Too many changes. Wait a few minutes.', values: form }, 429)
    try {
      const s = await net.addSite(user, form.site ?? '')
      return c.redirect(`/sites/${s.host}`)
    } catch (e) {
      return publish(c, user, { error: message(e), values: form }, statusOf(e))
    }
  })

  const ownSite = (user: User, host: string): Site | null => {
    const s = store.site(host)
    return s && s.sub === user.sub ? s : null
  }
  const siteView = async (c: Context, user: User, s: Site, extra: { flash?: string; error?: string } = {}, status = 200) =>
    page(c, sitePage(ctxOf(c), { s: store.site(s.slotId) ?? s, embed: net.embedFor(s), suggestions: s.payoutAddress ? [] : await net.walletSuggestions(user.sub), ...extra }), status)

  app.get('/sites/:host', async (c) => {
    const user = need(c)
    if (user instanceof Response) return user
    let s = ownSite(user, c.req.param('host'))
    if (!s) return page(c, messagePage(ctxOf(c), { title: 'No such site', message: 'That site is not yours, or it is gone.' }), 404)
    if (Date.now() - s.syncedAt > 60_000) s = await net.refreshSite(s).catch(() => s!)
    return siteView(c, user, s!)
  })

  app.post('/sites/:host/:action{(check|wallet|withdraw|delete)}', async (c) => {
    const user = need(c)
    if (user instanceof Response) return user
    const s = ownSite(user, c.req.param('host'))
    if (!s) return page(c, messagePage(ctxOf(c), { title: 'No such site', message: 'That site is not yours, or it is gone.' }), 404)
    const form = await formOf(c)
    if (!csrfOk(c, form.csrf)) return siteView(c, user, s, { error: 'That form went stale. Try again.' }, 400)
    if (!writeLimit.allow(`w:${user.sub}`)) return siteView(c, user, s, { error: 'Too many changes. Wait a few minutes.' }, 429)
    try {
      switch (c.req.param('action')) {
        case 'check':
          await net.verifySite(user, s.slotId)
          return siteView(c, user, s, { flash: 'Found your tag. You are live.' })
        case 'wallet':
          await net.setWallet(user, s.slotId, form.address ?? '', form.coin)
          return siteView(c, user, s, { flash: 'Wallet saved.' })
        case 'withdraw': {
          const r = await net.withdraw(user, s.slotId)
          return siteView(c, user, s, { flash: r.status === 'requested' ? `Withdrawal of ${(r.amountCents / 100).toFixed(2)} USD queued; it goes out shortly.` : `Sent ${(r.amountCents / 100).toFixed(2)} USD to your wallet.` })
        }
        case 'delete':
          await net.removeSite(user, s.slotId)
          return publish(c, user, { flash: `Ads stopped on ${s.host}.` })
      }
    } catch (e) {
      return siteView(c, user, s, { error: message(e) }, statusOf(e))
    }
    return c.redirect(`/sites/${s.host}`)
  })

  // ---- me ---------------------------------------------------------------------------

  app.get('/me', (c) => {
    const user = need(c)
    return user instanceof Response ? user : page(c, mePage(ctxOf(c), { user, balanceCents: net.balanceCents(user.sub) }))
  })

  app.post('/me/:action{(key|delete)}', async (c) => {
    const user = need(c)
    if (user instanceof Response) return user
    const form = await formOf(c)
    if (!csrfOk(c, form.csrf)) return page(c, mePage(ctxOf(c), { user, balanceCents: net.balanceCents(user.sub), flash: 'That form went stale. Try again.' }), 400)
    if (c.req.param('action') === 'key') {
      const key = newApiKey()
      store.setApiKey(user.sub, key)
      return page(c, mePage(ctxOf(c), { user: store.user(user.sub)!, balanceCents: net.balanceCents(user.sub), apiKey: key }))
    }
    for (const ad of store.campaigns(user.sub)) await net.ads.updateCampaign(ad.id, { status: 'paused' }).catch(() => {})
    for (const s of store.sites(user.sub)) await net.pubs.updateSlot(s.slotId, { status: 'paused' }).catch(() => {})
    store.deleteUser(user.sub)
    deleteCookie(c, SESSION, { path: '/' })
    return c.redirect('/')
  })

  // ---- the API -------------------------------------------------------------------------

  const param = (c: Context, name: string) => c.req.param(name) ?? ''

  const apiUser = (c: Context): User | null => {
    const key = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
    return key.startsWith('an_') ? store.byApiKey(key) : null
  }
  const api = (handler: (c: Context, user: User) => Promise<Response> | Response) => async (c: Context<Env>) => {
    const user = apiUser(c)
    if (!user) return c.json({ error: `send your API key: authorization: Bearer an_… (make one at ${ORIGIN}/me)` }, 401)
    if (c.req.method !== 'GET' && !writeLimit.allow(`w:${user.sub}`)) return c.json({ error: 'too many changes; wait a few minutes' }, 429)
    try {
      return await handler(c, user)
    } catch (e) {
      return c.json({ error: message(e) }, statusOf(e) as 400)
    }
  }
  const body = async (c: Context) => ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
  const adJson = (a: Campaign) => ({
    ref: a.ref,
    name: a.name,
    url: a.url,
    daily_usd: a.dailyBudgetCents / 100,
    running: a.status === 'active',
    wanted: a.wanted,
    status: a.status,
    headline: a.headline,
    body: a.body,
    views: a.impressions,
    clicks: a.clicks,
    spent_usd: a.spentCents / 100,
    page: `${ORIGIN}/ads/${a.ref}`,
  })
  const depositJson = (d: DepositRow) => ({ id: d.id, amount_usd: d.amountCents / 100, coin: d.coin, address: d.address, amount_crypto: d.amountCrypto, status: d.status, expires_at: d.expiresAt, page: `${ORIGIN}/deposits/${d.id}` })
  const siteJson = (s: Site) => ({
    site: s.host,
    tag: net.embedFor(s),
    live: Boolean(s.verifiedAt),
    wallet: s.payoutAddress || null,
    coin: s.payoutCoin,
    earned_usd: s.earnedCents / 100,
    withdrawable_usd: s.availableCents / 100,
    page: `${ORIGIN}/sites/${s.host}`,
  })
  const apiAd = (user: User, ref: string) => {
    const a = store.campaign(ref)
    if (!a || a.sub !== user.sub) throw new UserError('no such ad', undefined, 404)
    return a
  }
  const apiSite = (user: User, host: string) => {
    const s = store.site(host)
    if (!s || s.sub !== user.sub) throw new UserError('no such site', undefined, 404)
    return s
  }

  app.get(
    '/api/v1/me',
    api((c, u) =>
      c.json({ name: u.name, email: u.email, balance_usd: Math.max(0, net.balanceCents(u.sub)) / 100, ads: store.campaigns(u.sub).map(adJson), deposits: store.deposits(u.sub).map(depositJson), sites: store.sites(u.sub).map(siteJson) }),
    ),
  )
  app.get('/api/v1/ads', api((c, u) => c.json({ ads: store.campaigns(u.sub).map(adJson) })))
  app.post(
    '/api/v1/ads',
    api(async (c, u) => {
      const b = await body(c)
      const ad = await net.runAd(u, { url: String(b.url ?? ''), dailyBudgetUsd: Number(b.daily_usd ?? 5), ...(typeof b.name === 'string' ? { name: b.name } : {}) })
      return c.json({ ...adJson(ad), balance_usd: Math.max(0, net.balanceCents(u.sub)) / 100 }, 201)
    }),
  )
  app.get('/api/v1/ads/:ref', api(async (c, u) => c.json(adJson(await net.refreshCampaign(apiAd(u, param(c, 'ref')))))))
  app.patch(
    '/api/v1/ads/:ref',
    api(async (c, u) => {
      const a = apiAd(u, param(c, 'ref'))
      const b = await body(c)
      if (b.daily_usd !== undefined) await net.setDailyBudget(u, a.ref, Number(b.daily_usd))
      if (typeof b.running === 'boolean') await net.setRunning(u, a.ref, b.running)
      return c.json(adJson(store.campaign(a.id)!))
    }),
  )
  app.delete(
    '/api/v1/ads/:ref',
    api(async (c, u) => {
      await net.deleteAd(u, apiAd(u, param(c, 'ref')).ref)
      return c.json({ ok: true })
    }),
  )
  app.post(
    '/api/v1/deposits',
    api(async (c, u) => {
      const b = await body(c)
      return c.json(depositJson(await net.fund(u, { amountUsd: Number(b.amount_usd), ...(typeof b.coin === 'string' ? { coin: b.coin } : {}) })), 201)
    }),
  )
  app.get(
    '/api/v1/deposits/:id',
    api(async (c, u) => {
      const d = store.deposit(param(c, 'id'))
      if (!d || d.sub !== u.sub) throw new UserError('no such deposit', undefined, 404)
      return c.json(depositJson((await net.followDeposit(d.id))!))
    }),
  )
  app.get('/api/v1/sites', api((c, u) => c.json({ sites: store.sites(u.sub).map(siteJson) })))
  app.post(
    '/api/v1/sites',
    api(async (c, u) => c.json(siteJson(await net.addSite(u, String((await body(c)).site ?? ''))), 201)),
  )
  app.get('/api/v1/sites/:site', api(async (c, u) => c.json(siteJson(await net.refreshSite(apiSite(u, param(c, 'site'))).catch(() => apiSite(u, param(c, 'site')))))))
  app.patch(
    '/api/v1/sites/:site',
    api(async (c, u) => {
      const s = apiSite(u, param(c, 'site'))
      const b = await body(c)
      return c.json(siteJson(await net.setWallet(u, s.slotId, String(b.wallet ?? ''), typeof b.coin === 'string' ? b.coin : undefined)))
    }),
  )
  app.post('/api/v1/sites/:site/check', api(async (c, u) => c.json(siteJson(await net.verifySite(u, apiSite(u, param(c, 'site')).slotId)))))
  app.post(
    '/api/v1/sites/:site/withdraw',
    api(async (c, u) => {
      const r = await net.withdraw(u, apiSite(u, param(c, 'site')).slotId)
      return c.json({ amount_usd: r.amountCents / 100, status: r.status })
    }),
  )
  app.delete(
    '/api/v1/sites/:site',
    api(async (c, u) => {
      await net.removeSite(u, apiSite(u, param(c, 'site')).slotId)
      return c.json({ ok: true })
    }),
  )

  app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'not found' }, 404) : page(c, messagePage(ctxOf(c), { title: 'Not found', message: 'That page does not exist.' }), 404)))
  app.onError((error, c) => {
    console.error(error instanceof Error ? error.message : error)
    return c.req.path.startsWith('/api/') ? c.json({ error: 'Something went wrong.' }, 500) : page(c, messagePage(ctxOf(c), { title: 'Something went wrong', message: 'Try again in a moment.' }), 500)
  })
  return { app, net }
}

export function serve(options: { port?: number; hostname?: string } = {}) {
  const env = process.env
  const key = env.ADNETWORK_KEY ?? ''
  const store = new Store(env.ADNETWORK_DB ?? `${env.HOME}/.local/share/ad-network/ad-network.db`, new Sealer(key))
  for (const name of ['ADNETWORK_COINPAY_CLIENT_ID', 'ADNETWORK_ADVERTISER_TOKEN', 'ADNETWORK_PUBLISHER_TOKEN']) {
    if (!env[name]) throw new Error(`${name} must be set`)
  }
  const { app, net } = createApp({
    store,
    ...(env.ADNETWORK_ORIGIN ? { origin: env.ADNETWORK_ORIGIN } : {}),
    config: {
      key,
      coinpayBase: env.COINPAY_BASE ?? 'https://coinpayportal.com',
      clientId: env.ADNETWORK_COINPAY_CLIENT_ID!,
      ...(env.ADNETWORK_COINPAY_CLIENT_SECRET ? { clientSecret: env.ADNETWORK_COINPAY_CLIENT_SECRET } : {}),
      crawlproofBase: env.CRAWLPROOF_URL ?? 'https://crawlproof.com',
      advertiserToken: env.ADNETWORK_ADVERTISER_TOKEN!,
      publisherToken: env.ADNETWORK_PUBLISHER_TOKEN!,
    },
  })
  const trustProxy = (env.ADNETWORK_TRUST_PROXY ?? '1') === '1'
  startRingRefresh()
  net.startSweep()
  return Bun.serve({
    port: options.port ?? Number(env.PORT ?? 8800),
    hostname: options.hostname ?? env.HOST ?? '127.0.0.1',
    idleTimeout: 180,
    fetch(request, srv) {
      const peer = srv.requestIP(request)?.address ?? ''
      const forwarded = trustProxy && (peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1') ? request.headers.get('x-real-ip') : null
      return app.fetch(request, { ip: forwarded || peer })
    },
  })
}

if (import.meta.main) {
  const server = serve()
  console.log(`ad.network listening on http://${server.hostname}:${server.port}`)
}
