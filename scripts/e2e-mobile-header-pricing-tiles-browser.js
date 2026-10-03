// Evaluate in a page served by e2e-mobile-header-pricing-tiles.mjs once its
// polls have rendered. Returns text measurements only; no screenshots.
(() => {
  const px = (value) => Math.round(parseFloat(value) * 10) / 10
  const header = document.getElementById('meridianHeader')
  const prov = document.getElementById('mhProv')
  const drift = document.getElementById('mhDrift')
  const right = header.querySelector('.mh-right')
  const boxes = [...right.children].map((el) => el.getBoundingClientRect()).filter((box) => box.width).sort((a, b) => a.top - b.top)
  let rightRows = boxes.length ? 1 : 0
  for (let i = 1, bottom = boxes[0]?.bottom; i < boxes.length; i++) {
    if (boxes[i].top >= bottom) { rightRows++; bottom = boxes[i].bottom } else bottom = Math.max(bottom, boxes[i].bottom)
  }
  const lines = (el) => {
    const range = document.createRange(); range.selectNodeContents(el)
    return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size
  }
  const result = {
    width: innerWidth,
    pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    header: {
      form: header.getAttribute('data-prov-form'), calm: header.getAttribute('data-prov-calm'),
      text: prov.innerText.replace(/\s+/g, ' ').trim(),
      current: drift.getBoundingClientRect().width > 0 ? drift.innerText : null,
      rightRows, besideBrand: right.getBoundingClientRect().top < header.querySelector('.mh-brand').getBoundingClientRect().bottom, height: Math.round(header.getBoundingClientRect().height),
      commitLink: [...prov.querySelectorAll('a[href*="/commit/"]')].some((a) => a.getBoundingClientRect().width > 0),
      title: (prov.title || '').includes('commit: '),
    },
  }
  const container = document.querySelector('.container')
  if (container) {
    const cs = getComputedStyle(container)
    const card = document.querySelector('.profile-card')
    result.home = { containerPadding: [cs.paddingLeft, cs.paddingRight].map(px),
      cardPadding: card ? ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].map((k) => px(getComputedStyle(card)[k])) : null,
      cardWidth: card ? Math.round(card.getBoundingClientRect().width) : null }
  }
  const table = document.querySelector('#pricingRows')
  if (table && table.rows.length) {
    const scroll = document.querySelector('.pricing-scroll')
    result.pricing = {
      modelLines: [...table.querySelectorAll('.pricing-model')].map((td) => lines(td)),
      inputWidths: [...table.rows[0].querySelectorAll('.pricing-input')].map((input) => Math.round(input.getBoundingClientRect().width)),
      clippedValues: [...table.querySelectorAll('.pricing-input')].filter((input) => input.scrollWidth > input.clientWidth).length,
      tableScroll: scroll.scrollWidth - scroll.clientWidth,
    }
  }
  return result
})()
