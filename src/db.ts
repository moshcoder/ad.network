/**
 * ad.network's state: one SQLite file.
 *
 * A person is their CoinPay account (`sub`). crawlproof holds the campaigns,
 * slots and money; we keep which of them are whose, the deposits each
 * advertiser made, and the last numbers we read, so a page never waits on
 * crawlproof to say who owns what. CoinPay tokens are sealed with ADNETWORK_KEY.
 */
import { Database } from 'bun:sqlite'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

export type User = { sub: string; name: string; email: string; apiKeyHash: string | null; createdAt: number }

export type Campaign = {
  id: string
  ref: string
  sub: string
  url: string
  name: string
  dailyBudgetCents: number
  /** What the advertiser chose: running or paused. */
  wanted: 'active' | 'paused'
  /** What crawlproof has now. We pause a campaign whose owner's budget ran out. */
  status: string
  headline: string
  body: string
  impressions: number
  clicks: number
  spentCents: number
  syncedAt: number
  createdAt: number
}

export type DepositRow = {
  id: string
  sub: string
  amountCents: number
  coin: string
  address: string
  amountCrypto: string
  status: string
  expiresAt: string | null
  createdAt: number
}

export type Site = {
  slotId: string
  sub: string
  host: string
  embed: string
  payoutAddress: string
  payoutCoin: string
  verifiedAt: number | null
  earnedCents: number
  availableCents: number
  syncedAt: number
  createdAt: number
}

export type Withdrawal = { id: number; slotId: string; sub: string; amountCents: number; status: string; createdAt: number }

export class Sealer {
  private readonly key: Buffer
  constructor(secret: string) {
    if (!secret || secret.length < 16) throw new Error('ADNETWORK_KEY must be set (32 random bytes, hex)')
    this.key = createHash('sha256').update(secret).digest()
  }
  seal(plain: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64')).join('.')
  }
  open(sealed: string): string {
    const [iv, tag, body] = sealed.split('.').map((s) => Buffer.from(s, 'base64'))
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv!)
    decipher.setAuthTag(tag!)
    return Buffer.concat([decipher.update(body!), decipher.final()]).toString('utf8')
  }
}

export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex')

export type Tokens = { accessToken: string; refreshToken: string | null; expiresAt: number }

