// Inline 16px stroke icons for activity steps and artifact cards. Static strings only.

const S = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
const E = '</svg>';

export const STEP_ICONS = Object.freeze({
  terminal: `${S}<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M5 7l2 1.5L5 10M8.5 10H11"/>${E}`,
  docker: `${S}<path d="M2 9h12c0 2.5-2 4-5.5 4S2 11.5 2 9zM4 7h2v2H4zM7 7h2v2H7zM10 7h2v2h-2zM7 5h2v2H7z"/>${E}`,
  server: `${S}<rect x="2.5" y="2.5" width="11" height="4.5" rx="1"/><rect x="2.5" y="9" width="11" height="4.5" rx="1"/><path d="M5 4.75h.01M5 11.25h.01M8 4.75h3M8 11.25h3"/>${E}`,
  phone: `${S}<rect x="4.5" y="1.5" width="7" height="13" rx="1.5"/><path d="M7 12h2"/>${E}`,
  pc: `${S}<rect x="2" y="2.5" width="12" height="8.5" rx="1.5"/><path d="M6 13.5h4M8 11v2.5"/>${E}`,
  search: `${S}<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>${E}`,
  web: `${S}<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2.2 2 9.8 0 12M8 2c-2 2.2-2 9.8 0 12"/>${E}`,
  memory: `${S}<path d="M5.5 3a2.5 2.5 0 0 0-2.5 2.5c0 .4.1.8.3 1.1A2.5 2.5 0 0 0 4 11.5 2.5 2.5 0 0 0 8 13V3.5A2 2 0 0 0 5.5 3zM10.5 3A2.5 2.5 0 0 1 13 5.5c0 .4-.1.8-.3 1.1A2.5 2.5 0 0 1 12 11.5 2.5 2.5 0 0 1 8 13V3.5A2 2 0 0 1 10.5 3z"/>${E}`,
  book: `${S}<path d="M2.5 3.5h4A1.5 1.5 0 0 1 8 5v8.5a1.5 1.5 0 0 0-1.5-1.5h-4zM13.5 3.5h-4A1.5 1.5 0 0 0 8 5v8.5a1.5 1.5 0 0 1 1.5-1.5h4z"/>${E}`,
  news: `${S}<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 6h6M5 8.5h6M5 11h3.5"/>${E}`,
  play: `${S}<circle cx="8" cy="8" r="6"/><path d="M6.5 5.5l4.5 2.5-4.5 2.5z"/>${E}`,
  design: `${S}<path d="M11.5 2.5l2 2-7.5 7.5-2.5.5.5-2.5zM9.5 4.5l2 2"/>${E}`,
  slides: `${S}<rect x="2" y="3" width="12" height="8" rx="1.5"/><path d="M8 11v3M5.5 14h5M5.5 6.5h5M5.5 8.5h3"/>${E}`,
  doc: `${S}<path d="M4 2h5.5L13 5.5V14H4z"/><path d="M9.5 2v3.5H13M6 8.5h4M6 11h4"/>${E}`,
  sheet: `${S}<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M2.5 6.5h11M2.5 10h11M7 6.5v7"/>${E}`,
  image: `${S}<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="5.5" cy="6.2" r="1"/><path d="M3 11.5l3.2-3.2 2.3 2.2 2-1.8 2.5 2.8"/>${E}`,
  video: `${S}<rect x="2" y="4" width="8.5" height="8" rx="1.5"/><path d="M10.5 6.5L14 4.5v7l-3.5-2z"/>${E}`,
  code: `${S}<path d="M5.5 5L2.5 8l3 3M10.5 5l3 3-3 3M9 3.5l-2 9"/>${E}`,
  mail: `${S}<rect x="2" y="3.5" width="12" height="9" rx="1.5"/><path d="M2.5 4.5L8 9l5.5-4.5"/>${E}`,
  link: `${S}<path d="M6.5 9.5l3-3M7 5.5l1.5-1.5a2.1 2.1 0 0 1 3 3L10 8.5M9 10.5L7.5 12a2.1 2.1 0 0 1-3-3L6 7.5"/>${E}`,
  github: `${S}<path d="M6 13v-1.5c-2 .4-2.5-.9-2.5-.9-.3-.8-.8-1-.8-1-.7-.5.1-.5.1-.5.7.1 1.1.7 1.1.7.7 1.1 1.8.8 2.2.6.1-.5.3-.8.5-1-1.6-.2-3.3-.8-3.3-3.6 0-.8.3-1.4.7-1.9-.1-.2-.3-.9.1-1.9 0 0 .6-.2 1.9.7a6.5 6.5 0 0 1 3.4 0c1.3-.9 1.9-.7 1.9-.7.4 1 .2 1.7.1 1.9.5.5.7 1.1.7 1.9 0 2.8-1.7 3.4-3.3 3.6.3.2.5.7.5 1.4V13"/>${E}`,
  health: `${S}<path d="M8 13.5S2.5 9.8 2.5 6a3 3 0 0 1 5.5-1.7A3 3 0 0 1 13.5 6c0 3.8-5.5 7.5-5.5 7.5z"/>${E}`,
  sparkle: `${S}<path d="M8 2l1.4 4.6L14 8l-4.6 1.4L8 14l-1.4-4.6L2 8l4.6-1.4z"/>${E}`,
  attach: `${S}<path d="M11.5 7.5l-4.6 4.6a2.5 2.5 0 0 1-3.5-3.5l5.3-5.3a1.7 1.7 0 0 1 2.4 2.4L5.8 11a.9.9 0 0 1-1.3-1.3l4.6-4.6"/>${E}`,
});

export function iconSvg(key) {
  return Object.hasOwn(STEP_ICONS, key) ? STEP_ICONS[key] : '';
}
