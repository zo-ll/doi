const PATHS = {
  chevron: "M6 4l4 4-4 4",
  folder: "M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z",
  frame: "M3 2.5h10a.5.5 0 0 1 .5.5v10a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5zM2.5 5.5h11",
  plus: "M8 3.5v9M3.5 8h9",
  minus: "M3.5 8h9",
  attach: "M10.5 5l-4.2 4.2a1 1 0 0 0 1.4 1.4l4.6-4.6a2.2 2.2 0 0 0-3.1-3.1L4.6 7.5a3.4 3.4 0 0 0 4.8 4.8L13 8.7",
  send: "M8 12.5v-9M4 7.5l4-4 4 4",
  stop: "M5 5h6v6H5z",
  close: "M4.5 4.5l7 7M11.5 4.5l-7 7",
  fit: "M2.5 6V3a.5.5 0 0 1 .5-.5h3M10 2.5h3a.5.5 0 0 1 .5.5v3M13.5 10v3a.5.5 0 0 1-.5.5h-3M6 13.5H3a.5.5 0 0 1-.5-.5v-3",
  alert: "M8 5v3.5M8 11v.01M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12z",
  target: "M8 13.5A5.5 5.5 0 1 0 8 2.5a5.5 5.5 0 0 0 0 11zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  handoff: "M3 8h9M9 4.5L12.5 8 9 11.5",
  sparkle: "M8 2.5l1.3 3.6 3.7 1.4-3.7 1.4L8 12.5 6.7 8.9 3 7.5l3.7-1.4z",
  comment: "M3 3.5h10a.5.5 0 0 1 .5.5v6.5a.5.5 0 0 1-.5.5H7l-3 2.5V11H3a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5z",
  check: "M3.5 8.5l3 3 6-7",
  arrange: "M2.5 4h4v8h-4zM9.5 4h4v5h-4z",
  undo: "M5.5 4L3 6.5 5.5 9M3 6.5h6.5a3 3 0 0 1 0 6H7",
  trash: "M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.5 8.5h5l.5-8.5",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