export class Store {
  readonly db: Database
  constructor(path: string, private readonly sealer: Sealer) {
    this.db = new Database(path, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        sub TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL DEFAULT '',
        tokens TEXT,
        api_key_hash TEXT UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, sub TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_states (state TEXT PRIMARY KEY, verifier TEXT NOT NULL, redirect_uri TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS campaigns (
        id TEXT PRIMARY KEY,
        ref TEXT NOT NULL UNIQUE,
        sub TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
        url TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        daily_budget_cents INTEGER NOT NULL,
        wanted TEXT NOT NULL DEFAULT 'active',
        status TEXT NOT NULL DEFAULT 'draft',
        headline TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        impressions INTEGER NOT NULL DEFAULT 0,
        clicks INTEGER NOT NULL DEFAULT 0,
        spent_cents INTEGER NOT NULL DEFAULT 0,
        synced_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS campaigns_sub ON campaigns(sub, created_at DESC);
      CREATE TABLE IF NOT EXISTS deposits (
        id TEXT PRIMARY KEY,
        sub TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
        amount_cents INTEGER NOT NULL,
        coin TEXT NOT NULL,
        address TEXT NOT NULL DEFAULT '',
        amount_crypto TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        expires_at TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS deposits_sub ON deposits(sub, created_at DESC);
      CREATE TABLE IF NOT EXISTS sites (
        slot_id TEXT PRIMARY KEY,
        sub TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
        host TEXT NOT NULL UNIQUE,
        embed TEXT NOT NULL,
        payout_address TEXT NOT NULL DEFAULT '',
        payout_coin TEXT NOT NULL DEFAULT 'usdc_pol',
        verified_at INTEGER,
        earned_cents INTEGER NOT NULL DEFAULT 0,
        available_cents INTEGER NOT NULL DEFAULT 0,
        synced_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sites_sub ON sites(sub);
      CREATE TABLE IF NOT EXISTS withdrawals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slot_id TEXT NOT NULL,
        sub TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `)
  }

  // ---- people ------------------------------------------------------------

  private toUser(row: any): User | null {
    return row ? { sub: row.sub, name: row.name, email: row.email, apiKeyHash: row.api_key_hash, createdAt: row.created_at } : null
  }

  upsertUser(sub: string, name: string, email: string, tokens: Tokens, now = Date.now()): User {
    this.db
      .query(
        `INSERT INTO users (sub, name, email, tokens, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(sub) DO UPDATE SET name = excluded.name, email = excluded.email, tokens = excluded.tokens`,
      )
      .run(sub, name, email, this.sealer.seal(JSON.stringify(tokens)), now)
    return this.user(sub)!
  }

  user(sub: string): User | null {
    return this.toUser(this.db.query('SELECT * FROM users WHERE sub = ?').get(sub))
  }

  byApiKey(key: string): User | null {
    return this.toUser(this.db.query('SELECT * FROM users WHERE api_key_hash = ?').get(hashKey(key)))
  }

  setApiKey(sub: string, key: string): void {
    this.db.query('UPDATE users SET api_key_hash = ? WHERE sub = ?').run(hashKey(key), sub)
  }

  tokens(sub: string): Tokens | null {
    const row: any = this.db.query('SELECT tokens FROM users WHERE sub = ?').get(sub)
    return row?.tokens ? JSON.parse(this.sealer.open(row.tokens)) : null
  }

  saveTokens(sub: string, tokens: Tokens): void {
    this.db.query('UPDATE users SET tokens = ? WHERE sub = ?').run(this.sealer.seal(JSON.stringify(tokens)), sub)
  }

  /** Forget a person. Their campaigns and slots stay on crawlproof; the caller stops them first. */
  deleteUser(sub: string): void {
    this.db.query('DELETE FROM users WHERE sub = ?').run(sub)
  }

  newSession(sub: string, now = Date.now()): string {
    const id = randomBytes(24).toString('base64url')
    this.db.query('INSERT INTO sessions (id, sub, created_at) VALUES (?, ?, ?)').run(hashKey(id), sub, now)
    return id
  }

  session(id: string | undefined, now = Date.now(), maxAgeMs = 30 * 86400_000): User | null {
    if (!id) return null
    const row: any = this.db.query('SELECT sub, created_at FROM sessions WHERE id = ?').get(hashKey(id))
    if (!row || now - row.created_at > maxAgeMs) return null
    return this.user(row.sub)
  }

  endSession(id: string | undefined): void {
    if (id) this.db.query('DELETE FROM sessions WHERE id = ?').run(hashKey(id))
  }

  saveState(state: string, verifier: string, redirectUri: string, now = Date.now()): void {
    this.db.query('DELETE FROM oauth_states WHERE created_at < ?').run(now - 15 * 60_000)
    this.db.query('INSERT INTO oauth_states (state, verifier, redirect_uri, created_at) VALUES (?, ?, ?, ?)').run(state, this.sealer.seal(verifier), redirectUri, now)
  }

  takeState(state: string, now = Date.now()): { verifier: string; redirectUri: string } | null {
    const row: any = this.db.query('DELETE FROM oauth_states WHERE state = ? RETURNING verifier, redirect_uri, created_at').get(state)
    if (!row || now - row.created_at > 15 * 60_000) return null
    return { verifier: this.sealer.open(row.verifier), redirectUri: row.redirect_uri }
  }

  // ---- advertisers ---------------------------------------------------------

  private toCampaign(r: any): Campaign | null {
    if (!r) return null
    return {
      id: r.id,
      ref: r.ref,
      sub: r.sub,
      url: r.url,
      name: r.name,
      dailyBudgetCents: r.daily_budget_cents,
      wanted: r.wanted,
      status: r.status,
      headline: r.headline,
      body: r.body,
      impressions: r.impressions,
      clicks: r.clicks,
      spentCents: r.spent_cents,
      syncedAt: r.synced_at,
      createdAt: r.created_at,
    }
  }

  addCampaign(c: Pick<Campaign, 'id' | 'ref' | 'sub' | 'url' | 'name' | 'dailyBudgetCents' | 'status' | 'headline' | 'body'>, now = Date.now()): Campaign {
    this.db
      .query('INSERT INTO campaigns (id, ref, sub, url, name, daily_budget_cents, status, headline, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(c.id, c.ref, c.sub, c.url, c.name, c.dailyBudgetCents, c.status, c.headline, c.body, now)
    return this.campaign(c.id)!
  }

  campaign(idOrRef: string): Campaign | null {
    return this.toCampaign(this.db.query('SELECT * FROM campaigns WHERE id = ? OR ref = ?').get(idOrRef, idOrRef))
  }

  campaigns(sub: string): Campaign[] {
    return (this.db.query('SELECT * FROM campaigns WHERE sub = ? ORDER BY created_at DESC').all(sub) as any[]).map((r) => this.toCampaign(r)!)
  }

  /** Every advertiser with a campaign, for the budget sweep. */
  advertisers(): string[] {
    return (this.db.query('SELECT DISTINCT sub FROM campaigns').all() as { sub: string }[]).map((r) => r.sub)
  }

  updateCampaign(id: string, patch: Partial<Pick<Campaign, 'wanted' | 'status' | 'dailyBudgetCents' | 'impressions' | 'clicks' | 'spentCents' | 'syncedAt' | 'name'>>): void {
    const cols: Record<string, string> = { wanted: 'wanted', status: 'status', dailyBudgetCents: 'daily_budget_cents', impressions: 'impressions', clicks: 'clicks', spentCents: 'spent_cents', syncedAt: 'synced_at', name: 'name' }
    const keys = Object.keys(patch).filter((k) => k in cols) as (keyof typeof patch)[]
    if (!keys.length) return
    this.db.query(`UPDATE campaigns SET ${keys.map((k) => `${cols[k]} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => patch[k] as any), id)
  }

  /** Forget a campaign; what it spent still counts against the advertiser's balance. */
  removeCampaign(id: string, now = Date.now()): void {
    const c = this.campaign(id)
    if (!c) return
    this.db.transaction(() => {
      if (c.spentCents > 0) {
        this.db
          .query("INSERT INTO deposits (id, sub, amount_cents, coin, status, created_at) VALUES (?, ?, ?, 'spend', 'complete', ?)")
          .run(`spend-${c.ref}`, c.sub, -c.spentCents, now)
      }
      this.db.query('DELETE FROM campaigns WHERE id = ?').run(id)
    })()
  }

  addDeposit(d: Omit<DepositRow, 'createdAt'>, now = Date.now()): DepositRow {
    this.db
      .query('INSERT OR IGNORE INTO deposits (id, sub, amount_cents, coin, address, amount_crypto, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(d.id, d.sub, d.amountCents, d.coin, d.address, d.amountCrypto, d.status, d.expiresAt, now)
    return this.deposit(d.id)!
  }

  deposit(id: string): DepositRow | null {
    const r: any = this.db.query('SELECT * FROM deposits WHERE id = ?').get(id)
    return r ? { id: r.id, sub: r.sub, amountCents: r.amount_cents, coin: r.coin, address: r.address, amountCrypto: r.amount_crypto, status: r.status, expiresAt: r.expires_at, createdAt: r.created_at } : null
  }

  deposits(sub: string): DepositRow[] {
    return (this.db.query("SELECT id FROM deposits WHERE sub = ? AND coin != 'spend' ORDER BY created_at DESC LIMIT 50").all(sub) as { id: string }[]).map((r) => this.deposit(r.id)!)
  }

  pendingDeposits(sub: string): DepositRow[] {
    return (this.db.query("SELECT id FROM deposits WHERE sub = ? AND status = 'pending'").all(sub) as { id: string }[]).map((r) => this.deposit(r.id)!)
  }

  setDepositStatus(id: string, status: string): void {
    this.db.query('UPDATE deposits SET status = ? WHERE id = ?').run(status, id)
  }

  /** Money in (finished deposits) minus what their campaigns have spent, in cents. */
  balanceCents(sub: string): number {
    const paid = (this.db.query("SELECT COALESCE(SUM(amount_cents), 0) AS n FROM deposits WHERE sub = ? AND status = 'complete'").get(sub) as { n: number }).n
    const spent = (this.db.query('SELECT COALESCE(SUM(spent_cents), 0) AS n FROM campaigns WHERE sub = ?').get(sub) as { n: number }).n
    return paid - spent
  }

  // ---- publishers -----------------------------------------------------------

  private toSite(r: any): Site | null {
    if (!r) return null
    return {
      slotId: r.slot_id,
      sub: r.sub,
      host: r.host,
      embed: r.embed,
      payoutAddress: r.payout_address,
      payoutCoin: r.payout_coin,
      verifiedAt: r.verified_at,
      earnedCents: r.earned_cents,
      availableCents: r.available_cents,
      syncedAt: r.synced_at,
      createdAt: r.created_at,
    }
  }

  site(slotIdOrHost: string): Site | null {
    return this.toSite(this.db.query('SELECT * FROM sites WHERE slot_id = ? OR host = ?').get(slotIdOrHost, slotIdOrHost.toLowerCase()))
  }

  sites(sub: string): Site[] {
    return (this.db.query('SELECT * FROM sites WHERE sub = ? ORDER BY created_at DESC').all(sub) as any[]).map((r) => this.toSite(r)!)
  }

  /** Claims a site's slot for `sub`. Taking over someone else's claim resets its wallet and proof. */
  claimSite(s: Pick<Site, 'slotId' | 'sub' | 'host' | 'embed'>, now = Date.now()): Site {
    this.db
      .query(
        `INSERT INTO sites (slot_id, sub, host, embed, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(slot_id) DO UPDATE SET sub = excluded.sub, embed = excluded.embed, payout_address = '', verified_at = NULL, created_at = excluded.created_at`,
      )
      .run(s.slotId, s.sub, s.host, s.embed, now)
    return this.site(s.slotId)!
  }

  updateSite(slotId: string, patch: Partial<Pick<Site, 'payoutAddress' | 'payoutCoin' | 'verifiedAt' | 'earnedCents' | 'availableCents' | 'syncedAt'>>): void {
    const cols: Record<string, string> = { payoutAddress: 'payout_address', payoutCoin: 'payout_coin', verifiedAt: 'verified_at', earnedCents: 'earned_cents', availableCents: 'available_cents', syncedAt: 'synced_at' }
    const keys = Object.keys(patch).filter((k) => k in cols) as (keyof typeof patch)[]
    if (!keys.length) return
    this.db.query(`UPDATE sites SET ${keys.map((k) => `${cols[k]} = ?`).join(', ')} WHERE slot_id = ?`).run(...keys.map((k) => patch[k] as any), slotId)
  }

  removeSite(slotId: string): void {
    this.db.query('DELETE FROM sites WHERE slot_id = ?').run(slotId)
  }

  addWithdrawal(w: Omit<Withdrawal, 'id' | 'createdAt'>, now = Date.now()): void {
    this.db.query('INSERT INTO withdrawals (slot_id, sub, amount_cents, status, created_at) VALUES (?, ?, ?, ?, ?)').run(w.slotId, w.sub, w.amountCents, w.status, now)
  }

  withdrawals(sub: string): Withdrawal[] {
    return (this.db.query('SELECT * FROM withdrawals WHERE sub = ? ORDER BY created_at DESC LIMIT 50').all(sub) as any[]).map((r) => ({ id: r.id, slotId: r.slot_id, sub: r.sub, amountCents: r.amount_cents, status: r.status, createdAt: r.created_at }))
  }
}
