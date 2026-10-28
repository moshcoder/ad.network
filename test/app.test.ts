import { describe, expect, test } from 'bun:test'
import { Sealer, Store } from '../src/db.ts'
import { createApp } from '../src/server.ts'
import { cleanHost, cleanUrl, privateAddress } from '../src/service.ts'
import { onKey, initialState, pick, rows } from '../src/tui.ts'
import { flag, main } from '../src/cli.ts'
import { AdNetworkClient } from '../src/client.ts'
import { createMcpServer } from '../src/mcp.ts'
import { verifySignature } from '@profullstack/webhooks'
import type { Config } from '../src/service.ts'

const KEY = 'test-key-0123456789abcdef'

/** CoinPay (sign-in, wallets) and crawlproof (campaigns, deposits, slots), faked. */
function fakes() {
  const s = {
    sub: 'u-alice',
    campaigns: new Map<string, any>(),
    deposits: new Map<string, any>(),
    depositBodies: [] as any[],
    checkoutHost: 'cp.test',
    slots: new Map<string, any>(),
    withdrawn: [] as string[],
    calls: [] as string[],
    tokenOf: [] as string[],
    grants: new Map<string, number>(),
    grantsDown: false,
    /** What customer webhook receivers got. */
    hooks: [] as { url: string; headers: Headers; raw: string; body: any }[],
  }
  let n = 0
  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url))
    const method = init.method ?? 'GET'
    const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status })
    const raw = typeof init.body === 'string' ? init.body : ''
    const body: any = raw.startsWith('{') ? JSON.parse(raw) : raw ? Object.fromEntries(new URLSearchParams(raw)) : {}
    const path = u.pathname
    const auth = new Headers(init.headers).get('authorization') ?? ''
    if (u.host.startsWith('hooks.')) {
      s.hooks.push({ url: String(url), headers: new Headers(init.headers), raw, body })
      return new Response('ok', { status: 200 })
    }
    if (u.host === 'cp.test') {
      if (path === '/api/oauth/token') return json(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'openid profile email wallet:read' })
      if (path === '/api/oauth/userinfo') return json(200, { sub: s.sub, name: s.sub === 'u-alice' ? 'Alice Smith' : 'Bob', email: `${s.sub}@example.com` })
      if (path === '/api/wallets') return json(200, { success: true, wallets: [{ cryptocurrency: 'USDC_POL', wallet_address: '0xAliceWallet000000000000000000000000000001' }] })
      return json(404, {})
    }
    s.calls.push(`${method} ${path}`)
    s.tokenOf.push(`${path} ${auth}`)
    if (path === '/api/ads/v1/campaigns' && method === 'POST') {
      const norm = (u: string) => u.split('?')[0]
      const existing = [...s.campaigns.values()].find((c) => norm(c.destination_url) === norm(body.url))
      if (existing) return json(200, { ...existing, existing: true })
      const id = `c${++n}`
      const c = { id, ref_slug: `crawlproof-ad-${n}`, name: 'Example', status: body.status, destination_url: body.url.split('?')[0], daily_budget_cents: body.daily_budget_cents, bid_credits: 4, created_at: '2026-10-19', creatives: 6, stats: { impressions: 0, clicks: 0, spent_cents: 0, spend_today_cents: 0, free_impressions: 0, free_clicks: 0 } }
      s.campaigns.set(id, c)
      return json(201, c)
    }
    let m = /^\/api\/ads\/v1\/campaigns\/([^/]+)$/.exec(path)
    if (m) {
      const c = s.campaigns.get(m[1]!)
      if (!c) return json(404, { error: 'no' })
      if (method === 'PATCH') Object.assign(c, body.status ? { status: body.status } : {}, body.daily_budget_cents ? { daily_budget_cents: body.daily_budget_cents } : {})
      return json(200, c)
    }
    if (path === '/api/ads/v1/deposits' && method === 'POST') {
      s.depositBodies.push(body)
      if (body.checkout === 'session') {
        const id = `cs_test${String(++n).padStart(20, '0')}`
        const d = { checkout_session_id: id, payment_id: id, url: `https://${s.checkoutHost}/checkout/${id}`, checkout_url: `https://${s.checkoutHost}/checkout/${id}`, amount_usd: body.amount_usd, credits: body.amount_usd * 20, methods: ['USDC_POL', 'BTC', 'PAYPAL'], expires_at: '2026-10-21T15:00:00Z', status: 'open' }
        s.deposits.set(id, { ...d, status: 'pending' })
        return json(201, d)
      }
      const d = { payment_id: `pay${++n}`, amount_usd: body.amount_usd, credits: body.amount_usd * 20, currency: body.currency, address: 'So1Deposit', amount_crypto: String(body.amount_usd), expires_at: null, status: 'pending' }
      s.deposits.set(d.payment_id, d)
      return json(201, d)
    }
    m = /^\/api\/ads\/v1\/deposits\/([^/]+)$/.exec(path)
    if (m) return json(200, s.deposits.get(m[1]!))
    if (path === '/api/ads/v1/slots' && method === 'POST') {
      const id = `00000000-0000-4000-8000-00000000000${++n}`.slice(-36)
      const slot = { id, status: 'active', site: body.site, embed: `<aside data-cp-ad data-slot="${id}" data-format="banner_300x250"></aside>\n<script src="https://crawlproof.com/ad.js" async></script>`, payout_address: null, payout_currency: null, earned_cents: 0, available_cents: 0, min_payout_cents: 500 }
      s.slots.set(id, slot)
      return json(201, slot)
    }
    m = /^\/api\/ads\/v1\/slots\/([^/]+)(\/payout)?$/.exec(path)
    if (m) {
      const slot = s.slots.get(m[1]!)
      if (m[2]) {
        if (slot.available_cents < 500) return json(400, { error: 'Minimum withdrawal is 5.00.' })
        s.withdrawn.push(slot.payout_address)
        const amount = slot.available_cents
        slot.available_cents = 0
        return json(200, { amount_cents: amount, status: 'confirmed' })
      }
      if (method === 'PATCH') Object.assign(slot, body)
      return json(200, slot)
    }
    if (path === '/api/ads/v1/grants' && method === 'POST') {
      if (s.grantsDown) return json(503, { error: 'down' })
      const applied = !s.grants.has(body.reference)
      if (applied) s.grants.set(body.reference, Math.floor(Math.round(body.amount_usd * 100) / 5))
      const credits = s.grants.get(body.reference)!
      const total = [...s.grants.values()].reduce((a, b) => a + b, 0)
      return json(applied ? 201 : 200, { reference: body.reference, applied, credits, amount_usd: (credits * 5) / 100, ad_bonus_credits: total, spend_only: true })
    }
    return json(404, { error: `no ${method} ${path}` })
  }) as typeof fetch
  return { s, fetchImpl }
}

