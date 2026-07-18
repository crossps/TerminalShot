'use strict';
// Inline SVG icon set — 24px viewBox, stroke-based, inherits currentColor.
(function () {
  const S = (paths, extra = '') =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" ${extra}>${paths}</svg>`;

  window.FS_ICONS = {
    // capture modes
    full: S('<rect x="3" y="4.5" width="18" height="13" rx="2"/><path d="M8 20.5h8"/><path d="M12 17.5v3"/>'),
    window: S('<rect x="3.5" y="4" width="17" height="16" rx="2.5"/><path d="M3.5 9h17"/><circle cx="6.6" cy="6.5" r="0.4" fill="currentColor"/><circle cx="9.2" cy="6.5" r="0.4" fill="currentColor"/>'),
    area: S('<path d="M4 8V6a2 2 0 0 1 2-2h2"/><path d="M16 4h2a2 2 0 0 1 2 2v2"/><path d="M20 16v2a2 2 0 0 1-2 2h-2"/><path d="M8 20H6a2 2 0 0 1-2-2v-2"/><rect x="8.5" y="8.5" width="7" height="7" rx="1" stroke-dasharray="2.4 2.2"/>'),
    scroll: S('<rect x="5" y="3.5" width="14" height="17" rx="2.5"/><path d="M12 8v8"/><path d="M9.5 13.5 12 16l2.5-2.5"/><path d="M9.5 10.5 12 8l2.5 2.5" opacity="0.45"/>'),
    page: S('<path d="M7 3.5h10a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5z"/><path d="M8.5 7h7" opacity="0.5"/><path d="M8.5 10h7" opacity="0.5"/><path d="M12 12.5v5"/><path d="m9.8 15.6 2.2 2.2 2.2-2.2"/>'),
    // editor tools
    select: S('<path d="M6 3.8 18.5 12l-5.4 1.3L10.5 19z" fill="currentColor" stroke-linejoin="round"/>'),
    pen: S('<path d="M4 20c.6-2.7 1.4-4.2 3-5.8L16.2 5a2 2 0 0 1 2.8 2.8L9.8 17c-1.6 1.6-3.1 2.4-5.8 3z"/><path d="M13.5 7.5l3 3"/>'),
    highlighter: S('<path d="M9 15 4.5 19.5"/><path d="M9.5 8.5 15.5 14.5 9 15 8.5 9z" fill="currentColor"/><path d="m11 7 6 6 3.2-3.2a1.5 1.5 0 0 0 0-2.1L16.3 3.8a1.5 1.5 0 0 0-2.1 0z"/>'),
    line: S('<path d="M5 19 19 5"/><circle cx="5" cy="19" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="5" r="1.4" fill="currentColor" stroke="none"/>'),
    arrow: S('<path d="M5 19 17.6 6.4"/><path d="M10.5 5.5H18.5V13.5"/>'),
    rect: S('<rect x="4" y="6" width="16" height="12" rx="1.5"/>'),
    ellipse: S('<ellipse cx="12" cy="12" rx="8.5" ry="6.5"/>'),
    text: S('<path d="M5 6.5V4.5h14v2"/><path d="M12 4.5v15"/><path d="M9 19.5h6"/>'),
    step: S('<circle cx="12" cy="12" r="8.5"/><path d="M10.2 9.4 12.3 8h.4v8" stroke-width="2"/>'),
    blur: S('<path d="M12 3.5s6.5 6.6 6.5 11a6.5 6.5 0 0 1-13 0c0-4.4 6.5-11 6.5-11z"/><path d="M9.5 14.5a3 3 0 0 0 3 3" opacity="0.6"/>'),
    crop: S('<path d="M7 3v14a1 1 0 0 0 1 1h13"/><path d="M3 7h14a1 1 0 0 1 1 1v13"/>'),
    // actions
    undo: S('<path d="M8.5 5.5 4.5 9.5l4 4"/><path d="M4.5 9.5H15a4.5 4.5 0 0 1 0 9H9"/>'),
    redo: S('<path d="M15.5 5.5 19.5 9.5l-4 4"/><path d="M19.5 9.5H9a4.5 4.5 0 0 0 0 9h6"/>'),
    copy: S('<rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M15.5 8.5V6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5"/>'),
    save: S('<path d="M12 3.5v11"/><path d="m7.5 10 4.5 4.5L16.5 10"/><path d="M4 16.5V18a2.5 2.5 0 0 0 2.5 2.5h11A2.5 2.5 0 0 0 20 18v-1.5"/>'),
    saveas: S('<path d="M12 3.5v11" /><path d="m7.5 10 4.5 4.5L16.5 10"/><path d="M4 20.5h16" stroke-dasharray="3 2.4"/>'),
    folder: S('<path d="M3.5 7A2.5 2.5 0 0 1 6 4.5h3.2a2 2 0 0 1 1.6.8l1 1.4a2 2 0 0 0 1.6.8H18A2.5 2.5 0 0 1 20.5 10v7A2.5 2.5 0 0 1 18 19.5H6A2.5 2.5 0 0 1 3.5 17z"/>'),
    edit: S('<path d="M12 20h8"/><path d="M14.5 4.5a2.1 2.1 0 0 1 3 3L7 18l-4 1 1-4z"/>'),
    pin: S('<path d="M9 4.5h6l-.8 6 2.8 3v1.5H7V13.5l2.8-3z"/><path d="M12 15v5"/>'),
    x: S('<path d="M6 6l12 12M18 6L6 18"/>'),
    min: S('<path d="M5 12h14"/>'),
    max: S('<rect x="5.5" y="5.5" width="13" height="13" rx="1.5"/>'),
    restore: S('<rect x="4.5" y="7.5" width="11" height="11" rx="1.5"/><path d="M8.5 7.5V6A1.5 1.5 0 0 1 10 4.5h7A1.5 1.5 0 0 1 18.5 6v7a1.5 1.5 0 0 1-1.5 1.5h-1.5"/>'),
    gear: S('<circle cx="12" cy="12" r="3"/><path d="M12 2.8l1 2.4 2.6-.5 1 2.4 2.4 1-.5 2.6 2.4 1-1 2.4.5 2.6-2.4 1-1 2.4-2.6-.5-1 2.4h-2l-1-2.4-2.6.5-1-2.4-2.4-1 .5-2.6-2.4-1 1-2.4-.5-2.6 2.4-1 1-2.4 2.6.5 1-2.4z" stroke-width="1.4"/>'),
    refresh: S('<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v4.5h-4.5"/>'),
    zoomin: S('<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.5-4.5"/><path d="M11 8.5v5M8.5 11h5"/>'),
    zoomout: S('<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.5-4.5"/><path d="M8.5 11h5"/>'),
    fit: S('<path d="M4 9V6a2 2 0 0 1 2-2h3"/><path d="M15 4h3a2 2 0 0 1 2 2v3"/><path d="M20 15v3a2 2 0 0 1-2 2h-3"/><path d="M9 20H6a2 2 0 0 1-2-2v-3"/>'),
    check: S('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
    camera: S('<path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.6l1.2-1.7a1.5 1.5 0 0 1 1.2-.6h3a1.5 1.5 0 0 1 1.2.6L16 6h1.5A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z"/><circle cx="12" cy="12.5" r="3.4"/>'),
    quit: S('<path d="M15.5 8.5 19 12l-3.5 3.5"/><path d="M19 12H9.5"/><path d="M13 4.5H7A2.5 2.5 0 0 0 4.5 7v10A2.5 2.5 0 0 0 7 19.5h6"/>'),
  };

  window.fsIcon = name => window.FS_ICONS[name] || '';
})();
