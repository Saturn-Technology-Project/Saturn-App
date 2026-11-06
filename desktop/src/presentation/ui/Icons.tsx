import type { ReactNode } from "react";

function Icon(props: { children: ReactNode }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {props.children}
    </svg>
  );
}

export const HomeIcon = () => <Icon><path d="M3 8l6-5 6 5v7H3zM7 15v-4h4v4" /></Icon>;
export const CodeIcon = () => <Icon><path d="M6.5 5L2.5 9l4 4M11.5 5l4 4-4 4" /></Icon>;
export const LineageIcon = () => <Icon><circle cx="4" cy="4" r="1.6" /><circle cx="4" cy="14" r="1.6" /><circle cx="14" cy="9" r="1.6" /><path d="M4 5.6v6.8M4 8c0 1 1 1 2.5 1h6" /></Icon>;
export const FlaskIcon = () => <Icon><path d="M7 2.5h4M7.7 2.5V7l-4 6.5A1.2 1.2 0 0 0 4.7 15.5h8.6a1.2 1.2 0 0 0 1-2L10.3 7V2.5M5.8 11h6.4" /></Icon>;
export const SamplesIcon = () => <Icon><path d="M3 4h12M3 9h12M3 14h7" /></Icon>;
export const DataIcon = () => <Icon><ellipse cx="9" cy="4.5" rx="5.5" ry="2" /><path d="M3.5 4.5v9c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-9M3.5 9c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2" /></Icon>;
export const InspectIcon = () => <Icon><circle cx="8" cy="8" r="4.5" /><path d="M11.4 11.4l3.6 3.6M6 8h4M8 6v4" /></Icon>;
export const TasksIcon = () => <Icon><path d="M3 5l1.5 1.5L7 4M3 12l1.5 1.5L7 11M10 5.5h5M10 12.5h5" /></Icon>;
export const ShieldIcon = () => <Icon><path d="M9 2.5l5.5 2v4c0 3.5-2.3 5.8-5.5 7-3.2-1.2-5.5-3.5-5.5-7v-4z" /></Icon>;
export const GearIcon = () => <Icon><circle cx="9" cy="9" r="2.3" /><path d="M7.22 3.80L7.46 1.86L10.54 1.86L10.78 3.80L11.42 4.06L12.96 2.87L15.13 5.04L13.94 6.58L14.20 7.22L16.14 7.46L16.14 10.54L14.20 10.78L13.94 11.42L15.13 12.96L12.96 15.13L11.42 13.94L10.78 14.20L10.54 16.14L7.46 16.14L7.22 14.20L6.58 13.94L5.04 15.13L2.87 12.96L4.06 11.42L3.80 10.78L1.86 10.54L1.86 7.46L3.80 7.22L4.06 6.58L2.87 5.04L5.04 2.87L6.58 4.06Z" /></Icon>;
export const AssistantIcon = () => <Icon><path d="M3 4.5h12v8H8l-3 2.5v-2.5H3z" /></Icon>;
export const BoxIcon = () => <Icon><path d="M9 2.5l6 3v7l-6 3-6-3v-7zM3 5.5l6 3 6-3M9 8.5v7" /></Icon>;
