/** Icônes au trait, dessinées sur une grille de 16 px. */
const base = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

export function Chevron({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg {...base}>
      <path d={dir === 'left' ? 'M9.75 3.75 5.5 8l4.25 4.25' : 'M6.25 3.75 10.5 8l-4.25 4.25'} />
    </svg>
  );
}

export function MenuIcon() {
  return (
    <svg {...base}>
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg {...base}>
      <path d="M8 3.25v9.5M3.25 8h9.5" />
    </svg>
  );
}
