/**
 * adnetwork: ad.network from the terminal. Advertise or publish in one line.
 */
import { AdNetworkClient, type ApiAd, type ApiSite } from './client.js'
import { VERSION } from './version.js'

export const HELP = `adnetwork ${VERSION}: run ads, or earn from your site, in crypto (https://ad.network.pit.world)

  adnetwork                                  interactive (TUI)
  adnetwork me                               balance, ads and sites

 Advertise
  adnetwork run <url> [--daily 5]            a new ad for that page
  adnetwork fund <usd>                       add budget: prints a CoinPay link, pay in any coin or PayPal
  adnetwork deposit <id> [--wait]            a deposit's status; --wait until it lands
  adnetwork ads                              your ads
  adnetwork ad <ref>                         one ad, fresh numbers
  adnetwork pause|resume <ref>
  adnetwork budget <ref> <usd-per-day>
  adnetwork delete <ref>

 Publish
  adnetwork site <example.com>               add a site: prints the tag to paste
  adnetwork sites                            your sites and earnings
  adnetwork check <site>                     look for your tag now
  adnetwork wallet <site> <address> [coin]   where you get paid (usdc_pol, usdc_sol, usdc_base, usdc_eth)
  adnetwork withdraw <site>
  adnetwork remove <site>

  adnetwork redeem <code>                    redeem a credit code for ad credit
  adnetwork invites                          your invites (scarce: 3 each)
  adnetwork invite [note]                    make an invite link
  adnetwork accept <invite-code>             accept an invite on your new account

  adnetwork mcp                              MCP server: claude mcp add adnetwork -- bunx @profullstack/adnetwork mcp
  adnetwork serve [--port N]                 run your own instance

  --json                                     machine-readable output
  ADNETWORK_KEY=an_…                         your key, from https://ad.network.pit.world/me
`

type Out = { log(text: string): void; error(text: string): void }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const money = (n: number) => `$${n.toFixed(2)}`

export const adLine = (a: ApiAd) => `${a.ref.padEnd(20)} ${(a.running ? 'running' : a.wanted === 'active' ? 'no budget' : 'paused').padEnd(10)} ${money(a.daily_usd)}/day  ${String(a.views).padStart(7)} views ${String(a.clicks).padStart(5)} clicks  ${money(a.spent_usd)} spent  ${a.url}`
export const siteLine = (s: ApiSite) => `${s.site.padEnd(28)} ${(s.live ? 'live' : 'tag not seen').padEnd(13)} earned ${money(s.earned_usd)}  withdrawable ${money(s.withdrawable_usd)}  ${s.wallet ? `→ ${s.coin} ${s.wallet}` : 'no wallet'}`

