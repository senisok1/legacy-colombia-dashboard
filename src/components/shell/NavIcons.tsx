// Clean line icons for the sidebar / mobile nav (2026-08-22 UI refresh).
// Inline SVG rather than an icon package: keeps the bundle unchanged, gives
// exact control over stroke weight (1.5 reads as "refined" at these sizes),
// and every icon inherits currentColor so the teal active state needs no
// per-icon handling.

type IconProps = { className?: string };

function Svg({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className ?? "w-[18px] h-[18px] shrink-0"}
    >
      {children}
    </svg>
  );
}

export function IconDashboard({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" />
    </Svg>
  );
}

export function IconTeam({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20a6 6 0 0 1 12 0" />
      <path d="M16 5.5a3 3 0 0 1 0 5.8" />
      <path d="M17.5 20a6 6 0 0 0-2.5-4.9" />
    </Svg>
  );
}

export function IconCommissions({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M12 3v18" />
      <path d="M16.5 7.5A3.5 3.5 0 0 0 13 5h-2a3 3 0 0 0 0 6h2a3 3 0 0 1 0 6h-2a3.5 3.5 0 0 1-3.5-2.5" />
    </Svg>
  );
}

export function IconConstruction({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M3 21h18" />
      <path d="M5 21V10l7-5 7 5v11" />
      <path d="M9.5 21v-5h5v5" />
    </Svg>
  );
}

export function IconMessaging({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M21 11.5a7.5 7.5 0 0 1-10.9 6.7L4 20l1.8-5.1A7.5 7.5 0 1 1 21 11.5Z" />
    </Svg>
  );
}

export function IconMarketing({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M4 10v4a1 1 0 0 0 1 1h3l5 4V5L9 9H5a1 1 0 0 0-1 1Z" />
      <path d="M17.5 8.5a5 5 0 0 1 0 7" />
    </Svg>
  );
}

export function IconReports({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M3 20h18" />
      <rect x="5" y="11" width="3.5" height="6" rx="1" />
      <rect x="10.5" y="7" width="3.5" height="10" rx="1" />
      <rect x="16" y="13" width="3.5" height="4" rx="1" />
    </Svg>
  );
}

export function IconBillPay({ className }: IconProps) {
  return (
    <Svg className={className}>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <path d="M2.5 10h19" />
      <path d="M6 14.5h3" />
    </Svg>
  );
}

export function IconSettings({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 14.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" />
    </Svg>
  );
}

export function IconStays({ className }: IconProps) {
  return (
    <Svg className={className}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </Svg>
  );
}

export function IconMore({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </Svg>
  );
}

export function IconChevron({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="m9 6 6 6-6 6" />
    </Svg>
  );
}

export function IconCollapse({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="m15 6-6 6 6 6" />
    </Svg>
  );
}

export function IconSearch({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </Svg>
  );
}

export function IconBell({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M18 8.5a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16s-2-1.5-2-6.5Z" />
      <path d="M10.3 19a2 2 0 0 0 3.4 0" />
    </Svg>
  );
}

export function IconRefresh({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M20 11a8 8 0 1 0-.6 4" />
      <path d="M20 4v7h-7" />
    </Svg>
  );
}

export function IconLogout({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M15 17v1.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2V7" />
      <path d="M10 12h11m0 0-3.5-3.5M21 12l-3.5 3.5" />
    </Svg>
  );
}

/** Maps a nav entry's fixed English label to its icon. */
export function iconForLabel(label: string, className?: string) {
  switch (label) {
    case "Dashboard":
      return <IconDashboard className={className} />;
    case "Team Management":
      return <IconTeam className={className} />;
    case "Commissions":
      return <IconCommissions className={className} />;
    case "Construction Management":
    case "Construction Budget":
      return <IconConstruction className={className} />;
    case "Messaging":
      return <IconMessaging className={className} />;
    case "Marketing":
      return <IconMarketing className={className} />;
    case "Reports":
      return <IconReports className={className} />;
    case "Bill Pay":
      return <IconBillPay className={className} />;
    case "Settings":
      return <IconSettings className={className} />;
    default:
      return <IconDashboard className={className} />;
  }
}
