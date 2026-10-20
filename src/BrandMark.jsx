import React, { useId } from 'react';

/** The Exomina "E", drawn from the active theme: the tile follows the neutrals and
 * the ribbon the accent, so it matches every theme (light themes get a light tile).
 * Same geometry as build/icon.svg, which stays the static window and taskbar icon. */
export default function BrandMark({ className = '' }) {
  const id = useId().replace(/:/g, '');
  return <svg className={`brand-svg ${className}`} viewBox="0 0 512 512" fill="none" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id={`${id}t`} x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse">
        <stop style={{ stopColor: 'var(--brand-tile-1)' }} /><stop offset="1" style={{ stopColor: 'var(--brand-tile-2)' }} />
      </linearGradient>
      <linearGradient id={`${id}r`} x1="144" y1="142" x2="368" y2="371" gradientUnits="userSpaceOnUse">
        <stop style={{ stopColor: 'var(--brand-ribbon-1)' }} /><stop offset="0.48" style={{ stopColor: 'var(--brand-ribbon-2)' }} /><stop offset="1" style={{ stopColor: 'var(--brand-ribbon-3)' }} />
      </linearGradient>
      <linearGradient id={`${id}f`} x1="246" y1="205" x2="365" y2="321" gradientUnits="userSpaceOnUse">
        <stop style={{ stopColor: 'var(--brand-fold-1)' }} /><stop offset="1" style={{ stopColor: 'var(--brand-fold-2)' }} />
      </linearGradient>
    </defs>
    <rect x="16" y="16" width="480" height="480" rx="110" fill={`url(#${id}t)`} />
    <rect x="17" y="17" width="478" height="478" rx="109" style={{ stroke: 'var(--brand-edge)' }} strokeOpacity=".45" strokeWidth="2" />
    <path d="M312 205H365L299 271L349 321H296L246 271L312 205Z" fill={`url(#${id}f)`} />
    <path d="M144 142H368L317 193H200V231H311L264 278H200V320H368L317 371H144V142Z" fill={`url(#${id}r)`} />
    <path d="M144 142H368L355 155H157V358L144 371V142Z" style={{ fill: 'var(--brand-shine)' }} fillOpacity=".12" />
  </svg>;
}