function setup(extra: Partial<Config> = {}) {
  const f = fakes()
  const pages = new Map<string, string>()
  const store = new Store(':memory:', new Sealer(KEY))
  const { app, net, rewards } = createApp({
    store,
    secureCookies: false,
    origin: 'https://ad.network.pit.world',
    config: { key: KEY, coinpayBase: 'https://cp.test', clientId: 'cp_client', crawlproofBase: 'https://crawlproof.test', advertiserToken: 'crp_ADS', publisherToken: 'crp_PUBS', houseSubs: ['u-house'], ...extra, fetch: f.fetchImpl, fetchPage: async (url) => pages.get(new URL(url).hostname) ?? '' },
  })
  let cookie = ''
  const req = async (path: string, init: RequestInit & { form?: Record<string, string> } = {}) => {
    const headers = new Headers(init.headers)
    if (cookie) headers.set('cookie', cookie)
    let body = init.body
    if (init.form) {
      body = new URLSearchParams(init.form).toString()
      headers.set('content-type', 'application/x-www-form-urlencoded')
    }
    const res = await app.fetch(new Request(`http://localhost${path}`, { ...init, headers, body, redirect: 'manual' }), { ip: '1.2.3.4' })
    const set = res.headers.get('set-cookie')
    if (set) cookie = set.split(';')[0]!
    return res
  }
  const signIn = async (sub = 'u-alice', next = '') => {
    cookie = ''
    f.s.sub = sub
    const start = await req(`/auth/start${next ? `?next=${next}` : ''}`)
    const loc = new URL(start.headers.get('location')!)
    return req(`/auth/callback?code=c1&state=${encodeURIComponent(loc.searchParams.get('state')!)}`)
  }
  const csrf = async (path: string) => /name="csrf" value="([0-9a-f]+)"/.exec(await (await req(path)).text())?.[1] ?? ''
  const age = (sub: string, days: number) => store.db.query('UPDATE users SET created_at = ? WHERE sub = ?').run(Date.now() - days * 86_400_000, sub)
  return { f, store, net, rewards, req, signIn, csrf, pages, age }
}

