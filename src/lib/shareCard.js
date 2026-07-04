/**
 * Campus Plug — Share Card Generator
 *
 * FIX #8a: `html-to-image` is not in package.json. Replaced with `html2canvas`
 *           which IS already a listed dependency. The API is slightly different:
 *           html2canvas(element, options) → Promise<HTMLCanvasElement>
 *           then canvas.toDataURL('image/png') gives us the data URL.
 *
 * FIX #8b: Removed TypeScript parameter type annotations from .js functions
 *           (e.g. `function escapeHtml(str: string)`) — `.js` files with
 *           `allowJs: true` but without `checkJs` will fail at runtime on
 *           TS-syntax in plain JS. All type annotations removed.
 *
 * Output: A 540×960 element rendered off-screen (1080×1920 at 2× pixel ratio)
 * in the Campus Plug cyberpunk visual style.
 */

/**
 * Render the share card DOM element and convert to PNG blob.
 */
export async function generateShareCard({ listing, profile, soldInMins = null, plugScore }) {
  // html2canvas is in package.json — safe to import
  const html2canvas = (await import('html2canvas')).default

  const container = document.createElement('div')
  container.style.cssText = `
    position: fixed;
    left: -9999px;
    top: 0;
    width: 540px;
    height: 960px;
    z-index: -1;
    font-family: 'Lexend', 'Inter', system-ui, sans-serif;
  `

  container.innerHTML = buildCardHTML({ listing, profile, soldInMins, plugScore })
  document.body.appendChild(container)

  try {
    const canvas  = await html2canvas(container, {
      width:            540,
      height:           960,
      scale:            2,          // 2× = 1080×1920 effective
      useCORS:          true,
      backgroundColor:  '#080B0F',
      logging:          false,
    })

    const dataUrl = canvas.toDataURL('image/png')

    // Convert data URL → Blob
    const res  = await fetch(dataUrl)
    const blob = await res.blob()
    return { blob, dataUrl }
  } finally {
    document.body.removeChild(container)
  }
}

/**
 * Build the HTML string for the share card.
 * Self-contained — no external CSS dependencies.
 */
