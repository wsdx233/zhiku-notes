// 保留原生 select 作为表单数据源，统一外观和键盘交互。
let sequence = 0
let openControl = null
const symbol = (name) => {
  const icon = document.createElement('span')
  icon.className = 'material-symbols-rounded'
  icon.setAttribute('aria-hidden', 'true')
  icon.textContent = name
  return icon
}

export function closeSelectMenu() {
  openControl?.close()
}

export function enhanceSelects(root) {
  for (const select of root.querySelectorAll('select:not([data-enhanced])')) {
    select.dataset.enhanced = 'true'
    select.hidden = true
    const label = select.closest('label')
    if (label) {
      const field = document.createElement('div')
      field.className = label.className
      label.replaceWith(field)
      field.append(...label.childNodes)
    }
    const field = select.closest('.form-field') || select.parentElement
    const labelText = field.querySelector(':scope > span')
    const id = `field-select-${++sequence}`
    if (labelText) labelText.id = `${id}-label`
    const control = document.createElement('div')
    control.className = 'field-select'
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'field-select-trigger'
    button.id = id
    button.setAttribute('role', 'combobox')
    button.setAttribute('aria-haspopup', 'listbox')
    button.setAttribute('aria-expanded', 'false')
    button.setAttribute('aria-controls', `${id}-menu`)
    if (labelText)
      button.setAttribute('aria-labelledby', `${id}-label ${id}-value`)
    const value = document.createElement('span')
    value.id = `${id}-value`
    value.className = 'field-select-value'
    const arrow = symbol('expand_more')
    arrow.classList.add('field-select-arrow')
    button.append(value, arrow)
    const menu = document.createElement('div')
    menu.id = `${id}-menu`
    menu.className = 'field-select-menu'
    menu.setAttribute('role', 'listbox')
    menu.setAttribute('popover', 'manual')
    if (labelText) menu.setAttribute('aria-labelledby', labelText.id)
    menu.hidden = true
    control.append(button, menu)
    select.after(control)
    let active = select.selectedIndex
    let options = []
    let query = ''
    let queryTime = 0
    let isOpen = false
    const update = () => {
      const chosen = select.selectedOptions[0]
      value.replaceChildren()
      if (chosen?.dataset.icon) value.append(symbol(chosen.dataset.icon))
      const text = document.createElement('span')
      text.textContent = chosen?.textContent || '请选择'
      value.append(text)
      button.disabled = select.disabled
      options.forEach((option, index) =>
        option.setAttribute(
          'aria-selected',
          String(index === select.selectedIndex),
        ),
      )
    }
    const highlight = (index) => {
      active = index
      options.forEach((option, i) =>
        option.classList.toggle('is-active', i === active),
      )
      button.setAttribute('aria-activedescendant', `${id}-option-${active}`)
      const row = options[active]
      if (row) {
        if (row.offsetTop < menu.scrollTop) menu.scrollTop = row.offsetTop
        else if (
          row.offsetTop + row.offsetHeight >
          menu.scrollTop + menu.clientHeight
        )
          menu.scrollTop = row.offsetTop + row.offsetHeight - menu.clientHeight
      }
    }
    const close = () => {
      if (!isOpen) return
      isOpen = false
      if (menu.matches(':popover-open')) menu.hidePopover()
      menu.hidden = true
      button.setAttribute('aria-expanded', 'false')
      button.removeAttribute('aria-activedescendant')
      control.classList.remove('is-open')
      if (openControl?.button === button) openControl = null
    }
    const commit = (index) => {
      if (!select.options[index] || select.options[index].disabled) return
      const changed = select.selectedIndex !== index
      select.selectedIndex = index
      close()
      update()
      button.focus()
      if (changed) select.dispatchEvent(new Event('change', { bubbles: true }))
    }
    const position = () => {
      if (!button.isConnected) {
        close()
        return
      }
      const rect = button.getBoundingClientRect()
      const below = innerHeight - rect.bottom - 16
      const above = rect.top - 16
      const upwards = below < 200 && above > below
      menu.style.width = `${Math.min(rect.width, innerWidth - 24)}px`
      menu.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - rect.width - 12))}px`
      menu.style.maxHeight = `${Math.max(80, Math.min(340, upwards ? above : below))}px`
      menu.style.top = upwards ? 'auto' : `${rect.bottom + 8}px`
      menu.style.bottom = upwards ? `${innerHeight - rect.top + 8}px` : 'auto'
    }
    const open = () => {
      closeSelectMenu()
      menu.replaceChildren()
      options = [...select.options].map((option, index) => {
        const row = document.createElement('div')
        row.id = `${id}-option-${index}`
        row.className = 'field-select-option'
        row.setAttribute('role', 'option')
        row.setAttribute(
          'aria-selected',
          String(index === select.selectedIndex),
        )
        row.setAttribute('aria-disabled', String(option.disabled))
        if (option.dataset.icon) row.append(symbol(option.dataset.icon))
        const copy = document.createElement('span')
        copy.className = 'field-select-copy'
        const title = document.createElement('span')
        title.textContent = option.textContent
        copy.append(title)
        if (option.dataset.description) {
          const detail = document.createElement('span')
          detail.className = 'field-select-detail'
          detail.textContent = option.dataset.description
          copy.append(detail)
        }
        row.append(copy, symbol('check'))
        row.lastChild.classList.add('field-select-check')
        row.addEventListener('pointerdown', (event) => event.preventDefault())
        row.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          commit(index)
        })
        menu.append(row)
        return row
      })
      menu.hidden = false
      if (menu.showPopover) menu.showPopover()
      position()
      isOpen = true
      openControl = { button, menu, close, position }
      control.classList.add('is-open')
      button.setAttribute('aria-expanded', 'true')
      highlight(select.selectedIndex)
    }
    button.addEventListener('click', () => (isOpen ? close() : open()))
    button.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && isOpen) {
        event.preventDefault()
        event.stopPropagation()
        close()
        return
      }
      if (event.key === 'Tab') {
        close()
        return
      }
      if (
        ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(
          event.key,
        )
      ) {
        event.preventDefault()
        event.stopPropagation()
        if (!isOpen) {
          open()
          return
        }
        if (event.key === 'Enter' || event.key === ' ') {
          commit(active)
          return
        }
        const enabled = [...select.options]
          .map((option, index) => (option.disabled ? -1 : index))
          .filter((index) => index >= 0)
        if (!enabled.length) return
        const position = enabled.indexOf(active)
        const next =
          event.key === 'Home'
            ? enabled[0]
            : event.key === 'End'
              ? enabled.at(-1)
              : enabled[
                  Math.max(
                    0,
                    Math.min(
                      enabled.length - 1,
                      position + (event.key === 'ArrowDown' ? 1 : -1),
                    ),
                  )
                ]
        highlight(next)
      } else if (
        event.key.length === 1 &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        event.preventDefault()
        if (!isOpen) open()
        query = Date.now() - queryTime > 700 ? event.key : query + event.key
        queryTime = Date.now()
        const match = [...select.options].findIndex(
          (option) =>
            !option.disabled &&
            option.textContent.toLowerCase().startsWith(query.toLowerCase()),
        )
        if (match >= 0) highlight(match)
      }
    })
    select.addEventListener('change', update)
    update()
  }
}

document.addEventListener('pointerdown', (event) => {
  if (
    openControl &&
    !openControl.button.contains(event.target) &&
    !openControl.menu.contains(event.target)
  )
    closeSelectMenu()
})
window.addEventListener('resize', closeSelectMenu)
document.addEventListener(
  'scroll',
  (event) => {
    if (openControl && !openControl.menu.contains(event.target))
      openControl.position()
  },
  true,
)
