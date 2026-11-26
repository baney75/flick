// The Flick mark: three play frames flicking past, amber to ember. Same drawing as public/icon.svg.
const FRAMES: [number, string][] = [[104, '#ffc15e'], [200, '#ff8a3d'], [296, 'url(#flick-ember)']]

export function Logo({ size = 28 }: { size?: number }) {
  const tri = (x: number) => `M${x} 181v150l120-75z`
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true" class="logo">
      <defs>
        <linearGradient id="flick-tile" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="512"><stop offset="0" stop-color="#211d26" /><stop offset="1" stop-color="#0e0d11" /></linearGradient>
        <linearGradient id="flick-ember" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff6b3d" /><stop offset="1" stop-color="#ee3129" /></linearGradient>
      </defs>
      <rect width="512" height="512" rx="116" fill="url(#flick-tile)" />
      {FRAMES.map(([x, c], i) => (
        <g key={x}>
          {i > 0 && <path d={tri(x)} fill="url(#flick-tile)" stroke="url(#flick-tile)" stroke-width="72" stroke-linejoin="round" />}
          <path d={tri(x)} fill={c} stroke={c} stroke-width="40" stroke-linejoin="round" />
        </g>
      ))}
    </svg>
  )
}
