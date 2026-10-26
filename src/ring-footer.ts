/**
 * The Profullstack webring footer (@profullstack/footer): our links, the copyright
 * and << Profullstack >>. It must be in the server-rendered HTML: rssamplifier's
 * ring verifier reads the page and never runs script, so a client-side footer never
 * counts. (The Moshpit ring bar at the top and the pit.world footer are separate.)
 *
 * Starts from the template bundled with the package, then re-reads the @latest
 * template in the background every 15 minutes, so a page never waits on the CDN and
 * a footer release reaches us without a redeploy. A failed read keeps the last copy.
 */
import { createHash } from 'node:crypto'
import { descriptor, footerHtml, footerHtmlSync, type FooterOptions } from '@profullstack/footer'

/** The ring member URL (the web2 hostname; hops are measured from it). */
export const RING_SITE = 'https://ad.network.pit.world/'

const OPTIONS: FooterOptions = {
  site: RING_SITE,
  name: 'ad.network',
  links: [
    { label: 'Help', href: '/help' },
    { label: 'API, CLI, MCP', href: '/help#agents' },
    { label: 'Source', href: 'https://github.com/moshcoder/ad.network' },
    { label: 'Ads by crawlproof', href: 'https://crawlproof.com' },
    { label: 'Payments by CoinPay', href: 'https://coinpayportal.com' },
  ],
}

let cached = footerHtmlSync(OPTIONS)

/** The footer HTML to print in the layout. */
export const ringFooter = (): string => cached

let hashedFor = ''
let hashes = ''

/**
 * CSP 'sha256-…' sources for the footer's inline scripts (0.4.0+: the newsletter
 * form's wireSubscribe, which posts to pit.world and reports inline). script-src has
 * no 'unsafe-inline' and the footer is cached across requests, so a per-request nonce
 * cannot reach it; a hash of the exact script text can. Recomputed when the cache changes.
 */
export function ringFooterScriptHashes(): string {
  if (hashedFor !== cached) {
    const out: string[] = []
    for (const m of cached.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
      out.push(`'sha256-${createHash('sha256').update(m[1] ?? '', 'utf8').digest('base64')}'`)
    }
    hashes = out.join(' ')
    hashedFor = cached
  }
  return hashes
}

/** /.well-known/openwebring.json */
export const ringDescriptor = () => descriptor({ site: RING_SITE, name: 'ad.network' })

export function startRingFooterRefresh(everyMs = 15 * 60_000): () => void {
  const refresh = () =>
    footerHtml(OPTIONS)
      .then((html) => {
        if (typeof html === 'string' && html.includes('ring/profullstack')) cached = html
      })
      .catch(() => {})
  refresh()
  const timer = setInterval(refresh, everyMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
