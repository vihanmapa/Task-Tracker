/* ============================================================
   FM Navigate — Icon set (clean 1.6px stroke line icons)
   ============================================================ */
const Ico = ({ d, size = 18, fill, stroke = 'currentColor', sw = 1.7, vb = 24, children, style }) => (
  <svg width={size} height={size} viewBox={`0 0 ${vb} ${vb}`} fill={fill || 'none'}
       stroke={fill ? 'none' : stroke} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" style={style}>
    {d ? <path d={d} /> : children}
  </svg>
);

const I = {
  grid:     (p) => <Ico {...p}><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></Ico>,
  list:     (p) => <Ico {...p}><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/></Ico>,
  board:    (p) => <Ico {...p}><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18"/></Ico>,
  calendar: (p) => <Ico {...p}><rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9h18M8 2.5v4M16 2.5v4"/></Ico>,
  spark:    (p) => <Ico {...p}><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8z"/></Ico>,
  summary:  (p) => <Ico {...p}><path d="M4 5h16M4 10h16M4 15h10M4 20h7"/></Ico>,
  settings: (p) => <Ico {...p}><circle cx="12" cy="12" r="3"/><path d="M12 2.5v2.5M12 19v2.5M21.5 12H19M5 12H2.5M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8M18.4 18.4l-1.8-1.8M7.4 7.4L5.6 5.6"/></Ico>,
  search:   (p) => <Ico {...p}><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></Ico>,
  plus:     (p) => <Ico {...p} d="M12 5v14M5 12h14"/>,
  check:    (p) => <Ico {...p} d="M5 12.5l4.5 4.5L19 6.5"/>,
  chevR:    (p) => <Ico {...p} d="M9 6l6 6-6 6"/>,
  chevL:    (p) => <Ico {...p} d="M15 6l-6 6 6 6"/>,
  chevD:    (p) => <Ico {...p} d="M6 9l6 6 6-6"/>,
  arrowUp:  (p) => <Ico {...p} d="M12 19V5M6 11l6-6 6 6"/>,
  arrowR:   (p) => <Ico {...p} d="M5 12h14M13 6l6 6-6 6"/>,
  send:     (p) => <Ico {...p}><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></Ico>,
  clock:    (p) => <Ico {...p}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></Ico>,
  alert:    (p) => <Ico {...p}><path d="M12 3l9.5 16.5H2.5L12 3z"/><path d="M12 10v4M12 17.5h.01"/></Ico>,
  block:    (p) => <Ico {...p}><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></Ico>,
  flame:    (p) => <Ico {...p}><path d="M12 3c1.5 3 4.5 4.5 4.5 8.5a4.5 4.5 0 11-9 0c0-1.7.8-2.8 1.6-3.7C9 9.5 9.5 11 11 11c0-2.5-1-4 1-8z"/></Ico>,
  link:     (p) => <Ico {...p}><path d="M10 13a5 5 0 007 0l2-2a5 5 0 00-7-7l-1 1M14 11a5 5 0 00-7 0l-2 2a5 5 0 007 7l1-1"/></Ico>,
  lock:     (p) => <Ico {...p}><rect x="4.5" y="11" width="15" height="10" rx="2"/><path d="M8 11V7.5a4 4 0 018 0V11"/></Ico>,
  unlock:   (p) => <Ico {...p}><rect x="4.5" y="11" width="15" height="10" rx="2"/><path d="M8 11V7.5a4 4 0 017.6-1.8"/></Ico>,
  target:   (p) => <Ico {...p}><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/></Ico>,
  user:     (p) => <Ico {...p}><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.5-6 8-6s8 2 8 6"/></Ico>,
  msg:      (p) => <Ico {...p}><path d="M21 12a8 8 0 01-11.5 7.2L4 20l1-4.8A8 8 0 1121 12z"/></Ico>,
  sun:      (p) => <Ico {...p}><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2M12 19.5v2M21.5 12h-2M4.5 12h-2M18.5 5.5l-1.4 1.4M6.9 17.1l-1.4 1.4M18.5 18.5l-1.4-1.4M6.9 6.9L5.5 5.5"/></Ico>,
  moon:     (p) => <Ico {...p}><path d="M20 14.5A8 8 0 119.5 4 6.5 6.5 0 0020 14.5z"/></Ico>,
  bell:     (p) => <Ico {...p}><path d="M18 8a6 6 0 10-12 0c0 7-2 8-2 8h16s-2-1-2-8M10.5 21a2 2 0 003 0"/></Ico>,
  x:        (p) => <Ico {...p} d="M6 6l12 12M18 6L6 18"/>,
  dots:     (p) => <Ico {...p}><circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/></Ico>,
  drag:     (p) => <Ico {...p}><circle cx="9" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.3" fill="currentColor" stroke="none"/></Ico>,
  filter:   (p) => <Ico {...p}><path d="M3 5h18l-7 8v6l-4-2v-4z"/></Ico>,
  edit:     (p) => <Ico {...p}><path d="M4 20h4L18.5 9.5a2 2 0 00-3-3L5 17v3z"/><path d="M13.5 6.5l3 3"/></Ico>,
  trash:    (p) => <Ico {...p}><path d="M4 7h16M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2M6 7l1 13a2 2 0 002 2h6a2 2 0 002-2l1-13M10 11v6M14 11v6"/></Ico>,
  wand:     (p) => <Ico {...p}><path d="M5 19l9-9M13.5 6.5l1.5-1.5M15 11l1.5 1.5M9 3.5l.7 1.8 1.8.7-1.8.7L9 8.5l-.7-1.8L6.5 6l1.8-.7z"/></Ico>,
  refresh:  (p) => <Ico {...p}><path d="M20 11a8 8 0 10-1.5 5M20 5v6h-6"/></Ico>,
  flag:     (p) => <Ico {...p}><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></Ico>,
  trend:    (p) => <Ico {...p}><path d="M3 17l6-6 4 4 7-7M21 8v4h-4"/></Ico>,
  inbox:    (p) => <Ico {...p}><path d="M4 13l2-8h12l2 8M4 13v6h16v-6M4 13h5l1 2h4l1-2h5"/></Ico>,
};

window.I = I;
