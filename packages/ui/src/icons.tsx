// SPDX-License-Identifier: Apache-2.0
import type { ReactNode, SVGProps } from "react";

// One icon set for the whole product: 24px grid, 1.75 stroke, currentColor.
const paths = {
  home: <><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V20h14V9.5" /><path d="M10 20v-6h4v6" /></>,
  building: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M9 8h1M14 8h1M9 12h1M14 12h1M10 21v-4h4v4" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3Z" /></>,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.6-3.4 3.2-5.5 6.5-5.5s5.9 2.1 6.5 5.5" /><path d="M16 4.7a3.5 3.5 0 0 1 0 6.6M18.5 14.8c1.700.8 2.8 2.5 3 5.2" /></>,
  shield: <><path d="M12 3 4.5 6v5.5c0 4.6 3 8.1 7.5 9.5 4.5-1.4 7.5-4.9 7.5-9.5V6L12 3Z" /><path d="m9 12 2.2 2.2L15.2 10" /></>,
  activity: <path d="M3 12h4l2.5-7 5 14 2.5-7h4" />,
  list: <><path d="M8 6h12M8 12h12M8 18h12" /><path d="M4 6h.01M4 12h.01M4 18h.01" /></>,
  wrench: <><path d="M5 6h9M18 6h1M5 12h2M11 12h8M5 18h10M19 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="9" cy="12" r="2" /><circle cx="17" cy="18" r="2" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 13.5a7.7 7.7 0 0 0 0-3l2-1.5-2-3.5-2.4 1a7.6 7.6 0 0 0-2.6-1.5L14 2.5h-4L9.6 5a7.6 7.6 0 0 0-2.6 1.5l-2.4-1-2 3.5 2 1.5a7.7 7.7 0 0 0 0 3l-2 1.5 2 3.5 2.4-1a7.6 7.6 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.6 7.6 0 0 0 2.6-1.5l2.4 1 2-3.5-2-1.5Z" /></>,
  key: <><circle cx="8" cy="15" r="4" /><path d="m11 12 9-9M17 6l2.5 2.5M14 9l2 2" /></>,
  contact: <><rect x="3" y="4" width="18" height="16" rx="2.5" /><circle cx="9" cy="10.5" r="2.2" /><path d="M5.5 16.5c.6-1.8 1.9-2.7 3.5-2.7s2.900.9 3.5 2.7M15 9.5h3.5M15 13h3.5" /></>,
  bell: <><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Z" /><path d="M10 20.5a2.2 2.2 0 0 0 4 0" /></>,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9.3a2.6 2.6 0 0 1 5 .9c0 1.8-2.5 2.2-2.5 4M12 17.2h.01" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  x: <path d="m6 6 12 12M18 6 6 18" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  copy: <><rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M5.5 15.5h-1a1 1 0 0 1-1-1v-9a2 2 0 0 1 2-2h9a1 1 0 0 1 1 1v1" /></>,
  external: <><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
  chevron: <path d="m9 6 6 6-6 6" />,
  arrowUp: <path d="M12 19V5M6 11l6-6 6 6" />,
  panel: <><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M9 4v16" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.5 1.5M17.3 17.3l1.5 1.5M5.2 18.8l1.5-1.5M17.3 6.7l1.5-1.5" /></>,
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />,
  monitor: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8.5 20h7M12 16v4" /></>,
  logout: <><path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" /><path d="M15 8l4 4-4 4M19 12H9" /></>,
  trash: <><path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.5h6.4a1.5 1.5 0 0 0 1.5-1.5l.8-12" /><path d="M10 11v6M14 11v6" /></>,
  edit: <><path d="m4 20 1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1Z" /><path d="m14.5 6.5 3 3" /></>,
  pause: <><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></>,
  play: <path d="M7 5v14l12-7L7 5Z" />,
  refresh: <><path d="M20 11a8 8 0 0 0-14.5-4.5L4 8" /><path d="M4 4v4h4M4 13a8 8 0 0 0 14.5 4.5L20 16" /><path d="M20 20v-4h-4" /></>,
  lock: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
  fingerprint: <><path d="M6.5 18c.8-1.8 1.2-3.8 1.2-6a4.3 4.3 0 0 1 8.6 0c0 3-.5 5.7-1.6 8" /><path d="M12 12c0 3.2-.6 6-1.8 8.5M4.5 14.5c.2-.8.3-1.600.3-2.5a7.2 7.2 0 0 1 12-5.4M19.2 11c.1 2-.1 4-.6 5.8" /></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="m4 7.5 8 6 8-6" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5.5M12 7.7h.01" /></>,
  alert: <><path d="M12 4 2.5 20h19L12 4Z" /><path d="M12 10v4.5M12 17.3h.01" /></>,
  upload: <><path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></>,
  github: <path d="M9 19c-4 1.4-4-2-6-2.5M15 21v-3.2a3 3 0 0 0-.8-2.3c2.8-.3 5.8-1.4 5.8-6.2a4.8 4.8 0 0 0-1.3-3.3 4.5 4.5 0 0 0-.1-3.3s-1.1-.3-3.6 1.3a12.3 12.3 0 0 0-6 0C6.5 2.4 5.4 2.7 5.4 2.7a4.5 4.5 0 0 0-.1 3.3A4.8 4.8 0 0 0 4 9.3c0 4.8 3 5.9 5.8 6.2a3 3 0 0 0-.8 2.3V21" />,
  cloud: <path d="M7 18.5a4.5 4.5 0 0 1-.6-8.960 6 6 0 0 1 11.5 1.5A3.8 3.8 0 0 1 17.5 18.5H7Z" />,
  bot: <><rect x="4" y="8" width="16" height="11" rx="3" /><path d="M12 8V4.5M9 13h.01M15 13h.01M9.5 16h5M2 13v2M22 13v2" /><circle cx="12" cy="3.5" r="1" /></>,
  palette: <><path d="M12 3a9 9 0 1 0 0 18c1.4 0 2-1 1.5-2.2-.6-1.400.3-2.8 1.8-2.8H17a4 4 0 0 0 4-4c0-5-4-9-9-9Z" /><path d="M7.5 12h.01M9.5 8h.01M14 7h.01M17 10.5h.01" /></>,
  dots: <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="2.6" />,
  server: <><rect x="3.5" y="4" width="17" height="7" rx="2" /><rect x="3.5" y="13" width="17" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></>,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof paths;

export function Icon({ name, ...props }: { name: IconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {paths[name]}
    </svg>
  );
}

/** The product mark. Replace via `pnpm brand --logo`. */
export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--ac)" />
      <g fill="none" stroke="var(--ac-fg)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 6.5c3.8 1.6 6 4.6 6 8.2 0 3.7-2.6 6.3-6 6.3s-6-2.6-6-6.3c0-3.6 2.2-6.6 6-8.2Z" />
        <path d="M16 21v-6.5M12.7 12.2 16 14.5l3.3-2.3" />
        <path d="M9.5 21.5c1.8 2.5 4 3.8 6.5 3.8s4.7-1.3 6.5-3.8" />
      </g>
    </svg>
  );
}
