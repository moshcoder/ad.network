/**
 * The ad.network API from anywhere: the CLI, the TUI and the MCP server use this.
 * ADNETWORK_KEY (an_…, from ad.network.pit.world/me) signs every call;
 * ADNETWORK_URL points it at another instance.
 */
export type ApiAd = { ref: string; name: string; url: string; daily_usd: number; running: boolean; wanted: string; status: string; headline: string; body: string; views: number; clicks: number; spent_usd: number; page: string }
export type ApiDeposit = { id: string; amount_usd: number; coin: string; address: string; amount_crypto: string; checkout_url: string | null; status: string; expires_at: string | null; page: string }
export type ApiSite = { site: string; tag: string; live: boolean; wallet: string | null; coin: string; earned_usd: number; withdrawable_usd: number; page: string }
export type ApiWebhook = { id: string; url: string; events: string[]; description: string; enabled: boolean; failures: number; disabled_reason: string | null; created_at: string }
export type ApiDelivery = { id: string; endpoint_id: string; event_type: string; status: string; attempts: number; last_status: number | null; last_error: string | null; created_at: string }
export type ApiMe = { name: string; email: string; balance_usd: number; ads: ApiAd[]; deposits: ApiDeposit[]; sites: ApiSite[] }

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export class AdNetworkClient {
  readonly base: string
  constructor(
    base = process.env.ADNETWORK_URL ?? 'https://ad.network.pit.world',
    private readonly key = process.env.ADNETWORK_KEY,
    private readonly doFetch: typeof fetch = fetch,
  ) {
    this.base = base.replace(/\/+$/, '')
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.key) throw new ApiError(`Set ADNETWORK_KEY to your key from ${this.base}/me`, 401)
    const response = await this.doFetch(this.base + path, {
      method,
      headers: { accept: 'application/json', authorization: `Bearer ${this.key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      // Making an ad reads the page and writes the copy: allow it a couple of minutes.
      signal: AbortSignal.timeout(180_000),
    })
    const data = (await response.json().catch(() => ({}))) as { error?: string }
    if (!response.ok) throw new ApiError(data.error ?? `ad.network answered ${response.status}`, response.status)
    return data as T
  }

  me(): Promise<ApiMe> {
    return this.call('GET', '/api/v1/me')
  }
  run(url: string, dailyUsd = 5, name?: string): Promise<ApiAd & { balance_usd: number }> {
    return this.call('POST', '/api/v1/ads', { url, daily_usd: dailyUsd, ...(name ? { name } : {}) })
  }
  ad(ref: string): Promise<ApiAd> {
    return this.call('GET', `/api/v1/ads/${encodeURIComponent(ref)}`)
  }
  updateAd(ref: string, patch: { running?: boolean; daily_usd?: number }): Promise<ApiAd> {
    return this.call('PATCH', `/api/v1/ads/${encodeURIComponent(ref)}`, patch)
  }
  deleteAd(ref: string): Promise<{ ok: boolean }> {
    return this.call('DELETE', `/api/v1/ads/${encodeURIComponent(ref)}`)
  }
  /** Opens a CoinPay checkout for that much ad budget: pay at checkout_url in any coin or PayPal. */
  fund(amountUsd: number): Promise<ApiDeposit> {
    return this.call('POST', '/api/v1/deposits', { amount_usd: amountUsd })
  }
  deposit(id: string): Promise<ApiDeposit> {
    return this.call('GET', `/api/v1/deposits/${encodeURIComponent(id)}`)
  }
  addSite(site: string): Promise<ApiSite> {
    return this.call('POST', '/api/v1/sites', { site })
  }
  site(site: string): Promise<ApiSite> {
    return this.call('GET', `/api/v1/sites/${encodeURIComponent(site)}`)
  }
  checkSite(site: string): Promise<ApiSite> {
    return this.call('POST', `/api/v1/sites/${encodeURIComponent(site)}/check`)
  }
  setWallet(site: string, wallet: string, coin?: string): Promise<ApiSite> {
    return this.call('PATCH', `/api/v1/sites/${encodeURIComponent(site)}`, { wallet, ...(coin ? { coin } : {}) })
  }
  withdraw(site: string): Promise<{ amount_usd: number; status: string }> {
    return this.call('POST', `/api/v1/sites/${encodeURIComponent(site)}/withdraw`)
  }
  /** Redeem a credit code: ad credit on your balance (spend-only, not withdrawable). */
  redeem(code: string): Promise<{ ok: boolean; credit_usd: number; balance_usd: number }> {
    return this.call('POST', '/api/v1/credits/redeem', { code })
  }
  invites(): Promise<{ quota: { total: number; used: number; left: number }; bonus_usd: number; can_invite: boolean; why_not?: string; invites: { id: string; note: string; created_at: string; expires_at: string | null; used: boolean }[] }> {
    return this.call('GET', '/api/v1/invites')
  }
  createInvite(note?: string): Promise<{ code: string; link: string; expires_at: string | null; left: number }> {
    return this.call('POST', '/api/v1/invites', note ? { note } : {})
  }
  acceptInvite(code: string): Promise<{ ok: boolean; bonus_usd: number; no_bonus?: string }> {
    return this.call('POST', '/api/v1/invites/accept', { code })
  }
  /** Your webhook endpoints, and the events ad.network sends. */
  webhooks(): Promise<{ endpoints: ApiWebhook[]; event_types: string[] }> {
    return this.call('GET', '/api/v1/webhooks')
  }
  addWebhook(url: string, events?: string[], description = ''): Promise<{ endpoint: ApiWebhook; secret: string }> {
    return this.call('POST', '/api/v1/webhooks', { url, ...(events?.length ? { events } : {}), description })
  }
  removeWebhook(id: string): Promise<{ deleted: true }> {
    return this.call('DELETE', `/api/v1/webhooks/${encodeURIComponent(id)}`)
  }
  testWebhook(id: string): Promise<{ ok: boolean; status: number | null; error: string | null }> {
    return this.call('POST', `/api/v1/webhooks/${encodeURIComponent(id)}/test`)
  }
  rotateWebhook(id: string): Promise<{ secret: string }> {
    return this.call('POST', `/api/v1/webhooks/${encodeURIComponent(id)}/rotate`)
  }
  webhookLog(id?: string): Promise<{ deliveries: ApiDelivery[] }> {
    return this.call('GET', id ? `/api/v1/webhooks/${encodeURIComponent(id)}/deliveries` : '/api/v1/webhooks/deliveries')
  }
  removeSite(site: string): Promise<{ ok: boolean }> {
    return this.call('DELETE', `/api/v1/sites/${encodeURIComponent(site)}`)
  }
}
