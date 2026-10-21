/**
 * The crawlproof ads API, which runs the auction, serves the ads and moves
 * the money. ad.network is a front door to it with two crawlproof accounts:
 *
 *   advertisers  owns every advertiser's campaigns and holds their ad budget
 *   publishers   owns every publisher's slots; each slot pays its own wallet
 *
 * Two accounts, not one: crawlproof books an ad served on its own owner's slot
 * as a free self-deal, so one account on both sides would never pay anyone.
 */
export type Creative = { format: string; headline?: string | null; body?: string | null; cta?: string | null; image_url?: string | null }

export type CampaignSummary = {
  id: string
  ref_slug: string
  name: string
  status: string
  destination_url: string
  daily_budget_cents: number
  bid_credits: number
  created_at: string
  /** crawlproof answers how many creatives it wrote; older answers carried the creatives themselves. */
  creatives?: number | Creative[]
  existing?: boolean
}

export type CampaignStats = {
  impressions: number
  clicks: number
  spent_cents: number
  spend_today_cents: number
  free_impressions: number
  free_clicks: number
}

export type Deposit = {
  payment_id: string
  amount_usd: number
  credits: number
  currency?: string
  address?: string | null
  amount_crypto?: string | null
  expires_at?: string | null
  checkout_url?: string | null
  /** checkout "session" answers: the hosted CoinPay page (any coin or PayPal). */
  checkout_session_id?: string
  url?: string
  methods?: string[]
  status: string
}

/** A deposit as a hosted CoinPay checkout session for one of our people. */
export type DepositSessionRequest = {
  amount_usd: number
  checkout: 'session'
  customer_email?: string
  account_id: string
  property: string
  success_url: string
  cancel_url: string
  reference: string
}

export type Slot = { id: string; status: string; embed?: string; tracker?: string; existing?: boolean; [k: string]: unknown }

export type SlotMoney = {
  id: string
  status: string
  payout_address: string | null
  payout_currency: string | null
  earned_cents: number
  available_cents: number
  min_payout_cents: number
}

export class CrawlproofError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

export class Crawlproof {
  readonly base: string
  constructor(
    base: string,
    private readonly token: string,
    private readonly doFetch: typeof fetch = fetch,
  ) {
    this.base = base.replace(/\/+$/, '')
  }

  private async call<T>(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
    const response = await this.doFetch(this.base + path, {
      method,
      headers: { accept: 'application/json', authorization: `Bearer ${this.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const data = (await response.json().catch(() => ({}))) as { error?: string }
    if (!response.ok) throw new CrawlproofError(data.error ?? `crawlproof answered ${response.status}`, response.status)
    return data as T
  }

  /** Reads the page and writes the ad; can take a minute. */
  createCampaign(input: { url: string; name?: string; daily_budget_cents: number; status: 'active' | 'draft' }): Promise<CampaignSummary> {
    return this.call('POST', '/api/ads/v1/campaigns', input, 150_000)
  }

  campaign(id: string): Promise<CampaignSummary & { stats?: CampaignStats }> {
    return this.call('GET', `/api/ads/v1/campaigns/${encodeURIComponent(id)}`)
  }

  updateCampaign(id: string, patch: { status?: 'active' | 'paused'; daily_budget_cents?: number; name?: string }): Promise<CampaignSummary> {
    return this.call('PATCH', `/api/ads/v1/campaigns/${encodeURIComponent(id)}`, patch)
  }

  deleteCampaign(id: string): Promise<{ ok: boolean }> {
    return this.call('DELETE', `/api/ads/v1/campaigns/${encodeURIComponent(id)}`)
  }

  deposit(input: { amount_usd: number; currency: string; reference?: string } | DepositSessionRequest): Promise<Deposit> {
    return this.call('POST', '/api/ads/v1/deposits', input)
  }

  depositStatus(paymentId: string): Promise<Deposit> {
    return this.call('GET', `/api/ads/v1/deposits/${encodeURIComponent(paymentId)}`)
  }

  createSlot(site: string): Promise<Slot> {
    return this.call('POST', '/api/ads/v1/slots', { site, format: 'banner_300x250', formats: ['banner_300x250', 'text_link'] })
  }

  slot(id: string): Promise<SlotMoney> {
    return this.call('GET', `/api/ads/v1/slots/${encodeURIComponent(id)}`)
  }

  updateSlot(id: string, patch: { payout_address?: string; payout_currency?: string; status?: 'active' | 'paused' }): Promise<SlotMoney> {
    return this.call('PATCH', `/api/ads/v1/slots/${encodeURIComponent(id)}`, patch)
  }

  withdraw(id: string): Promise<{ amount_cents: number; status: string }> {
    return this.call('POST', `/api/ads/v1/slots/${encodeURIComponent(id)}/payout`)
  }
}
