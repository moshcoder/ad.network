// ad.network: copy buttons, and a deposit page that follows its own status.
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy]')
  if (!b) return
  navigator.clipboard?.writeText(b.dataset.copy).then(() => {
    const was = b.textContent
    b.textContent = 'Copied'
    setTimeout(() => { b.textContent = was }, 1500)
  })
})
const status = document.getElementById('status')
if (status && status.dataset.deposit) {
  const tick = async () => {
    try {
      const r = await fetch('/deposits/' + encodeURIComponent(status.dataset.deposit) + '.json', { cache: 'no-store' })
      if (r.ok) {
        const d = await r.json()
        const paid = d.status === 'complete'
        status.className = 'status ' + d.status
        status.textContent = paid ? 'paid' : d.status
        document.getElementById('pay-box').hidden = paid
        document.getElementById('paid-box').hidden = !paid
        if (d.status !== 'pending') return
      }
    } catch {}
    setTimeout(tick, 5000)
  }
  setTimeout(tick, 3000)
}
