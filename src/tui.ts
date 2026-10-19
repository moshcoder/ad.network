/**
 * `adnetwork` with no arguments: your ads and sites as one folding tree.
 *
 * One click (or Enter) opens a branch in place or picks a row; the row under
 * the pointer lights up. On an ad, p pauses or runs it; on a site, w withdraws.
 * r re-reads everything, q quits.
 */
import { createApp } from '@profullstack/hqtui'
import { AdNetworkClient, type ApiAd, type ApiMe, type ApiSite } from './client.js'

export type Row = { kind: 'ads' | 'sites'; item?: undefined } | { kind: 'ad'; item: ApiAd } | { kind: 'site'; item: ApiSite }
export type TuiState = { me: ApiMe | null; open: { ads: boolean; sites: boolean }; selected: number; hovered: number | null; busy: string | null; note: string | null }

export const initialState = (): TuiState => ({ me: null, open: { ads: true, sites: true }, selected: 0, hovered: null, busy: null, note: null })

const money = (n: number) => `$${n.toFixed(2)}`

/** The rows in draw order: each root, then its children while it is open. */
export function rows(s: TuiState): Row[] {
  const out: Row[] = [{ kind: 'ads' }]
  if (s.open.ads) for (const a of s.me?.ads ?? []) out.push({ kind: 'ad', item: a })
  out.push({ kind: 'sites' })
  if (s.open.sites) for (const x of s.me?.sites ?? []) out.push({ kind: 'site', item: x })
  return out
}

/** Picks a row: a root folds or unfolds in place, anything else is just selected. */
export function pick(s: TuiState, index: number): void {
  const row = rows(s)[index]
  if (!row) return
  s.selected = index
  if (row.kind === 'ads' || row.kind === 'sites') {
    s.open[row.kind] = !s.open[row.kind]
    s.selected = rows(s).findIndex((r) => r.kind === row.kind)
  }
}

/** Pure key handling, testable without a terminal. */
export function onKey(s: TuiState, key: { name: string; key: string; char?: string }): 'quit' | 'refresh' | 'toggle-ad' | 'withdraw' | null {
  const n = rows(s).length
  if (key.key === 'ctrl+c' || key.name === 'escape' || key.char === 'q') return 'quit'
  if (key.name === 'up') s.selected = (s.selected + n - 1) % n
  else if (key.name === 'down') s.selected = (s.selected + 1) % n
  else if (key.name === 'enter' || key.char === ' ') pick(s, s.selected)
  else if (key.char === 'r') return 'refresh'
  else if (key.char === 'p' && rows(s)[s.selected]?.kind === 'ad') return 'toggle-ad'
  else if (key.char === 'w' && rows(s)[s.selected]?.kind === 'site') return 'withdraw'
  return null
}

