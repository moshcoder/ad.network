/**
 * Credit codes and scarce invites for ad.network.
 *
 * - A credit code (@profullstack/redeem-credits, unit `usd_cents`) is ad credit.
 * - Each person can hand out INVITES_PER_PERSON invites (@profullstack/affiliates);
 *   one accepted invite per account, and both people get INVITE_BONUS_CENTS of ad credit.
 *
 * Ad credit goes through the same two books a deposit does, in this order:
 *   1. crawlproof: POST /api/ads/v1/grants puts it on our shared advertiser
 *      account as ad_bonus_credits. That credit runs ads like a deposit but pays
 *      no publisher, so credit nobody paid for can never leave as crypto.
 *   2. here: a `deposits` row (coin 'credit', status complete, id credit:<source>)
 *      adds it to the person's own balance, which is what decides whose ads run.
 * Both writes are idempotent on the source, so a retry or a repair never pays twice,
 * and the person's balance only moves once crawlproof holds the credit.
 */
import { createRequire } from 'node:module'
import { Affiliates, sqliteStore as affiliateStore } from '@profullstack/affiliates'
import { Credits, sqliteStore as creditStore } from '@profullstack/redeem-credits'
import type { Store, User } from './db.js'
import { UserError, type AdNetwork } from './service.js'

const require_ = createRequire(import.meta.url)

export const CREDIT_UNIT = 'usd_cents'
export const CREDIT_COIN = 'credit'
export const INVITES_PER_PERSON = 3
const DAY_MS = 86_400_000

export type RewardsConfig = {
  /** Ad credit each side of an accepted invite gets, in cents. */
  inviteBonusCents?: number
  /** Paid inviter bonuses per inviter per 30 days. */
  inviteMonthlyCap?: number
  /** An account must be this old to send invites. */
  inviterMinAgeMs?: number
  /** Only accounts younger than this can accept an invite. */
  inviteeMaxAgeMs?: number
  now?: () => number
}

export const REDEEM_MESSAGES: Record<string, string> = {
  invalid: 'That code is not valid.',
  expired: 'That code has expired.',
  used_up: 'That code has been used up.',
  already_redeemed: 'You already redeemed that code.',
  revoked: 'That code was withdrawn.',
}

export const ACCEPT_MESSAGES: Record<string, string> = {
  invalid: 'That invite code is not valid.',
  expired: 'That invite has expired.',
  used: 'That invite was already used.',
  self: 'You cannot use your own invite.',
  revoked: 'That invite was withdrawn.',
  already_invited: 'Your account has already accepted an invite.',
  too_old: 'Invites are for new accounts.',
}

/** One mailbox, however it is spelled: lowercased, +tag dropped, Gmail dots ignored. */
export function mailboxKey(email: string): string {
  const [local0, domain0] = String(email || '').trim().toLowerCase().split('@')
  if (!local0 || !domain0) return String(email || '').trim().toLowerCase()
  const domain = domain0 === 'googlemail.com' ? 'gmail.com' : domain0
  let local = local0.split('+')[0]!
  if (domain === 'gmail.com') local = local.replace(/\./g, '')
  return `${local}@${domain}`
}

export function isThrowawayEmail(email: string): boolean {
  try {
    return !require_('mailchecker').isValid(String(email || ''))
  } catch {
    return false
  }
}

export type AcceptResult = { ok: true; paid: boolean; reason?: string; bonusCents: number } | { ok: false; reason: string }

export class Rewards {
  readonly credits: Credits
  readonly affiliates: Affiliates
  private readonly now: () => number

  constructor(
    readonly store: Store,
    readonly net: AdNetwork,
    readonly config: RewardsConfig = {},
  ) {
    this.now = config.now ?? Date.now
    // Same SQLite file as the rest of ad.network: tables credit_* and aff_*.
    this.credits = new Credits(creditStore(store.db as never), {
      onGrant: async (sub, grant, source) => {
        if (grant.unit !== CREDIT_UNIT) throw new Error(`unsupported credit unit ${grant.unit}`)
        await this.grantAdCredit(sub, grant.amount, source)
      },
    })
    this.affiliates = new Affiliates(affiliateStore(store.db as never), { defaultQuota: INVITES_PER_PERSON })
    store.db.exec(`CREATE TABLE IF NOT EXISTS invite_bonuses (
      invitee TEXT PRIMARY KEY,
      inviter TEXT NOT NULL,
      invite_id TEXT NOT NULL,
      paid INTEGER NOT NULL,
      reason TEXT,
      created_at INTEGER NOT NULL
    )`)
  }

  get inviteBonusCents() {
    return this.config.inviteBonusCents ?? 500
  }

  /**
   * Ad credit for one person, once per source: on crawlproof first (spend-only),
   * then on their balance here. False if this source was already granted.
   */
  async grantAdCredit(sub: string, cents: number, source: string): Promise<boolean> {
    const id = `credit:${source}`
    if (this.store.deposit(id)) return false
    const amount = Math.floor(Number(cents) / 5) * 5 // crawlproof credits are 5c each
    if (!sub || !source || !(amount > 0)) throw new Error('grantAdCredit: bad grant')
    const g = await this.net.ads.grant({ amount_usd: amount / 100, reference: `ad.network:${sub}:${source}` })
    const granted = Math.round(g.amount_usd * 100)
    this.store.addDeposit({ id, sub, amountCents: granted, coin: CREDIT_COIN, address: '', amountCrypto: '', status: 'complete', expiresAt: null })
    // source is code:<id> or invite:<id>:<side>; the kind is all a receiver needs.
    this.net.hook(sub, 'credit.added', { amount_usd: granted / 100, kind: source.split(':')[0], spend_only: true, balance_usd: this.net.balanceCents(sub) / 100 }, `account:${sub}`)
    await this.net.enforce(sub).catch(() => {})
    return true
  }