describe('ad.network', () => {
  test('home, help and installer are public; the rest asks you to sign in', async () => {
    const t = setup()
    const home = await t.req('/')
    expect(home.status).toBe(200)
    const html = await home.text()
    expect(html).toContain('Ads, the simple way.')
    expect(html).toContain('href="/advertise"')
    expect(html).toContain('ring-bar')
    expect(html).toContain('<a class="ring-start" href="https://pit.world/start">Start building here…</a>')
    expect((await t.req('/help')).status).toBe(200)
    const sh = await t.req('/install.sh')
    expect(sh.headers.get('content-type')).toContain('shellscript')
    expect(await sh.text()).toContain('bun add -g @profullstack/adnetwork')
    for (const p of ['/llms.txt', '/robots.txt']) expect((await t.req(p)).headers.get('content-type')).toBe('text/plain; charset=utf-8')
    // /advertise pitches the offer to a signed-out visitor; account pages still redirect.
    expect(await (await t.req('/advertise')).text()).toContain('/auth/start?next=/advertise')
    const gated = await t.req('/me')
    expect(gated.status).toBe(302)
    expect((await t.req('/api/v1/me')).status).toBe(401)
  })

  test('sign in with CoinPay asks only for identity and wallets, and comes back where you were going', async () => {
    const t = setup()
    const start = await t.req('/auth/start?next=/publish')
    const loc = new URL(start.headers.get('location')!)
    expect(loc.searchParams.get('scope')).toBe('openid profile email wallet:read')
    expect(loc.searchParams.get('redirect_uri')).toBe('https://ad.network.pit.world/auth/callback')
    const cb = await t.req(`/auth/callback?code=c1&state=${encodeURIComponent(loc.searchParams.get('state')!)}`)
    expect(cb.headers.get('location')).toBe('/publish')
    // A state is single-use.
    expect((await t.req(`/auth/callback?code=c1&state=${encodeURIComponent(loc.searchParams.get('state')!)}`)).status).toBe(400)
  })

  test('no CoinPay token is stored: sign-in reads payout wallets once and drops the token; a legacy copy is cleared', async () => {
    const t = setup()
    // A row as the pre-2026-10-28 code left it.
    t.store.upsertUser('u-alice', 'Alice', 'a@example.com')
    t.store.db.query("UPDATE users SET tokens = 'legacy-sealed-blob'").run()
    expect(t.store.legacyTokenCount()).toBe(1)
    await t.signIn()
    const rows = t.store.db.query('SELECT * FROM users').all() as Record<string, unknown>[]
    for (const row of rows) expect(row.tokens).toBeNull()
    const dump = JSON.stringify(rows)
    expect(dump).not.toContain('"at"')
    expect(dump).not.toContain('"rt"')
    expect(t.store.legacyTokenCount()).toBe(0)
    const sub = (rows.find((r) => r.wallet_suggestions !== '[]') ?? rows[0])!.sub as string
    expect(t.store.walletSuggestions(sub)).toEqual([{ coin: 'usdc_pol', address: '0xAliceWallet000000000000000000000000000001' }])
  })

  test('free launch: an ad runs with no balance, and the pages say it is free', async () => {
    const t = setup({ freeAds: true })
    expect(await (await t.req('/')).text()).toContain('Free while we launch')
    await t.signIn()
    expect(await (await t.req('/advertise')).text()).toContain('Your ads run with no balance.')
    const made = await t.req('/advertise', { method: 'POST', form: { csrf: await t.csrf('/advertise'), url: 'example.com/free', daily: '5' } })
    expect(made.status).toBe(302)
    expect(t.f.s.campaigns.get('c1')).toMatchObject({ status: 'active' })
    expect(t.net.balanceCents('u-alice')).toBe(0)
    // The sweep leaves it running.
    await t.net.sweep()
    expect(t.f.s.campaigns.get('c1')).toMatchObject({ status: 'active' })
  })

  test('signed out: /advertise and /publish pitch the offer and link to sign-in', async () => {
    const t = setup({ freeAds: true })
    const a = await t.req('/advertise')
    expect(a.status).toBe(200)
    const html = await a.text()
    expect(html).toContain('Advertise free while we launch')
    expect(html).toContain('/auth/start?next=/advertise')
    expect(await (await t.req('/publish')).text()).toContain('/auth/start?next=/publish')
  })

  test('paid mode: the home page does not offer free ads', async () => {
    const t = setup()
    expect(await (await t.req('/')).text()).not.toContain('Free while we launch')
  })

  test('advertiser: an ad waits for budget, runs once paid, and pauses when spent', async () => {
    const t = setup()
    await t.signIn()
    const made = await t.req('/advertise', { method: 'POST', form: { csrf: await t.csrf('/advertise'), url: 'example.com/launch', daily: '$5' } })
    expect(made.status).toBe(302)
    const ref = made.headers.get('location')!.split('/')[2]!.split('?')[0]!
    expect(ref).toBe('crawlproof-ad-1')
    const c = t.f.s.campaigns.get('c1')
    expect(c).toMatchObject({ destination_url: 'https://example.com/launch', daily_budget_cents: 500, status: 'draft' })
    expect(t.f.s.tokenOf[0]).toBe('/api/ads/v1/campaigns Bearer crp_ADS')
    expect(await (await t.req(`/ads/${ref}?made=1`)).text()).toContain('Add budget and it starts.')

    // The form has no coin picker: CoinPay's page offers every coin and PayPal.
    const advertiseHtml = await (await t.req('/advertise')).text()
    expect(advertiseHtml).not.toContain('name="coin"')
    expect(advertiseHtml).toContain('any coin (USDC, USDT, BTC, ETH, SOL and more) or PayPal')

    // Add $25: straight to CoinPay's hosted checkout.
    const funded = await t.req('/advertise/fund', { method: 'POST', form: { csrf: await t.csrf('/advertise'), amount: '25' } })
    expect(funded.status).toBe(303)
    const checkoutUrl = funded.headers.get('location')!
    expect(checkoutUrl).toMatch(/^https:\/\/cp\.test\/checkout\/cs_/)
    const depositId = checkoutUrl.split('/').pop()!
    expect(t.f.s.depositBodies.at(-1)).toEqual({
      amount_usd: 25,
      checkout: 'session',
      customer_email: 'u-alice@example.com',
      account_id: 'u-alice',
      property: 'ad.network.pit.world',
      success_url: 'https://ad.network.pit.world/deposits/{CHECKOUT_SESSION_ID}',
      cancel_url: 'https://ad.network.pit.world/advertise',
      reference: 'ad.network:u-alice',
    })
    expect(t.store.deposit(depositId)).toMatchObject({ sub: 'u-alice', amountCents: 2500, status: 'pending', checkoutUrl })
    const page = await (await t.req(`/deposits/${depositId}`)).text()
    expect(page).toContain(`href="${checkoutUrl}"`)
    expect(page).not.toContain('<svg class="qr"')
    expect(t.net.balanceCents('u-alice')).toBe(0)

    // It lands: the ad starts.
    t.f.s.deposits.get(depositId).status = 'complete'
    expect(await (await t.req(`/deposits/${depositId}.json`)).json()).toEqual({ id: depositId, status: 'complete' })
    expect(t.net.balanceCents('u-alice')).toBe(2500)
    expect(c.status).toBe('active')

    // It spends everything: the sweep pauses it, and resuming waits for budget.
    c.stats = { impressions: 900, clicks: 125, spent_cents: 2500, spend_today_cents: 500, free_impressions: 100, free_clicks: 5 }
    await t.net.sync('u-alice')
    expect(c.status).toBe('paused')
    const row = t.store.campaign(ref)!
    expect(row).toMatchObject({ impressions: 1000, clicks: 130, spentCents: 2500, wanted: 'active' })
    expect(await (await t.req('/advertise')).text()).toContain('paused: no budget')

    // Pause by hand, then delete: the spend stays on the books.
    await t.req(`/ads/${ref}/pause`, { method: 'POST', form: { csrf: await t.csrf(`/ads/${ref}`) } })
    expect(t.store.campaign(ref)!.wanted).toBe('paused')
    await t.req(`/ads/${ref}/delete`, { method: 'POST', form: { csrf: await t.csrf(`/ads/${ref}`) } })
    expect(t.store.campaign(ref)).toBeNull()
    expect(t.net.balanceCents('u-alice')).toBe(0)
  })

  test("an ad for a page someone else already advertises is refused, and ads are private", async () => {
    const t = setup()
    await t.signIn('u-alice')
    await t.req('/advertise', { method: 'POST', form: { csrf: await t.csrf('/advertise'), url: 'https://example.com/', daily: '5' } })
    await t.signIn('u-bob')
    const res = await t.req('/advertise', { method: 'POST', form: { csrf: await t.csrf('/advertise'), url: 'https://example.com/?ref=bob', daily: '5' } })
    expect(res.status).toBe(409)
    expect(await res.text()).toContain('Someone already runs an ad for that page')
    expect((await t.req('/ads/crawlproof-ad-1')).status).toBe(404)
    // Out-of-range budgets never reach crawlproof.
    const calls = t.f.s.calls.length
    expect((await t.req('/advertise', { method: 'POST', form: { csrf: await t.csrf('/advertise'), url: 'https://bob.example.org/', daily: '0.5' } })).status).toBe(400)
    expect(t.f.s.calls.length).toBe(calls)
  })

  test('a campaign crawlproof made but whose answer never reached us is adopted, not doubled', async () => {
    const t = setup()
    await t.signIn()
    // crawlproof has it (the create went through) but ad.network never recorded it.
    t.f.s.campaigns.set('orphan', { id: 'orphan', ref_slug: 'crawlproof-ad-77', name: 'Lost', status: 'draft', destination_url: 'https://lost.example.net/', daily_budget_cents: 500, bid_credits: 4, created_at: '2026-10-19', creatives: 6, stats: { impressions: 0, clicks: 0, spent_cents: 0, spend_today_cents: 0, free_impressions: 0, free_clicks: 0 } })
    const res = await t.req('/advertise', { method: 'POST', form: { csrf: await t.csrf('/advertise'), url: 'lost.example.net', daily: '5' } })
    expect(res.headers.get('location')).toBe('/ads/crawlproof-ad-77?made=1')
    expect(t.store.campaigns('u-alice').map((c) => c.ref)).toEqual(['crawlproof-ad-77'])
    expect(t.f.s.campaigns.size).toBe(1)
  })

  test('publisher: a tag with your own code, live once seen, paid to your wallet', async () => {
    const t = setup()
    await t.signIn()
    const added = await t.req('/publish', { method: 'POST', form: { csrf: await t.csrf('/publish'), site: 'https://www.MyBlog.com/post/1' } })
    expect(added.headers.get('location')).toBe('/sites/myblog.com')
    expect(t.f.s.tokenOf.at(-1)).toBe('/api/ads/v1/slots Bearer crp_PUBS')
    const html = await (await t.req('/sites/myblog.com')).text()
    const code = t.net.claimCode('u-alice', 'myblog.com')
    expect(html).toContain(`data-ad-network=&quot;${code}&quot;`)
    expect(html).toContain('0xAliceWallet') // prefilled from CoinPay

    const site = t.store.site('myblog.com')!
    const slot = t.f.s.slots.get(site.slotId)
    const csrf = await t.csrf('/sites/myblog.com')
    // Not seen yet: withdrawing is refused.
    await t.req('/sites/myblog.com/wallet', { method: 'POST', form: { csrf, address: '0xAliceWallet000000000000000000000000000001', coin: 'usdc_pol' } })
    expect(slot).toMatchObject({ payout_address: '0xAliceWallet000000000000000000000000000001', payout_currency: 'usdc_pol' })
    slot.available_cents = 740
    slot.earned_cents = 740
    expect(await (await t.req('/sites/myblog.com/withdraw', { method: 'POST', form: { csrf } })).text()).toContain('Withdrawals start once')
    expect(await (await t.req('/sites/myblog.com/check', { method: 'POST', form: { csrf } })).text()).toContain('did not find your tag')

    // The tag goes up; the sweep notices on its own.
    t.pages.set('myblog.com', `<html><body>${t.net.embedFor(site)}</body></html>`)
    await t.net.sync('u-alice')
    expect(t.store.site('myblog.com')!.verifiedAt).toBeTruthy()
    const paid = await (await t.req('/sites/myblog.com/withdraw', { method: 'POST', form: { csrf } })).text()
    expect(paid).toContain('Sent 7.40 USD to your wallet.')
    expect(t.f.s.withdrawn).toEqual(['0xAliceWallet000000000000000000000000000001'])
    expect(t.store.withdrawals('u-alice')[0]).toMatchObject({ amountCents: 740, status: 'confirmed' })
  })

  test('a site goes to whoever proves it', async () => {
    const t = setup()
    await t.signIn('u-alice')
    await t.req('/publish', { method: 'POST', form: { csrf: await t.csrf('/publish'), site: 'contested.org' } })
    await t.signIn('u-bob')
    const refused = await t.req('/publish', { method: 'POST', form: { csrf: await t.csrf('/publish'), site: 'contested.org' } })
    expect(refused.status).toBe(409)
    const bobCode = t.net.claimCode('u-bob', 'contested.org')
    expect(await refused.text()).toContain(bobCode)
    // Bob shows his code on the page: it is his, and Alice's claim is gone.
    t.pages.set('contested.org', `<meta name="ad.network" content="${bobCode}">`)
    expect((await t.req('/publish', { method: 'POST', form: { csrf: await t.csrf('/publish'), site: 'contested.org' } })).status).toBe(302)
    expect(t.store.site('contested.org')!.sub).toBe('u-bob')
    expect(t.store.sites('u-alice')).toEqual([])
    // Once proven, nobody else can take it.
    await t.req('/sites/contested.org/check', { method: 'POST', form: { csrf: await t.csrf('/sites/contested.org') } })
    await t.signIn('u-alice')
    t.pages.set('contested.org', `<meta name="ad.network" content="${t.net.claimCode('u-alice', 'contested.org')}">`)
    expect((await t.req('/publish', { method: 'POST', form: { csrf: await t.csrf('/publish'), site: 'contested.org' } })).status).toBe(409)
  })

  test('a deposit never sends anyone off CoinPay, and old address deposits still render', async () => {
    const t = setup()
    await t.signIn()
    t.f.s.checkoutHost = 'evil.example'
    const r = await t.req('/advertise/fund', { method: 'POST', form: { csrf: await t.csrf('/advertise'), amount: '25' } })
    expect(r.status).toBe(502)
    expect(t.store.pendingDeposits('u-alice')).toEqual([])

    t.store.addDeposit({ id: 'pay-old', sub: 'u-alice', amountCents: 1000, coin: 'usdc_sol', address: 'So1Old', amountCrypto: '10', status: 'pending', expiresAt: null })
    t.f.s.deposits.set('pay-old', { payment_id: 'pay-old', status: 'pending' })
    const page = await (await t.req('/deposits/pay-old')).text()
    expect(page).toContain('So1Old')
    expect(page).toContain('<svg class="qr"')
  })

  test('the API, the CLI and the TUI all drive the same account', async () => {
    const t = setup()
    await t.signIn()
    const key = /(an_[A-Za-z0-9_-]+)/.exec(await (await t.req('/me/key', { method: 'POST', form: { csrf: await t.csrf('/me') } })).text())![1]!
    const viaApp = (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url))
      return t.req(u.pathname + u.search, { ...init, headers: new Headers(init?.headers) })
    }) as typeof fetch
    const client = new AdNetworkClient('https://ad.network.pit.world', key, viaApp)
    const lines: string[] = []
    const out = { log: (s: string) => lines.push(s), error: (s: string) => lines.push(`ERR ${s}`) }
    expect(await main(['run', 'https://agents.example.net/', '--daily', '7'], out, client)).toBe(0)
    expect(lines.at(-1)).toContain('Add budget to start it')
    expect(await main(['fund', '10', '--json'], out, client)).toBe(0)
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ amount_usd: 10, coin: 'checkout', checkout_url: expect.stringMatching(/^https:\/\/cp\.test\/checkout\/cs_/) })
    expect(await main(['site', 'agentblog.dev'], out, client)).toBe(0)
    expect(lines.at(-1)).toContain('data-ad-network=')
    expect(await main(['nope'], out, client)).toBe(2)
    const me = await client.me()
    expect(me.ads[0]).toMatchObject({ url: 'https://agents.example.net/', daily_usd: 7, running: false })
    expect(me.sites[0]).toMatchObject({ site: 'agentblog.dev', live: false })
    expect((await t.req('/api/v1/me', { headers: { authorization: 'Bearer an_wrong' } })).status).toBe(401)

    const s = initialState()
    s.me = me
    expect(rows(s).map((r) => r.kind)).toEqual(['ads', 'ad', 'sites', 'site'])
    pick(s, 0)
    expect(rows(s).map((r) => r.kind)).toEqual(['ads', 'sites', 'site'])
    expect(onKey(s, { name: 'down', key: 'down' })).toBeNull()
    expect(onKey(s, { name: 'down', key: 'down' })).toBeNull()
    expect(onKey(s, { name: 'w', key: 'w', char: 'w' })).toBe('withdraw')
    expect(onKey(s, { name: 'q', key: 'q', char: 'q' })).toBe('quit')
    expect(flag(['run', 'x', '--daily=9'], 'daily')).toBe('9')
  })

  test('house accounts run every property: no cap on sites', async () => {
    const t = setup()
    const tokens = { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }
    const alice = t.store.upsertUser('u-alice', 'Alice', 'a@x.test')
    const house = t.store.upsertUser('u-house', 'House', 'h@x.test')
    for (let i = 0; i < 25; i++) {
      await t.net.addSite(alice, `a${i}.example.org`)
      await t.net.addSite(house, `h${i}.example.org`)
    }
    await expect(t.net.addSite(alice, 'a25.example.org')).rejects.toThrow('25 sites')
    expect((await t.net.addSite(house, 'h25.example.org')).host).toBe('h25.example.org')
  })

  test('input cleaning keeps the server off private networks', () => {
    expect(cleanUrl('example.com/a#b')).toBe('https://example.com/a')
    expect(() => cleanUrl('http://localhost:3000')).toThrow()
    expect(() => cleanUrl('http://10.0.0.1/')).toThrow()
    expect(cleanHost('https://WWW.Example.org/x')).toBe('example.org')
    expect(() => cleanHost('printer.local')).toThrow()
    expect(['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1'].every(privateAddress)).toBe(true)
    expect(['8.8.8.8', '23.95.228.174', '2606:4700::1111'].some(privateAddress)).toBe(false)
  })
})

