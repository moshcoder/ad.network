/**
 * `adnetwork mcp`: ad.network for an agent, on stdio.
 *
 *   claude mcp add adnetwork -e ADNETWORK_KEY=an_… -- bunx @profullstack/adnetwork mcp
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { AdNetworkClient } from './client.js'
import { VERSION } from './version.js'

const text = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })
const failure = (error: unknown) => ({ isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] })
const wrap = (fn: (a: any) => Promise<unknown>) => async (a: any) => {
  try {
    return text(await fn(a))
  } catch (e) {
    return failure(e)
  }
}
const ref = z.string().min(1).describe('An ad ref, e.g. crawlproof-ad-1234')
const site = z.string().min(3).describe('A site you publish on, e.g. example.com')

export function createMcpServer(client = new AdNetworkClient()): McpServer {
  const server: any = new McpServer({ name: 'ad.network', version: VERSION })
  server.tool('account', 'Your ad.network balance, ads (with views, clicks, spend) and sites (with earnings).', {}, wrap(() => client.me()))
  server.tool(
    'run_ad',
    'Advertise a page: ad.network reads it, writes the ad, and runs it across the network at about $0.20 a click until your daily budget or balance runs out. Takes up to a minute.',
    { url: z.string().url(), daily_usd: z.number().min(1).max(1000).default(5), name: z.string().max(80).optional() },
    wrap(({ url, daily_usd, name }) => client.run(url, daily_usd, name)),
  )
  server.tool(
    'add_budget',
    'Add ad budget: returns checkout_url, a CoinPay page where the person pays in any coin or PayPal. Give them the link, then call deposit_status. Ads start when it lands.',
    { amount_usd: z.number().min(5).max(10000) },
    wrap(({ amount_usd }) => client.fund(amount_usd)),
  )
  server.tool('deposit_status', "A deposit's status: pending, complete or failed.", { id: z.string().min(1) }, wrap(({ id }) => client.deposit(id)))
  server.tool('ad_stats', 'One ad with fresh views, clicks and spend.', { ref }, wrap(({ ref }) => client.ad(ref)))
  server.tool('pause_ad', 'Stop an ad.', { ref }, wrap(({ ref }) => client.updateAd(ref, { running: false })))
  server.tool('resume_ad', 'Run an ad again (it waits for budget if your balance is empty).', { ref }, wrap(({ ref }) => client.updateAd(ref, { running: true })))
  server.tool('set_daily_budget', "Change an ad's daily budget.", { ref, daily_usd: z.number().min(1).max(1000) }, wrap(({ ref, daily_usd }) => client.updateAd(ref, { daily_usd })))
  server.tool('add_site', 'Earn from a site: returns the tag to paste into its pages. It goes live when ad.network sees the tag.', { site }, wrap(({ site }) => client.addSite(site)))
  server.tool('check_site', 'Look for your tag on the site now.', { site }, wrap(({ site }) => client.checkSite(site)))
  server.tool(
    'set_payout_wallet',
    'Where a site is paid, in USDC.',
    { site, wallet: z.string().min(20), coin: z.enum(['usdc_pol', 'usdc_sol', 'usdc_base', 'usdc_eth']).default('usdc_pol') },
    wrap(({ site, wallet, coin }) => client.setWallet(site, wallet, coin)),
  )
  server.tool('withdraw', "Send a site's earnings to its wallet (minimum $5).", { site }, wrap(({ site }) => client.withdraw(site)))
  return server
}

export async function runMcp(client = new AdNetworkClient()): Promise<void> {
  await createMcpServer(client).connect(new StdioServerTransport())
}
