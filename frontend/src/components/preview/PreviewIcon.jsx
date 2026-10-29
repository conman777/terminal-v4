const paths = {
  back: 'M19 12H5m6-6-6 6 6 6',
  forward: 'M5 12h14m-6-6 6 6-6 6',
  reload: 'M20 7v5h-5M20 12a8 8 0 1 0-2 5',
  close: 'm6 6 12 12M6 18 18 6',
  plus: 'M12 5v14M5 12h14',
  expand: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',
  restore: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M8 8h8v8H8z',
  page: 'M14 3H5v18h14V8l-5-5v5h5M8 12h8M8 16h5',
  warning: 'm12 3 10 18H2L12 3zm0 6v5m0 3h.01',
  browser: 'M3 4h18v16H3zM3 9h18M7 6.5h.01M10 6.5h.01',
};

export function PreviewIcon({ name }) {
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
    <path d={paths[name]} />
  </svg>;
}