describe('credit codes and invites', () => {
  test('a code adds spend-only ad credit through crawlproof, once', async () => {
    const t = setup({ freeAds: false })
    await t.signIn('u-alice')
    const { code, id } = await t.rewards.credits.mint({ grant: { unit: 'usd_cents', amount: 1000 }, prefix: 'AD' })
    const me = await t.req('/me')
    expect(await me.text()).toContain('Have a code?')
    const r = await t.req('/me/redeem', { method: 'POST', form: { csrf: await t.csrf('/me'), code: code.toLowerCase() } })
    expect(await r.text()).toContain('10.00 USD of ad credit added')
    expect(t.net.balanceCents('u-alice')).toBe(1000)
    expect(t.f.s.grants.get(`ad.network:u-alice:code:${id}`)).toBe(200)
    expect(t.store.deposit(`credit:code:${id}`)).toMatchObject({ coin: 'credit', status: 'complete', amountCents: 1000 })
    const again = await t.req('/me/redeem', { method: 'POST', form: { csrf: await t.csrf('/me'), code } })
    expect(again.status).toBe(400)
    expect(await again.text()).toContain('You already redeemed that code.')
    expect(t.net.balanceCents('u-alice')).toBe(1000)
    expect(t.f.s.grants.size).toBe(1)
  })

  test('a grant crawlproof did not take is finished on the next try, never doubled', async () => {
    const t = setup({ freeAds: false })
    await t.signIn('u-alice')
    const { code, id } = await t.rewards.credits.mint({ grant: { unit: 'usd_cents', amount: 500 } })
    t.f.s.grantsDown = true
    const r = await t.req('/me/redeem', { method: 'POST', form: { csrf: await t.csrf('/me'), code } })
    expect(r.status).toBe(502)
    expect(t.net.balanceCents('u-alice')).toBe(0)
    t.f.s.grantsDown = false
    await t.req('/me/redeem', { method: 'POST', form: { csrf: await t.csrf('/me'), code } })
    expect(t.net.balanceCents('u-alice')).toBe(500)
    expect(t.f.s.grants.get(`ad.network:u-alice:code:${id}`)).toBe(100)
  })

  test('invites: one per account; concurrent accepts, one wins and the other stays unused', async () => {
    const t = setup({ freeAds: false })
    await t.signIn('u-alice')
    await t.signIn('u-bob')
    t.age('u-alice', 3)
    t.age('u-bob', 3)
    const alice = t.store.user('u-alice')!
    const bob = t.store.user('u-bob')!
    const ia = await t.rewards.createInvite(alice)
    const ib = await t.rewards.createInvite(bob)
    await t.signIn('u-carol')
    const carol = t.store.user('u-carol')!
    const [ra, rb] = await Promise.all([t.rewards.acceptInvite(carol, ia.code), t.rewards.acceptInvite(carol, ib.code)])
    const won = [ra, rb].filter((r) => r.ok)
    const lost = [ra, rb].filter((r) => !r.ok) as { ok: false; reason: string }[]
    expect(won).toHaveLength(1)
    expect(lost[0]!.reason).toBe('already_invited')
    expect(t.net.balanceCents('u-carol')).toBe(500)
    const winner = ra.ok ? 'u-alice' : 'u-bob'
    const loser = ra.ok ? 'u-bob' : 'u-alice'
    expect(t.net.balanceCents(winner)).toBe(500)
    expect(t.net.balanceCents(loser)).toBe(0)
    expect((await t.rewards.affiliates.invites(loser))[0]!.usedBy).toBeNull()
  })

  test('invites arrive through /i/<code> and are accepted at CoinPay sign-in', async () => {
    const t = setup({ freeAds: false })
    await t.signIn('u-alice')
    t.age('u-alice', 3)
    const html = await (await t.req('/invites', { method: 'POST', form: { csrf: await t.csrf('/invites'), note: 'for dan' } })).text()
    const link = /https:\/\/ad\.network\.pit\.world\/i\/(INV-[A-Z0-9-]+)/.exec(html)![1]!
    t.f.s.sub = 'u-dan'
    const landing = await t.req(`/i/${link}`)
    expect(landing.status).toBe(200)
    expect(await landing.text()).toContain("You're invited")
    // the landing set the an_invite cookie; sign in with it in the jar
    const start = await t.req('/auth/start?next=/invites')
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!
    const cb = await t.req(`/auth/callback?code=c1&state=${encodeURIComponent(state)}`)
    expect(cb.headers.get('location')).toBe('/invites?invite=paid')
    expect(t.net.balanceCents('u-dan')).toBe(500)
    expect(t.net.balanceCents('u-alice')).toBe(500)
    expect(await (await t.req('/invites')).text()).toContain('the ad credit is on your balance')
  })

  test('invite rules: new senders wait a day, old accounts cannot accept, same mailbox gets nothing', async () => {
    const t = setup({ freeAds: false })
    await t.signIn('u-alice')
    const alice = t.store.user('u-alice')!
    await expect(t.rewards.createInvite(alice)).rejects.toThrow('hours old')
    t.age('u-alice', 3)
    const inv = await t.rewards.createInvite(t.store.user('u-alice')!)
    await t.signIn('u-old')
    t.age('u-old', 30)
    expect(await t.rewards.acceptInvite(t.store.user('u-old')!, inv.code)).toEqual({ ok: false, reason: 'too_old' })
    expect((await t.rewards.affiliates.invites('u-alice'))[0]!.usedBy).toBeNull()
    // the same mailbox as the inviter, spelled with a +tag
    await t.signIn('u-alias')
    t.store.db.query("UPDATE users SET email = 'u-alice+x@example.com' WHERE sub = 'u-alias'").run()
    const r = await t.rewards.acceptInvite(t.store.user('u-alias')!, inv.code)
    expect(r).toEqual({ ok: true, paid: false, reason: 'same_mailbox', bonusCents: 0 })
    expect(t.net.balanceCents('u-alias')).toBe(0)
  })

  test('the API, CLI and MCP surfaces redeem and invite', async () => {
    const t = setup({ freeAds: false })
    await t.signIn('u-alice')
    t.age('u-alice', 3)
    const key = /<code>(an_[A-Za-z0-9_-]+)<\/code>/.exec(await (await t.req('/me/key', { method: 'POST', form: { csrf: await t.csrf('/me') } })).text())![1]!
    const auth = { authorization: `Bearer ${key}`, 'content-type': 'application/json' }
    const { code } = await t.rewards.credits.mint({ grant: { unit: 'usd_cents', amount: 250 } })
    const r = await t.req('/api/v1/credits/redeem', { method: 'POST', headers: auth, body: JSON.stringify({ code }) })
    expect(await r.json()).toMatchObject({ ok: true, credit_usd: 2.5, balance_usd: 2.5, spend_only: true })
    const inv = await t.req('/api/v1/invites', { method: 'POST', headers: auth, body: JSON.stringify({ note: 'x' }) })
    expect(inv.status).toBe(201)
    expect((await inv.json()).link).toMatch(/^https:\/\/ad\.network\.pit\.world\/i\/INV-/)
    const list = await (await t.req('/api/v1/invites', { headers: auth })).json()
    expect(list.quota).toEqual({ total: 3, used: 1, left: 2 })
  })
})