  /** Redeems a code for ad credit. A grant that did not land last time is finished on retry. */
  async redeem(user: User, code: string): Promise<{ cents: number }> {
    const r = await this.credits.redeem(String(code ?? ''), user.sub)
    if (!('reason' in r)) return { cents: r.grant.amount }
    if (r.reason === 'already_redeemed') await this.repair(user.sub).catch(() => {})
    throw new UserError(REDEEM_MESSAGES[r.reason] ?? 'That code did not work.', 'code')
  }

  /** Replays every code grant in the module's ledger; the ones already here are skipped. */
  async repair(sub: string): Promise<void> {
    for (const h of await this.credits.history(sub, CREDIT_UNIT)) {
      if (h.kind === 'grant' && h.source.startsWith('code:')) await this.grantAdCredit(sub, h.amount, h.source)
    }
  }

  private ageMs(user: User): number {
    return this.now() - user.createdAt
  }

  canInvite(user: User): { ok: true } | { ok: false; error: string } {
    const min = this.config.inviterMinAgeMs ?? DAY_MS
    if (this.ageMs(user) < min) return { ok: false, error: `Invites open once your account is ${Math.round(min / 3_600_000)} hours old.` }
    return { ok: true }
  }

  async createInvite(user: User, note = ''): Promise<{ code: string; expiresAt: number | null; left: number }> {
    const check = this.canInvite(user)
    if ('error' in check) throw new UserError(check.error, undefined, 403)
    try {
      const invite = await this.affiliates.createInvite(user.sub, String(note).slice(0, 80))
      return { code: invite.code, expiresAt: invite.expiresAt, left: (await this.affiliates.quota(user.sub)).left }
    } catch (e) {
      if (e instanceof Error && /no invites left/i.test(e.message)) throw new UserError('You have no invites left.', undefined, 403)
      throw e
    }
  }

  /**
   * Accepts an invite for a new account. The invite is spent only by
   * redeemInvite() (one per account, enforced in the database), and the bonus
   * is decided only after it answers ok. No bonus for a throwaway address, the
   * inviter's own mailbox, a house account, or an account with no email; the
   * inviter's half stops at the monthly cap.
   */
  async acceptInvite(user: User, code: string): Promise<AcceptResult> {
    if (this.ageMs(user) > (this.config.inviteeMaxAgeMs ?? 7 * DAY_MS)) return { ok: false, reason: 'too_old' }
    const r = await this.affiliates.redeemInvite(String(code ?? ''), user.sub)
    if ('reason' in r) return { ok: false, reason: r.reason }

    const inviter = this.store.user(r.inviterId)
    const house = (sub: string) => this.net.config.houseSubs?.includes(sub) ?? false
    let denied: string | null = null
    if (!inviter) denied = 'inviter_gone'
    else if (!user.email) denied = 'no_email'
    else if (house(user.sub) || house(inviter.sub)) denied = 'house'
    else if (isThrowawayEmail(user.email)) denied = 'throwaway_email'
    else if (inviter.email && mailboxKey(inviter.email) === mailboxKey(user.email)) denied = 'same_mailbox'

    const claimed = this.store.db
      .query('INSERT OR IGNORE INTO invite_bonuses (invitee, inviter, invite_id, paid, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(user.sub, r.inviterId, r.inviteId, denied ? 0 : 1, denied, this.now())
    if (denied || claimed.changes === 0) return { ok: true, paid: false, ...(denied ? { reason: denied } : {}), bonusCents: 0 }

    const bonus = this.inviteBonusCents
    await this.grantAdCredit(user.sub, bonus, `invite:${r.inviteId}:invitee`)
    const recent = (this.store.db
      .query("SELECT count(*) AS n FROM deposits WHERE sub = ? AND coin = 'credit' AND id LIKE 'credit:invite:%:inviter' AND created_at > ?")
      .get(r.inviterId, this.now() - 30 * DAY_MS) as { n: number }).n
    if (recent < (this.config.inviteMonthlyCap ?? 5)) await this.grantAdCredit(r.inviterId, bonus, `invite:${r.inviteId}:inviter`)
    else this.store.db.query("UPDATE invite_bonuses SET reason = 'inviter_monthly_cap' WHERE invitee = ?").run(user.sub)
    return { ok: true, paid: true, bonusCents: bonus }
  }

  /** Finishes an invite bonus that did not land (crawlproof was down at accept time). */
  async repairInvite(invitee: string): Promise<void> {
    const row = this.store.db.query('SELECT inviter, invite_id, paid, reason FROM invite_bonuses WHERE invitee = ?').get(invitee) as { inviter: string; invite_id: string; paid: number; reason: string | null } | null
    if (!row?.paid) return
    await this.grantAdCredit(invitee, this.inviteBonusCents, `invite:${row.invite_id}:invitee`)
    if (row.reason !== 'inviter_monthly_cap' && this.store.user(row.inviter)) await this.grantAdCredit(row.inviter, this.inviteBonusCents, `invite:${row.invite_id}:inviter`)
  }

  myBonus(sub: string): { paid: boolean; reason: string | null } | null {
    const row = this.store.db.query('SELECT paid, reason FROM invite_bonuses WHERE invitee = ?').get(sub) as { paid: number; reason: string | null } | null
    return row ? { paid: Boolean(row.paid), reason: row.reason } : null
  }
}
