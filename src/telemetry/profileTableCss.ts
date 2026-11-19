export const profileTableCss = `
.profile-table-toolbar,.profile-table-mode{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.profile-table-config{flex:1 0 100%;min-inline-size:0}
.profile-table-config p{margin:4px 0 8px;color:var(--muted);font-size:12px}
.profile-table-columns{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(15rem,100%),1fr));gap:4px 12px;list-style:none;margin:0 0 8px;padding:0}
.profile-table-sort-keys{display:grid;gap:4px;list-style:none;margin:0 0 8px;padding:0}
.profile-table-column,.profile-table-sort-key{display:flex;align-items:center;gap:4px;padding:4px;border:1px solid var(--border);border-radius:8px;background:var(--surface)}
.profile-table-sort-key{flex-wrap:wrap}
.profile-table-sort-label{flex:1;padding-inline:4px;font-size:13px}
.profile-table-sort-key button[data-profile-table-control^="sort-direction:"]{min-inline-size:7em}
.profile-table-column[data-drop-target]{background:color-mix(in srgb,var(--accent) 12%,var(--surface));border-color:var(--accent)}
.profile-table-toolbar button,.profile-table-sort{font:inherit;font-size:12px;color:var(--accent);cursor:pointer;min-block-size:32px}
.profile-table-toolbar button{padding:4px 8px;border:1px solid var(--border);border-radius:6px;background:var(--surface2)}
.profile-table-toolbar button[aria-pressed=true],.profile-table-toolbar button[aria-expanded=true]{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,var(--surface2))}
.profile-table-toolbar button:not(:disabled):hover,.profile-table-sort:hover{background:color-mix(in srgb,var(--accent) 15%,var(--surface2))}
.profile-table-toolbar button:disabled{color:var(--muted);cursor:default;opacity:.55}
.profile-table-toolbar .profile-table-column-toggle{flex:1;text-align:start;overflow-wrap:anywhere}
.profile-table-column-toggle span{color:var(--muted);margin-inline-start:4px}
.profile-table-toolbar .profile-table-move{min-inline-size:32px}
.profile-table-grip{display:inline-grid;place-items:center;flex:none;inline-size:24px;block-size:32px;color:var(--accent);cursor:grab}
.profile-table-grip:active{cursor:grabbing}
.profile-table-toolbar button:focus-visible,.profile-table-scroll:focus-visible,.profile-table-scroll :is(button,a):focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.profile-table-scroll{max-inline-size:100%;min-inline-size:0;overflow-x:auto;border:1px solid var(--border);border-radius:12px;background:var(--surface);scrollbar-color:var(--muted) var(--surface2);scrollbar-width:thin}
.profile-table-scroll::selection,.profile-table-scroll ::selection{color:var(--text);background:color-mix(in srgb,var(--accent) 28%,var(--surface))}
.profile-table-scroll input{caret-color:var(--accent)}
.profile-table-scroll a:any-link{color:var(--accent);text-underline-offset:.18em}
.profile-table{inline-size:100%;border-spacing:0;text-align:start;font-size:13px;font-variant-numeric:tabular-nums}
.profile-table th,.profile-table td{padding:8px 12px;vertical-align:top;border-block-end:1px solid var(--border);text-align:start}
.profile-table thead th{background:var(--bg);color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.045em;white-space:nowrap;vertical-align:middle}
.profile-table thead th[data-column-id]{padding-block:4px}
.profile-table-sort{display:inline-flex;align-items:center;gap:4px;text-align:start;padding:4px;border:0;border-radius:4px;background:transparent;letter-spacing:inherit;text-transform:inherit}
.profile-table-sort-marker{display:inline-block;inline-size:2.3em;text-align:end}
.profile-table tbody tr[data-profile-row]:hover{background:color-mix(in srgb,var(--accent) 6%,var(--surface))}
.profile-table tbody tr:last-child>:is(th,td){border-block-end:0}
.profile-table tr[hidden]{display:none}
.profile-table-cell{overflow-wrap:anywhere}
.profile-table-cell[data-key=name]{min-inline-size:9em;font-weight:600}
.profile-table-cell[data-key=login]{min-inline-size:8rem;overflow-wrap:normal}
.profile-table-note{display:block;margin-block-start:4px;color:var(--muted);font-size:12px}
.profile-table-credit-serving{color:var(--yellow)}
.profile-table-actions{min-inline-size:9em}
.profile-table-actions>*{max-inline-size:100%}
.profile-table-detail:not(:empty){min-inline-size:min(16rem,66vw);margin-block-start:8px;white-space:normal;overflow-wrap:anywhere}
.profile-table .profile-table-empty td{text-align:center;color:var(--muted)}
.profile-table tbody:has(>tr[data-profile-row]:not([hidden]))>.profile-table-empty{display:none}
.profile-table-sr{position:absolute;inline-size:1px;block-size:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
@media (pointer:coarse){
  .profile-table-toolbar button,.profile-table-sort{min-block-size:44px;min-inline-size:44px}
  .profile-table-toolbar .profile-table-move{min-inline-size:44px}
  .profile-table-grip{display:none}
}
`
