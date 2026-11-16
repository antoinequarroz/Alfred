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

export function ArrowLeftIcon() {
  return (
    <svg {...base}>
      <path d="M13 8H3.25M7 4 3 8l4 4" />
    </svg>
  );
}

export function ClockIcon() {
  return (
    <svg {...base}>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M8 4.75V8l2.25 1.5" />
    </svg>
  );
}

export function PinIcon() {
  return (
    <svg {...base}>
      <path d="M8 14.25s4.5-3.9 4.5-7.5a4.5 4.5 0 0 0-9 0c0 3.6 4.5 7.5 4.5 7.5Z" />
      <circle cx="8" cy="6.75" r="1.6" />
    </svg>
  );
}

export function PhoneIcon() {
  return (
    <svg {...base}>
      <path d="M3 3.5c0-.55.45-1 1-1h1.6c.45 0 .85.3.97.74l.5 1.9a1 1 0 0 1-.3 1L5.9 7a7 7 0 0 0 3.1 3.1l.86-.87a1 1 0 0 1 1-.3l1.9.5c.44.12.74.52.74.97V12c0 .55-.45 1-1 1h-.5A9 9 0 0 1 3 4Z" />
    </svg>
  );
}

export function VideoIcon() {
  return (
    <svg {...base}>
      <rect x="2" y="4.25" width="8.5" height="7.5" rx="1.5" />
      <path d="m10.5 7 3.5-2v6l-3.5-2" />
    </svg>
  );
}

export function CalendarIcon() {
  return (
    <svg {...base}>
      <rect x="2.25" y="3.25" width="11.5" height="10.5" rx="2" />
      <path d="M2.25 6.75h11.5M5.5 1.75v2.5M10.5 1.75v2.5" />
    </svg>
  );
}

export function UserIcon() {
  return (
    <svg {...base}>
      <circle cx="8" cy="5.5" r="2.75" />
      <path d="M2.75 13.5c.6-2.3 2.7-3.75 5.25-3.75s4.65 1.45 5.25 3.75" />
    </svg>
  );
}

export function MailIcon() {
  return (
    <svg {...base}>
      <rect x="2" y="3.5" width="12" height="9" rx="1.75" />
      <path d="m2.5 5 5.5 4 5.5-4" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg {...base}>
      <path d="m3.25 8.5 3.1 3 6.4-7" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg {...base}>
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  );
}

export function CopyIcon() {
  return (
    <svg {...base}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
    </svg>
  );
}

export function ExternalIcon() {
  return (
    <svg {...base}>
      <path d="M9 2.75h4.25V7M13 3 7.5 8.5M11.5 9.5v2.25a1.5 1.5 0 0 1-1.5 1.5H4.25a1.5 1.5 0 0 1-1.5-1.5V6a1.5 1.5 0 0 1 1.5-1.5H6.5" />
    </svg>
  );
}

export function AlertIcon() {
  return (
    <svg {...base}>
      <path d="M8 2.5 14 13H2Z" />
      <path d="M8 6.5v3M8 11.2v.05" />
    </svg>
  );
}
