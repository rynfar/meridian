export const profileTableMarkupJs = `
  function esc(value) {
    return String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  }

  function button(key, html, attrs = '') {
    return '<button type="button" data-profile-table-control="' + key + '" data-key="' + key + '"' + attrs + '>' + html + '</button>';
  }

  function toolbarHtml() {
    const table = isTable();
    const mode = '<div class="profile-table-mode" role="group" aria-label="Profile view">' +
      button('tiles', 'Tiles', ' aria-pressed="' + !table + '"') +
      button('table', 'Table', ' aria-pressed="' + table + '"') + '</div>';
    const config = table ? columnControls() : '';
    return '<div class="profile-table-toolbar" data-key="profile-table-toolbar">' + mode + config +
      '<span class="profile-table-sr" role="status" data-key="profile-table-status">' + esc(announcement) + '</span></div>';
  }

  function columnControls() {
    const rows = preferences.order.map((id, index) => {
      const label = columns.get(id);
      const shown = !preferences.hidden.includes(id);
      return '<li class="profile-table-column" data-profile-table-option="' + id + '" data-key="' + id + '">' +
        '<span class="profile-table-grip" data-profile-table-grip="' + id + '" draggable="true" aria-hidden="true" title="Drag to move ' + esc(label) + '">&#8942;&#8942;</span>' +
        button('hide:' + id, esc(label) + '<span aria-hidden="true">' + (shown ? 'On' : 'Off') + '</span>',
          ' class="profile-table-column-toggle" aria-pressed="' + shown + '"') +
        moveButton('up', id, label, index === 0) +
        moveButton('down', id, label, index === preferences.order.length - 1) + '</li>';
    }).join('');
    const sortControls = preferences.sort.length ? button('add-sort', 'Add sort column', ' aria-pressed="' + addSort +
      '" title="Add the next header you select as another sort key"') + button('clear-sort', 'Clear sort') : '';
    return button('columns', 'Columns', ' aria-expanded="' + configOpen + '" aria-controls="profile-table-columns"') + sortControls +
      '<div class="profile-table-config" id="profile-table-columns"' + (configOpen ? '' : ' hidden') + '>' +
      '<p>Toggle column visibility. Drag or use the arrows to change column order.</p>' +
      '<ol class="profile-table-columns" aria-label="Column order">' + rows + '</ol>' +
      sortEditorHtml() + button('reset', 'Reset table') + '</div>';
  }

  function sortEditorHtml() {
    if (!preferences.sort.length) return '';
    const rows = preferences.sort.map(({ id, direction }, index) => {
      const label = esc(columns.get(id));
      const disabled = ' disabled';
      const current = direction === 'asc' ? 'Ascending' : 'Descending';
      const next = direction === 'asc' ? 'descending' : 'ascending';
      return '<li class="profile-table-sort-key" data-key="sort-key:' + id + '">' +
        '<span class="profile-table-sort-label"><span aria-hidden="true">' + (index + 1) + '. </span>' + label + '</span>' +
        button('sort-direction:' + id, current, ' aria-label="' + label + ': ' + current + ', change to ' + next + '"') +
        button('sort-earlier:' + id, 'Earlier', ' aria-label="Move ' + label + ' earlier in sort priority"' + (index === 0 ? disabled : '')) +
        button('sort-later:' + id, 'Later', ' aria-label="Move ' + label + ' later in sort priority"' + (index === preferences.sort.length - 1 ? disabled : '')) +
        button('sort-remove:' + id, 'Remove', ' aria-label="Remove ' + label + ' from sort"') + '</li>';
    }).join('');
    return '<p><strong id="profile-table-sort-priority">Sort priority</strong></p>' +
      '<ol class="profile-table-sort-keys" role="list" aria-labelledby="profile-table-sort-priority">' + rows + '</ol>';
  }

  function moveButton(direction, id, label, disabled) {
    const glyph = direction === 'up' ? '&#8593;' : '&#8595;';
    const name = 'Move ' + esc(label) + ' ' + direction;
    return button(direction + ':' + id, '<span aria-hidden="true">' + glyph + '</span>',
      ' class="profile-table-move" aria-label="' + name + '" title="' + name + '"' + (disabled ? ' disabled' : ''));
  }

  function headerHtml(id) {
    const index = preferences.sort.findIndex(key => key.id === id);
    const direction = preferences.sort[index]?.direction;
    const label = esc(columns.get(id));
    const sorted = direction === 'desc' ? 'descending' : 'ascending';
    const state = direction ? ', ' + sorted + ', sort priority ' + (index + 1) : '';
    const marker = direction ? (preferences.sort.length > 1 ? (index + 1) + ' ' : '') +
      (direction === 'asc' ? '&#8593;' : '&#8595;') : '';
    return '<th scope="col" data-key="' + id + '" data-column-id="' + id + '"' +
      (index === 0 ? ' aria-sort="' + sorted + '"' : '') + '>' +
      button('sort:' + id, label + '<span class="profile-table-sort-marker" aria-hidden="true">' + marker + '</span>',
        ' class="profile-table-sort" aria-label="' + label + state + '" title="Sort by ' + label + '; Shift-click to add a sort column"') + '</th>';
  }

  function rowHtml(row, visible) {
    const id = esc(row.id);
    const cells = visible.map(column => {
      const cell = row.cells[column];
      const name = column === 'name';
      const tag = name ? 'th' : 'td';
      const html = cell?.html ?? (cell?.value == null ? '&#8212;' : esc(cell.value));
      return '<' + tag + ' class="profile-table-cell" data-key="' + column + '"' + (name ? ' scope="row"' : '') +
        '>' + html + '</' + tag + '>';
    }).join('');
    const accessibleName = visible.includes('name') ? '' :
      '<span class="profile-table-sr">' + esc(row.cells.name?.value ?? row.id) + '</span>';
    return '<tr id="' + esc(row.anchorId ?? ('profile-' + row.id)) + '" data-key="' + id + '" data-profile-row="' + id + '"' + (row.hidden ? ' hidden' : '') +
      '>' + cells + '<td class="profile-table-actions" data-key="actions">' + accessibleName + row.actionsHtml +
      '<div class="profile-table-detail" data-key="detail">' + (row.detailHtml ?? '') + '</div></td></tr>';
  }

  function tableHtml(rows) {
    const visible = preferences.order.filter(id => !preferences.hidden.includes(id));
    const ordered = preferences.sort.length ? rows.slice().sort(compareRows) : rows;
    const empty = '<tr class="profile-table-empty"><td colspan="' + (visible.length + 1) + '">No matching profiles</td></tr>';
    return '<div class="profile-table-scroll" data-key="profile-table-scroll" role="region" tabindex="0" aria-label="Profile table scroll area">' +
      '<table class="profile-table"><caption class="profile-table-sr">Profiles</caption><thead><tr>' +
      visible.map(headerHtml).join('') + '<th scope="col" data-key="actions" data-column-id="actions">Actions</th></tr></thead><tbody>' +
      ordered.map(row => rowHtml(row, visible)).join('') + empty + '</tbody></table></div>';
  }
`
