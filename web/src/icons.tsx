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

export function GearIcon() {
  return (
    <svg {...base}>
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 1.9v1.5M8 12.6v1.5M3.69 3.69l1.06 1.06M11.25 11.25l1.06 1.06M1.9 8h1.5M12.6 8h1.5M3.69 12.31l1.06-1.06M11.25 4.75l1.06-1.06" />
    </svg>
  );
}

export function LockIcon() {
  return (
    <svg {...base}>
      <rect x="3.25" y="7.25" width="9.5" height="6.5" rx="1.6" />
      <path d="M5.5 7.25V5.4a2.5 2.5 0 0 1 5 0v1.85" />
    </svg>
  );
}

export function CloudIcon() {
  return (
    <svg {...base}>
      <path d="M4.6 12.5a2.85 2.85 0 0 1-.35-5.68 3.9 3.9 0 0 1 7.55.93 2.4 2.4 0 0 1-.3 4.75Z" />
    </svg>
  );
}

export function MicIcon() {
  return (
    <svg {...base}>
      <rect x="5.75" y="1.75" width="4.5" height="7.5" rx="2.25" />
      <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.25" />
    </svg>
  );
}

export function MicOffIcon() {
  return (
    <svg {...base}>
      <path d="M10.25 6.5V4a2.25 2.25 0 0 0-4.4-.66M5.75 6.25V7a2.25 2.25 0 0 0 3.7 1.72M3.5 7.5a4.5 4.5 0 0 0 7.2 3.6M12.5 7.5c0 .5-.08 1-.23 1.45M8 12v2.25M2.5 2.5l11 11" />
    </svg>
  );
}

export function VideoOffIcon() {
  return (
    <svg {...base}>
      <path d="M6 4.25h3a1.5 1.5 0 0 1 1.5 1.5v2.5M10.5 10.25a1.5 1.5 0 0 1-1.5 1.5H3.5A1.5 1.5 0 0 1 2 10.25v-4.5c0-.5.25-.95.62-1.22M10.5 7 14 5v6l-1.6-.9M2 2l12 12" />
    </svg>
  );
}

export function ScreenIcon() {
  return (
    <svg {...base}>
      <rect x="1.75" y="2.75" width="12.5" height="8.5" rx="1.5" />
      <path d="M5.5 13.75h5M8 11.25v2.5M8 9V5M6.25 6.5 8 4.75 9.75 6.5" />
    </svg>
  );
}

export function HangupIcon() {
  return (
    <svg {...base}>
      <path d="M2.1 9.6c-.4-.4-.4-1.05.03-1.43C3.9 6.6 5.9 5.75 8 5.75s4.1.85 5.87 2.42c.43.38.43 1.03.03 1.43l-1.1 1.1a1 1 0 0 1-1.25.13l-1.3-.85a1 1 0 0 1-.45-.84V7.9a7.4 7.4 0 0 0-3.6 0v1.24a1 1 0 0 1-.45.84l-1.3.85a1 1 0 0 1-1.25-.13Z" />
    </svg>
  );
}

export function ChatIcon() {
  return (
    <svg {...base}>
      <path d="M2.75 4.25a1.5 1.5 0 0 1 1.5-1.5h7.5a1.5 1.5 0 0 1 1.5 1.5v5.5a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.5v-2.5h.25a1.5 1.5 0 0 1-1.5-1.5Z" />
    </svg>
  );
}

export function UsersIcon() {
  return (
    <svg {...base}>
      <circle cx="6" cy="5.5" r="2.25" />
      <path d="M1.75 13c.45-2 2.2-3.25 4.25-3.25S9.8 11 10.25 13M10.25 3.4a2.25 2.25 0 0 1 0 4.2M11.5 9.9c1.4.35 2.45 1.4 2.75 3.1" />
    </svg>
  );
}

export function FlipIcon() {
  return (
    <svg {...base}>
      <path d="M2.75 6.25A5.25 5.25 0 0 1 12.5 4.5M13.25 9.75A5.25 5.25 0 0 1 3.5 11.5M12.75 2.25V4.75H10.25M3.25 13.75v-2.5h2.5" />
    </svg>
  );
}

export function BlurIcon() {
  return (
    <svg {...base}>
      <circle cx="8" cy="6" r="2.25" />
      <path d="M3.75 13.25c.5-2.1 2.2-3.5 4.25-3.5s3.75 1.4 4.25 3.5" />
      <path d="M2 3.5h.01M2 7h.01M4.25 1.75h.01M14 3.5h.01M14 7h.01M11.75 1.75h.01M2 10.5h.01M14 10.5h.01" />
    </svg>
  );
}