function buildCardHTML({ listing, profile, soldInMins, plugScore }) {
  const price      = listing?.price ? `₦${(listing.price / 100).toLocaleString('en-NG')}` : ''
  const title      = listing?.title || 'Campus Item'
  const sellerName = profile?.full_name || 'A Student'
  const uniName    = profile?.university || ''
  const score      = plugScore ?? profile?.plug_score ?? 500
  const scoreColor = score >= 750 ? '#00FF88' : score >= 500 ? '#00F2FF' : '#FFB800'

  const soldLabel =
    soldInMins != null
      ? soldInMins < 60
        ? `Sold in ${soldInMins} minute${soldInMins !== 1 ? 's' : ''}! 🔥`
        : `Sold in ${Math.round(soldInMins / 60)}h ${soldInMins % 60}m`
      : 'Sold on Campus Plug'

  return `
    <div style="
      width:540px; height:960px;
      background:#080B0F;
      position:relative;
      overflow:hidden;
      display:flex;
      flex-direction:column;
      align-items:center;
      justify-content:center;
    ">
      <div style="
        position:absolute; inset:0;
        background-image:
          linear-gradient(rgba(0,242,255,0.05) 1px, transparent 1px),
          linear-gradient(90deg, rgba(0,242,255,0.05) 1px, transparent 1px);
        background-size:54px 54px;
        pointer-events:none;
      "></div>
      <div style="
        position:absolute; width:400px; height:400px; border-radius:50%;
        background:radial-gradient(circle, rgba(0,242,255,0.12) 0%, transparent 70%);
        top:-100px; left:-100px; pointer-events:none;
      "></div>
      <div style="
        position:absolute; width:350px; height:350px; border-radius:50%;
        background:radial-gradient(circle, rgba(168,85,247,0.14) 0%, transparent 70%);
        bottom:-80px; right:-80px; pointer-events:none;
      "></div>
      <div style="
        position:absolute; top:0; left:0; right:0; height:4px;
        background:linear-gradient(90deg, #00F2FF, #A855F7);
      "></div>

      <div style="position:relative; z-index:1; width:100%; padding:0 48px; text-align:center;">
        <div style="display:flex; align-items:center; justify-content:center; gap:12px; margin-bottom:48px;">
          <div style="
            width:44px; height:44px; border-radius:12px;
            background:linear-gradient(135deg, #00F2FF, #A855F7);
            display:flex; align-items:center; justify-content:center;
            font-size:22px; color:#080B0F; font-weight:900;
          ">⚡</div>
          <span style="font-size:24px; font-weight:800; color:#F0F4FF; letter-spacing:-0.5px;">
            Campus<span style="color:#00F2FF;">Plug</span>
          </span>
        </div>

        <div style="
          display:inline-block; padding:8px 24px; border-radius:100px;
          background:rgba(0,255,136,0.15); border:1px solid rgba(0,255,136,0.4);
          color:#00FF88; font-size:14px; font-weight:700;
          letter-spacing:0.05em; margin-bottom:32px;
        ">${soldLabel}</div>

        <div style="
          font-size:32px; font-weight:900; color:#F0F4FF;
          line-height:1.15; letter-spacing:-1px; margin-bottom:16px;
        ">${escapeHtml(title)}</div>

        <div style="
          font-size:52px; font-weight:900;
          background:linear-gradient(135deg, #00F2FF, #A855F7);
          -webkit-background-clip:text; -webkit-text-fill-color:transparent;
          font-family:'Space Mono', monospace; margin-bottom:40px;
        ">${price}</div>

        <div style="
          width:60px; height:2px;
          background:linear-gradient(90deg, #00F2FF, #A855F7);
          margin:0 auto 40px; border-radius:1px;
        "></div>

        <div style="display:flex; align-items:center; gap:16px; justify-content:center; margin-bottom:12px;">
          <div style="
            width:52px; height:52px; border-radius:50%;
            background:linear-gradient(135deg, #00F2FF, #A855F7);
            display:flex; align-items:center; justify-content:center;
            font-size:22px; font-weight:900; color:#080B0F; flex-shrink:0;
          ">${escapeHtml((sellerName[0] ?? '?').toUpperCase())}</div>
          <div style="text-align:left;">
            <div style="font-size:18px; font-weight:700; color:#F0F4FF;">${escapeHtml(sellerName)}</div>
            <div style="font-size:13px; color:rgba(255,255,255,0.4);">${escapeHtml(uniName)}</div>
          </div>
        </div>

        <div style="
          display:inline-flex; align-items:center; gap:8px;
          padding:6px 16px; border-radius:100px;
          background:rgba(0,0,0,0.3); border:1px solid rgba(255,255,255,0.1);
          margin-bottom:48px;
        ">
          <span style="font-size:11px; color:rgba(255,255,255,0.4); text-transform:uppercase; letter-spacing:0.1em;">PlugScore</span>
          <span style="font-size:18px; font-weight:900; color:${scoreColor}; font-family:'Space Mono',monospace;">${score}</span>
        </div>

        <div style="font-size:14px; color:rgba(255,255,255,0.3); margin-bottom:24px; letter-spacing:0.03em;">
          Buy · Sell · Earn on your campus
        </div>
        <div style="font-size:13px; font-weight:700; color:#00F2FF; letter-spacing:0.05em;">
          campusplug.ng
        </div>
      </div>

      <div style="
        position:absolute; bottom:0; left:0; right:0; height:3px;
        background:linear-gradient(90deg, #A855F7, #00F2FF);
      "></div>
    </div>
  `
}

// FIX #8b: plain JS — no TypeScript type annotation on parameter
function escapeHtml(str) {
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;')
}

/** Download the share card as a PNG file. */
export async function downloadShareCard(opts) {
  const { dataUrl } = await generateShareCard(opts)
  const a           = document.createElement('a')
  a.href            = dataUrl
  a.download        = `campusplug-sold-${Date.now()}.png`
  a.click()
}

/** Share via Web Share API (mobile); falls back to opening in a new tab on desktop. */
export async function shareCard(opts) {
  const { blob, dataUrl } = await generateShareCard(opts)

  const file = new File([blob], 'campusplug-sold.png', { type: 'image/png' })
  if (navigator.share && navigator.canShare?.({ files: [file] })) {
    await navigator.share({
      title: 'Just sold on Campus Plug ⚡',
      text:  `Sold ${opts.listing?.title || 'an item'} for ${
        opts.listing?.price
          ? `₦${(opts.listing.price / 100).toLocaleString('en-NG')}`
          : ''
      } 🔥`,
      files: [file],
    })
  } else {
    const url = URL.createObjectURL(blob)
    window.open(url, '_blank')
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
  }
}
