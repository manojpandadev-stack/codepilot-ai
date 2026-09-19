// ============================================================================
// CodePilot design system — icons (consistent 16px stroke SVGs, no emoji)
// ============================================================================

import type { ReactNode } from "react";

interface IconProps {
  size?: number;
  className?: string;
}

function Svg({
  size = 14,
  className,
  children,
  viewBox = "0 0 16 16",
}: IconProps & { children: ReactNode; viewBox?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {children}
    </svg>
  );
}

/** Brand mark — a stylized chevron/pilot wing. */
export function CodePilotMark({ size = 18 }: IconProps) {
  return (
    <Svg size={size} viewBox="0 0 24 24" className="text-vscode-text-link">
      <path
        d="M4 5.5 12 4l8 1.5-2.6 9.1L12 20l-5.4-5.4L4 5.5Z"
        strokeWidth="1.5"
      />
      <path d="M8.5 9.5 12 12l3.5-2.5" strokeWidth="1.5" />
      <path d="M12 12v4" strokeWidth="1.5" />
    </Svg>
  );
}

export const IconChat = (p: IconProps) => (
  <Svg {...p}>
    <path
      d="M3 4.5h10a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5H8l-3.5 2.8V12.5H3A1.5 1.5 0 0 1 1.5 11V6A1.5 1.5 0 0 1 3 4.5Z"
      transform="translate(1 -0.5)"
    />
  </Svg>
);

export const IconTools = (p: IconProps) => (
  <Svg {...p}>
    <path d="m9.5 6.5 4-4a3.5 3.5 0 0 0-4.9 4.4L3 12.5 4.5 14l5.6-5.6A3.5 3.5 0 0 0 14.5 3.6L10.9 7.2" />
  </Svg>
);

export const IconChanges = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 2.5h5.5L13 6v7.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Z" />
    <path d="M9.5 2.5V6H13" />
    <path d="M5.5 9h5M5.5 11.5h5" />
  </Svg>
);

export const IconPlugins = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 2.5v2a1.5 1.5 0 0 1-3 0v-2H2A.5.5 0 0 0 1.5 3v11a.5.5 0 0 0 .5.5h12a.5.5 0 0 0 .5-.5V3a.5.5 0 0 0-.5-.5h-1v2a1.5 1.5 0 0 1-3 0v-2H6Z" />
    <path d="M6 8.5h4M8 6.5v4" />
  </Svg>
);

export const IconTeam = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="5.5" cy="5.5" r="2.2" />
    <circle cx="11" cy="6" r="1.8" />
    <path d="M2 13c.3-2.4 1.7-3.8 3.5-3.8S8.7 10.6 9 13M9.7 13c.2-1.8 1.2-2.9 2.6-2.9 1.1 0 2 .8 2.4 2.3" />
  </Svg>
);

export const IconSchedule = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.8" />
    <path d="M8 4.8V8l2.4 1.6" />
  </Svg>
);

export const IconHistory = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 8a5.5 5.5 0 1 1 1.6 3.9" />
    <path d="M2.3 8.2 1.5 11l2.8-.5" />
    <path d="M8 5v3.2l2.3 1.4" />
  </Svg>
);

export const IconMetrics = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 13.5v-4M6.2 13.5V6M9.9 13.5V8.5M13.6 13.5V3.5" />
  </Svg>
);

export const IconSettings = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6 5 5M11 11l1.4 1.4M12.4 3.6 11 5M5 11l-1.4 1.4" />
  </Svg>
);

export const IconSend = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 8 14 2.5 11.5 14 8 9.5 2 8Z" />
    <path d="M8 9.5 14 2.5" />
  </Svg>
);

export const IconStop = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="9" height="9" rx="1" />
  </Svg>
);

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 3v10M3 8h10" />
  </Svg>
);

export const IconRefresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
    <path d="M13.7 2.5v3h-3" />
  </Svg>
);

export const IconShield = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 1.8 13 3.5v4.2c0 3.1-2.1 5.4-5 6.5-2.9-1.1-5-3.4-5-6.5V3.5L8 1.8Z" />
    <path d="m5.8 8 1.6 1.6L10.3 6.6" />
  </Svg>
);

export const IconWarning = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2 14.5 13.5h-13L8 2Z" />
    <path d="M8 6.5V10M8 11.8v.2" />
  </Svg>
);

export const IconFile = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 1.5h5L12.5 5v9a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5Z" />
    <path d="M9 1.5V5h3.5" />
  </Svg>
);

export const IconFolder = (p: IconProps) => (
  <Svg {...p}>
    <path d="M1.5 3.5A1 1 0 0 1 2.5 2.5h3l1.5 2h6a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-9Z" />
  </Svg>
);

export const IconLink = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.5 9.5a3 3 0 0 0 4.2.4l2-2a3 3 0 0 0-4.2-4.2l-1 1" />
    <path d="M9.5 6.5a3 3 0 0 0-4.2-.4l-2 2a3 3 0 0 0 4.2 4.2l1-1" />
  </Svg>
);

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="m3 8.5 3.2 3L13 4.5" />
  </Svg>
);

export const IconX = (p: IconProps) => (
  <Svg {...p}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Svg>
);

export const IconChevron = (p: IconProps) => (
  <Svg {...p}>
    <path d="m5 3 5 5-5 5" />
  </Svg>
);

export const IconTerminal = (p: IconProps) => (
  <Svg {...p}>
    <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
    <path d="m4 6 2 2-2 2M8 10.5h4" />
  </Svg>
);

export const IconCopy = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
    <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
  </Svg>
);

export const IconClock = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.8" />
    <path d="M8 4.8V8l2 1.4" />
  </Svg>
);

export const IconBolt = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 1.5 3.5 9h3.5l-.5 5.5L12 7H8.5L9 1.5Z" />
  </Svg>
);
