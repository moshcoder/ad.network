import { describe, expect, test } from 'bun:test'
import { Sealer, Store } from '../src/db.ts'
import { createApp } from '../src/server.ts'
import { cleanHost, cleanUrl, privateAddress } from '../src/service.ts'
import { onKey, initialState, pick, rows } from '../src/tui.ts'
import { flag, main } from '../src/cli.ts'
import { AdNetworkClient } from '../src/client.ts'

const KEY = 'test-key-0123456789abcdef'

/** CoinPay (sign-in, wallets) and crawlproof (campaigns, deposits, slots), faked. */
function fakes() {
  const s = {
    sub: 'u-alice',
    campaigns: new Map<string, any>(),
    deposits: new Map<string, any>(),
    slots: new Map<string, any>(),
    withdrawn: [] as string[],
    calls: [] as string[],
    tokenOf: [] as string[],
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
    if (u.host === 'cp.test') {
      if (path === '/api/oauth/token') return json(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'openid profile email wallet:read' })
      if (path === '/api/oauth/userinfo') return json(200, { sub: s.sub, name: s.sub === 'u-alice' ? 'Alice Smith' : 'Bob', email: `${s.sub}@example.com` })
      if (path === '/api/wallets') return json(200, { success: true, wallets: [{ cryptocurrency: 'USDC_POL', wallet_address: '0xAliceWallet000000000000000000000000000001' }] })
      return json(404, {})
    }
    s.calls.push(`${method} ${path}`)
    s.tokenOf.push(`${path} ${auth}`)
    if (path === '/api/ads/v1/campaigns' && method === 'POST') {
      const existing = [...s.campaigns.values()].find((c) => c.destination_url === body.url)
      if (existing) return json(200, { ...existing, existing: true })
      const id = `c${++n}`
      const c = { id, ref_slug: `crawlproof-ad-${n}`, name: 'Example', status: body.status, destination_url: body.url, daily_budget_cents: body.daily_budget_cents, bid_credits: 4, created_at: '2026-10-19', creatives: [{ format: 'banner_300x250', headline: 'Try Example', body: 'It is good.' }], stats: { impressions: 0, clicks: 0, spent_cents: 0, spend_today_cents: 0, free_impressions: 0, free_clicks: 0 } }
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
    return json(404, { error: `no ${method} ${path}` })
  }) as typeof fetch
  return { s, fetchImpl }
}

function setup() {
  const f = fakes()
  const pages = new Map<string, string>()
  const store = new Store(':memory:', new Sealer(KEY))
  const { app, net } = createApp({
    store,
    secureCookies: false,
    origin: 'https://ad.network.pit.world',
    config: { key: KEY, coinpayBase: 'https://cp.test', clientId: 'cp_client', crawlproofBase: 'https://crawlproof.test', advertiserToken: 'crp_ADS', publisherToken: 'crp_PUBS', fetch: f.fetchImpl, fetchPage: async (url) => pages.get(new URL(url).hostname) ?? '' },
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
  return { f, store, net, req, signIn, csrf, pages }
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
    expect((await t.req('/help')).status).toBe(200)
    const sh = await t.req('/install.sh')
    expect(sh.headers.get('content-type')).toContain('shellscript')
    expect(await sh.text()).toContain('bun add -g @profullstack/adnetwork')
    const gated = await t.req('/advertise')
    expect(gated.status).toBe(302)
    expect(gated.headers.get('location')).toBe('/auth/start?next=/advertise')
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

    // Add $25 in USDC on Solana.
    const funded = await t.req('/advertise/fund', { method: 'POST', form: { csrf: await t.csrf('/advertise'), amount: '25', coin: 'usdc_sol' } })
    const depositId = funded.headers.get('location')!.split('/').pop()!
    const page = await (await t.req(`/deposits/${depositId}`)).text()
    expect(page).toContain('So1Deposit')
    expect(page).toContain('<svg class="qr"')
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
    const res = await t.req('/advertise', { method: 'POST', form: { csrf: await t.csrf('/advertise'), url: 'https://example.com/', daily: '5' } })
    expect(res.status).toBe(409)
    expect(await res.text()).toContain('Someone already runs an ad for that exact page')
    expect((await t.req('/ads/crawlproof-ad-1')).status).toBe(404)
    // Out-of-range budgets never reach crawlproof.
    const calls = t.f.s.calls.length
    expect((await t.req('/advertise', { method: 'POST', form: { csrf: await t.csrf('/advertise'), url: 'https://bob.example.org/', daily: '0.5' } })).status).toBe(400)
    expect(t.f.s.calls.length).toBe(calls)
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
    expect(await main(['fund', '10', 'usdc_base', '--json'], out, client)).toBe(0)
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ amount_usd: 10, coin: 'usdc_base', address: 'So1Deposit' })
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