describe('customer webhooks', () => {
  // Webhook URLs resolve to a public address in tests (the real guard does DNS).
  const guard = { webhookGuard: { lookup: async () => ['93.184.216.34'] } }

  test('the API is behind the key and scoped to its account', async () => {
    const t = setup(guard)
    t.store.upsertUser('u-alice', 'Alice', 'a@example.com')
    t.store.upsertUser('u-bob', 'Bob', 'b@example.com')
    t.store.setApiKey('u-alice', 'an_alice')
    t.store.setApiKey('u-bob', 'an_bob')
    const call = (key: string, method: string, path: string, body?: unknown) =>
      t.req(path, { method, headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    expect((await t.req('/api/v1/webhooks')).status).toBe(401)
    expect((await t.req('/api/v1/webhooks', { method: 'POST' })).status).toBe(401)
    const created = await call('an_alice', 'POST', '/api/v1/webhooks', { url: 'https://hooks.example.com/an', events: ['ad.*', 'deposit.completed'] })
    expect(created.status).toBe(201)
    const { endpoint, secret } = (await created.json()) as any
    expect(secret).toStartWith('whsec_')
    const list = (await (await call('an_alice', 'GET', '/api/v1/webhooks')).json()) as any
    expect(list.endpoints.map((e: any) => e.id)).toEqual([endpoint.id])
    expect(list.event_types).toContain('budget.exhausted')
    expect(((await (await call('an_bob', 'GET', '/api/v1/webhooks')).json()) as any).endpoints).toEqual([])
    expect((await call('an_bob', 'GET', `/api/v1/webhooks/${endpoint.id}`)).status).toBe(404)
    expect((await call('an_bob', 'DELETE', `/api/v1/webhooks/${endpoint.id}`)).status).toBe(404)
    expect((await call('an_alice', 'POST', '/api/v1/webhooks', { url: 'https://hooks.example.com/x', events: ['nope.*'] })).status).toBe(400)
    expect((await call('an_alice', 'POST', '/api/v1/webhooks', { url: 'http://127.0.0.1/x' })).status).toBe(400)
    const tested = (await (await call('an_alice', 'POST', `/api/v1/webhooks/${endpoint.id}/test`)).json()) as any
    expect(tested).toMatchObject({ ok: true, status: 200 })
    expect(t.f.s.hooks.at(-1)!.body).toMatchObject({ type: 'webhook.test' })
  })

  test('an advertiser and a publisher hear about their own ads, money and sites, signed', async () => {
    const t = setup(guard)
    await t.signIn('u-alice')
    // Add a webhook from the account page: the secret is shown once.
    const added = await (await t.req('/me/webhooks/add', { method: 'POST', form: { csrf: await t.csrf('/me'), url: 'https://hooks.example.com/alice', events: '' } })).text()
    const secret = /(whsec_[A-Za-z0-9+/=]+)/.exec(added)![1]!
    expect(added).toContain('https://hooks.example.com/alice')
    const id = (await t.net.hooks.listEndpoints('u-alice'))[0]!.id
    const tested = await (await t.req('/me/webhooks/test', { method: 'POST', form: { csrf: await t.csrf('/me'), id } })).text()
    expect(tested).toContain('Test delivered (HTTP 200)')
    t.f.s.hooks.length = 0

    // Advertiser: an ad, a deposit that lands, then the budget runs out.
    const made = await t.req('/advertise', { method: 'POST', form: { csrf: await t.csrf('/advertise'), url: 'example.com/launch', daily: '5' } })
    const ref = made.headers.get('location')!.split('/')[2]!.split('?')[0]!
    const funded = await t.req('/advertise/fund', { method: 'POST', form: { csrf: await t.csrf('/advertise'), amount: '25' } })
    const depositId = funded.headers.get('location')!.split('/').pop()!
    t.f.s.deposits.get(depositId).status = 'complete'
    await t.req(`/deposits/${depositId}.json`)
    t.f.s.campaigns.get('c1').stats = { impressions: 900, clicks: 125, spent_cents: 2500, spend_today_cents: 500, free_impressions: 100, free_clicks: 5 }
    await t.net.sync('u-alice')

    // Publisher: a site, proven, paid out.
    await t.req('/publish', { method: 'POST', form: { csrf: await t.csrf('/publish'), site: 'myblog.com' } })
    const site = t.store.site('myblog.com')!
    const csrf = await t.csrf('/sites/myblog.com')
    await t.req('/sites/myblog.com/wallet', { method: 'POST', form: { csrf, address: '0xAliceWallet000000000000000000000000000001', coin: 'usdc_pol' } })
    t.pages.set('myblog.com', t.net.embedFor(site))
    await t.req('/sites/myblog.com/check', { method: 'POST', form: { csrf } })
    const slot = t.f.s.slots.get(site.slotId)
    slot.available_cents = 740
    await t.req('/sites/myblog.com/withdraw', { method: 'POST', form: { csrf } })

    // Bob takes an unproven claim of Alice's: Alice hears she lost it; Bob hears nothing of Alice's.
    await t.req('/publish', { method: 'POST', form: { csrf: await t.csrf('/publish'), site: 'contested.org' } })
    await t.signIn('u-bob')
    t.pages.set('contested.org', `<meta name="ad.network" content="${t.net.claimCode('u-bob', 'contested.org')}">`)
    await t.req('/publish', { method: 'POST', form: { csrf: await t.csrf('/publish'), site: 'contested.org' } })

    await t.net.hooks.drain()
    const got = t.f.s.hooks.filter((h) => h.url === 'https://hooks.example.com/alice')
    expect(got.length).toBe(t.f.s.hooks.length)
    const types = got.map((h) => h.body.type)
    expect(types).toEqual(expect.arrayContaining(['ad.created', 'deposit.completed', 'ad.started', 'ad.paused', 'budget.exhausted', 'site.added', 'site.verified', 'payout.requested', 'site.lost']))
    const by = (type: string) => got.find((h) => h.body.type === type)!.body
    expect(by('ad.created')).toMatchObject({ specversion: '1.0', source: 'https://ad.network.pit.world', subject: `ad:${ref}`, data: { ref, url: 'https://example.com/launch', daily_usd: 5, status: 'draft' } })
    expect(by('deposit.completed').data).toMatchObject({ id: depositId, amount_usd: 25, status: 'complete', balance_usd: 25 })
    expect(by('ad.started').data).toMatchObject({ ref, reason: 'funded' })
    expect(by('ad.paused').data).toMatchObject({ ref, reason: 'no_budget' })
    expect(by('budget.exhausted').data).toMatchObject({ balance_usd: 0, ads_paused: 1 })
    expect(by('site.verified')).toMatchObject({ subject: 'site:myblog.com', data: { site: 'myblog.com', live: true } })
    expect(by('payout.requested').data).toMatchObject({ site: 'myblog.com', amount_usd: 7.4, status: 'confirmed' })
    expect(by('site.lost').data).toEqual({ site: 'contested.org', reason: 'proven_by_another_account' })

    // Every delivery verifies against the secret the page showed.
    for (const h of got) expect(verifySignature({ headers: h.headers, body: h.raw, secret }).ok).toBe(true)
    expect(verifySignature({ headers: got[0]!.headers, body: got[0]!.raw, secret: 'whsec_' + Buffer.from('wrong-secret-0123456789').toString('base64') }).ok).toBe(false)

    // Rotate and remove from the page.
    await t.signIn('u-alice')
    expect(await (await t.req('/me')).text()).toContain('hooks.example.com/alice')
    const rotated = await (await t.req('/me/webhooks/rotate', { method: 'POST', form: { csrf: await t.csrf('/me'), id } })).text()
    expect(/(whsec_[A-Za-z0-9+/=]+)/.exec(rotated)![1]).not.toBe(secret)
    await t.req('/me/webhooks/delete', { method: 'POST', form: { csrf: await t.csrf('/me'), id } })
    expect(await t.net.hooks.listEndpoints('u-alice')).toEqual([])
  })

  test('the CLI and MCP manage webhooks', async () => {
    const t = setup(guard)
    await t.signIn()
    const key = /(an_[A-Za-z0-9_-]+)/.exec(await (await t.req('/me/key', { method: 'POST', form: { csrf: await t.csrf('/me') } })).text())![1]!
    const viaApp = (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url))
      return t.req(u.pathname + u.search, { ...init, headers: new Headers(init?.headers) })
    }) as typeof fetch
    const client = new AdNetworkClient('https://ad.network.pit.world', key, viaApp)
    const lines: string[] = []
    const out = { log: (s: string) => lines.push(s), error: (s: string) => lines.push(`ERR ${s}`) }
    expect(await main(['webhook', 'add', 'https://hooks.example.com/cli', 'site.*'], out, client)).toBe(0)
    expect(lines.at(-1)).toContain('signing secret (shown once): whsec_')
    const id = lines.at(-1)!.split(' ')[0]!
    expect(await main(['webhooks'], out, client)).toBe(0)
    expect(lines.at(-1)).toContain(`${id}  https://hooks.example.com/cli  site.*`)
    expect(await main(['webhook', 'test', id], out, client)).toBe(0)
    expect(lines.at(-1)).toBe('delivered (HTTP 200)')
    expect(await main(['webhook', 'log'], out, client)).toBe(0)
    expect(lines.at(-1)).toContain('webhook.test')
    expect(await main(['webhook', 'rm', id], out, client)).toBe(0)
    expect((await client.webhooks()).endpoints).toEqual([])

    const server: any = createMcpServer(client)
    const tools = Object.keys(server._registeredTools)
    expect(tools).toEqual(expect.arrayContaining(['list_webhooks', 'create_webhook', 'test_webhook', 'rotate_webhook_secret', 'delete_webhook', 'webhook_deliveries']))
    const r = await server._registeredTools.create_webhook.handler({ url: 'https://hooks.example.com/mcp', events: ['ad.*'] }, {})
    expect(JSON.parse(r.content[0].text).secret).toStartWith('whsec_')
  })
})