/** --name value or --name=value. */
export function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`)
  if (i >= 0) return argv[i + 1]
  return argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
}

export async function main(argv = process.argv.slice(2), out: Out = console, client = new AdNetworkClient()): Promise<number> {
  const json = argv.includes('--json')
  const wait = argv.includes('--wait')
  const daily = flag(argv, 'daily')
  const port = flag(argv, 'port')
  const args = argv.filter((a, i) => !a.startsWith('--') && !['--daily', '--port'].includes(argv[i - 1] ?? ''))
  const [command, ...rest] = args
  const show = (value: unknown, text: string) => out.log(json ? JSON.stringify(value, null, 2) : text)
  const need = (v: string | undefined, what: string) => {
    if (!v) throw new Error(`missing ${what}\n\n${HELP}`)
    return v
  }
  try {
    switch (command) {
      case undefined: {
        if (!process.stdout.isTTY) return out.log(HELP), 0
        const { runTui } = await import('./tui.js')
        await runTui(client)
        return 0
      }
      case 'help':
        return out.log(HELP), 0
      case 'version':
        return out.log(VERSION), 0
      case 'mcp': {
        const { runMcp } = await import('./mcp.js')
        await runMcp(client)
        return 0
      }
      case 'serve': {
        const { serve } = await import('./server.js')
        const s = serve(port ? { port: Number(port) } : {})
        out.log(`ad.network listening on http://${s.hostname}:${s.port}`)
        return await new Promise<number>(() => {})
      }
      case 'me': {
        const me = await client.me()
        show(me, `${me.email}  balance ${money(me.balance_usd)}\n\nAds\n${me.ads.map(adLine).join('\n') || '  none'}\n\nSites\n${me.sites.map(siteLine).join('\n') || '  none'}`)
        return 0
      }
      case 'run': {
        const a = await client.run(need(rest[0], 'a link'), daily ? Number(daily) : 5)
        show(a, `${a.ref}: ${a.headline || a.name}\n${a.running ? 'Running.' : `Ready. Add budget to start it: adnetwork fund 25`}\n${a.page}`)
        return 0
      }
      case 'fund': {
        const d = await client.fund(Number(need(rest[0], 'an amount in USD')))
        show(d, `Pay ${money(d.amount_usd)} in any coin or PayPal:\n${d.checkout_url ?? d.page}\n\n${d.expires_at ? `Open until ${d.expires_at}. ` : ''}Watch it: adnetwork deposit ${d.id} --wait`)
        return 0
      }
      case 'deposit': {
        let d = await client.deposit(need(rest[0], 'a deposit id'))
        while (wait && d.status === 'pending') {
          await sleep(10_000)
          d = await client.deposit(d.id)
        }
        show(d, `${d.id}: ${d.status === 'complete' ? `${money(d.amount_usd)} added` : d.status}`)
        return d.status === 'complete' || !wait ? 0 : 1
      }
      case 'ads': {
        const me = await client.me()
        show(me.ads, me.ads.map(adLine).join('\n') || 'No ads yet: adnetwork run <url>')
        return 0
      }
      case 'ad': {
        const a = await client.ad(need(rest[0], 'an ad ref'))
        show(a, `${adLine(a)}\n\n${a.headline}\n${a.body}\n${a.page}`)
        return 0
      }
      case 'pause':
      case 'resume': {
        const a = await client.updateAd(need(rest[0], 'an ad ref'), { running: command === 'resume' })
        show(a, adLine(a))
        return 0
      }
      case 'budget': {
        const a = await client.updateAd(need(rest[0], 'an ad ref'), { daily_usd: Number(need(rest[1], 'USD per day')) })
        show(a, adLine(a))
        return 0
      }
      case 'delete': {
        show(await client.deleteAd(need(rest[0], 'an ad ref')), 'Deleted.')
        return 0
      }
      case 'site': {
        const s = await client.addSite(need(rest[0], 'a site'))
        show(s, `Paste this into ${s.site}, before </body>:\n\n${s.tag}\n\nThen: adnetwork wallet ${s.site} <your USDC address>`)
        return 0
      }
      case 'sites': {
        const me = await client.me()
        show(me.sites, me.sites.map(siteLine).join('\n') || 'No sites yet: adnetwork site <example.com>')
        return 0
      }
      case 'check': {
        const s = await client.checkSite(need(rest[0], 'a site'))
        show(s, siteLine(s))
        return 0
      }
      case 'wallet': {
        const s = await client.setWallet(need(rest[0], 'a site'), need(rest[1], 'a wallet address'), rest[2])
        show(s, siteLine(s))
        return 0
      }
      case 'withdraw': {
        const r = await client.withdraw(need(rest[0], 'a site'))
        show(r, `${money(r.amount_usd)} ${r.status === 'requested' ? 'queued' : 'sent'}.`)
        return 0
      }
      case 'redeem': {
        const r = await client.redeem(need(rest[0], 'a credit code'))
        show(r, `${money(r.credit_usd)} of ad credit added. Balance ${money(r.balance_usd)}.`)
        return 0
      }
      case 'invites': {
        const r = await client.invites()
        show(r, `${r.quota.left} of ${r.quota.total} invites left${r.can_invite ? '' : ` (${r.why_not})`}. Each accepted invite: ${money(r.bonus_usd)} of ad credit for both of you.\n${r.invites.map((i) => `  ${i.used ? 'used' : 'open'}  ${i.created_at.slice(0, 10)}  ${i.note || 'invite'}`).join('\n') || '  none yet: adnetwork invite'}`)
        return 0
      }
      case 'invite': {
        const r = await client.createInvite(rest.join(' ') || undefined)
        show(r, `${r.link}\nShown once. ${r.left} left.`)
        return 0
      }
      case 'accept': {
        const r = await client.acceptInvite(need(rest[0], 'an invite code'))
        show(r, r.bonus_usd ? `Accepted: ${money(r.bonus_usd)} of ad credit added.` : `Accepted${r.no_bonus ? ` (no bonus: ${r.no_bonus})` : ''}.`)
        return 0
      }
      case 'remove': {
        show(await client.removeSite(need(rest[0], 'a site')), 'Ads stopped.')
        return 0
      }
    }
    out.error(`adnetwork: unknown command "${command}"\n\n${HELP}`)
    return 2
  } catch (error) {
    out.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}