export async function runTui(client = new AdNetworkClient()): Promise<void> {
  const s = initialState()
  const app = await createApp({ title: 'ad.network', quitKeys: [] })
  let visible: number[] = []
  const act = async (label: string, job: () => Promise<string | void>) => {
    s.busy = label
    s.note = null
    app.invalidate()
    try {
      s.note = (await job()) ?? null
      s.me = await client.me()
    } catch (e) {
      s.note = e instanceof Error ? e.message : String(e)
    } finally {
      s.busy = null
      s.selected = Math.min(s.selected, rows(s).length - 1)
      app.invalidate()
    }
  }
  const refresh = () => act('Reading…', async () => {})
  app.on('key', (event: any) => {
    const action = onKey(s, event)
    const row = rows(s)[s.selected]
    if (action === 'quit') return app.quit()
    if (action === 'refresh') void refresh()
    if (action === 'toggle-ad' && row?.kind === 'ad') void act(row.item.wanted === 'active' ? 'Pausing…' : 'Starting…', async () => void (await client.updateAd(row.item.ref, { running: row.item.wanted !== 'active' })))
    if (action === 'withdraw' && row?.kind === 'site') void act('Withdrawing…', async () => {
      const r = await client.withdraw(row.item.site)
      return `${money(r.amount_usd)} ${r.status === 'requested' ? 'queued' : 'sent'}.`
    })
    app.invalidate()
  })
  app.on('mouse', (event: any) => {
    // A move no row claimed clears the hover.
    if (event?.type === 'move' && s.hovered !== null) {
      s.hovered = null
      app.invalidate()
    }
  })
  app.render(({ ui, theme }: any) => {
    const me = s.me
    ui.row({ size: 1 }, (h: any) => {
      h.text(' ad.network', { fg: theme.accent, bold: true, size: 12 })
      h.text(me ? `balance ${money(me.balance_usd)}` : 'run ads, or earn from your site', { fg: theme.muted })
      h.text(`${client.base.replace(/^https?:\/\//, '')} `, { fg: theme.muted, align: 'right' })
    })
    const all = rows(s)
    const nodes = [
      { label: `${s.open.ads ? '▾' : '▸'} Ads (${me?.ads.length ?? 0})`, color: theme.accent, expanded: s.open.ads, children: (s.open.ads ? me?.ads ?? [] : []).map((a) => ({ label: `${a.name || a.url}`, values: [{ text: a.running ? 'running' : a.wanted === 'active' ? 'no budget' : 'paused', width: 10 }, { text: `${a.clicks} clicks`, width: 12, align: 'right' }, { text: money(a.spent_usd), width: 9, align: 'right' }] })) },
      { label: `${s.open.sites ? '▾' : '▸'} Sites (${me?.sites.length ?? 0})`, color: theme.accent, expanded: s.open.sites, children: (s.open.sites ? me?.sites ?? [] : []).map((x) => ({ label: x.site, values: [{ text: x.live ? 'live' : 'tag not seen', width: 12 }, { text: `earned ${money(x.earned_usd)}`, width: 16, align: 'right' }] })) },
    ]
    visible = []
    ui.panel({ title: s.busy ?? 'Your ads and sites' }, (p: any) => {
      p.tree({
        nodes,
        selected: s.selected,
        ...(s.hovered !== null ? { hovered: s.hovered } : {}),
        followSelection: true,
        guides: true,
        scrollbar: true,
        onRow: (_node: unknown, index: number) => visible.push(index),
        onSelectRow: (r: number) => {
          if (visible[r] !== undefined) pick(s, visible[r]!)
          app.invalidate()
        },
        onHoverRow: (r: number | null) => {
          s.hovered = r === null ? null : (visible[r] ?? null)
          app.invalidate()
        },
        onScroll: (d: number) => {
          s.selected = Math.max(0, Math.min(all.length - 1, s.selected + d))
          app.invalidate()
        },
      })
    })
    const row = all[s.selected]
    ui.panel({ title: row?.kind === 'ad' ? row.item.ref : row?.kind === 'site' ? row.item.site : 'Details', size: 6 }, (p: any) => {
      if (s.note) p.text(s.note, { fg: theme.accent })
      if (row?.kind === 'ad') {
        p.text(`${row.item.headline}`, { bold: true })
        p.text(`${row.item.views} views · ${row.item.clicks} clicks · ${money(row.item.spent_usd)} spent · ${money(row.item.daily_usd)}/day`, { fg: theme.muted })
        p.text(row.item.page, { fg: theme.muted })
      } else if (row?.kind === 'site') {
        p.text(`earned ${money(row.item.earned_usd)} · withdrawable ${money(row.item.withdrawable_usd)}`, { bold: true })
        p.text(row.item.wallet ? `pays ${row.item.coin} ${row.item.wallet}` : 'no wallet yet: adnetwork wallet <site> <address>', { fg: theme.muted })
        p.text(row.item.page, { fg: theme.muted })
      } else if (!me) p.text('Reading your account…', { fg: theme.muted })
      else p.text('New ad: adnetwork run <url> · new site: adnetwork site <example.com>', { fg: theme.muted })
    })
    const keys = [{ key: '↑↓', label: 'move' }, { key: 'Enter', label: 'open' }, { key: 'r', label: 'refresh' }]
    if (row?.kind === 'ad') keys.push({ key: 'p', label: row.item.wanted === 'active' ? 'pause' : 'run' })
    if (row?.kind === 'site') keys.push({ key: 'w', label: 'withdraw' })
    keys.push({ key: 'q', label: 'quit' })
    ui.statusBar({ items: keys, right: [{ label: 'ads by crawlproof' }] })
  })
  void refresh()
  await app.start()
}
