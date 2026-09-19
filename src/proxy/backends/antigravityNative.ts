/** Native tool names are an operator-selected capability, independent of client tools. */
export function agNativeTools(options: { allowNativeBrowser?: boolean; allowNativeSubagents?: boolean }): string[] {
  return [...new Set([
    ...(options.allowNativeBrowser ? ['browser_click_element', 'browser_drag_pixel_to_pixel', 'browser_get_dom', 'browser_get_network_request', 'browser_input', 'browser_list_network_requests', 'browser_mouse_down', 'browser_mouse_up', 'browser_move_mouse', 'browser_press_key', 'browser_refresh_page', 'browser_resize_window', 'browser_scroll', 'browser_scroll_dom', 'browser_select_option', 'browser_subagent', 'capture_browser_console_logs', 'capture_browser_screenshot', 'click_browser_pixel', 'execute_browser_javascript', 'list_browser_pages', 'open_browser_url', 'read_browser_page', 'invoke_subagent'] : []),
    ...(options.allowNativeBrowser ? ['list_pages', 'new_page', 'navigate_page', 'select_page', 'close_page', 'resize_page', 'take_snapshot', 'take_screenshot', 'click', 'fill', 'fill_form', 'press_key', 'hover', 'drag', 'evaluate_script', 'wait_for', 'handle_dialog', 'list_console_messages', 'get_console_message', 'list_network_requests', 'get_network_request'].map(name => 'mcp_chrome_devtools_' + name) : []),
    ...(options.allowNativeSubagents || options.allowNativeBrowser ? ['invoke_subagent', 'manage_subagents', 'manage_inbox', 'send_message', 'wait'] : []),
  ])]
}

/** Keep subagents in the guarded workspace and gate browser delegation separately. */
export function agNativeAllowed(name: unknown, args: unknown, allowed: string[], browser: boolean, subagents: boolean): boolean {
  if (name !== 'invoke_subagent') {
    if (typeof name !== 'string' || !allowed.includes(name)) return false
    if (args && typeof args === 'object') {
      const values = args as Record<string, unknown>
      // Native browser actions cannot turn into arbitrary file reads/writes.
      if (Object.keys(values).some(key => /^(filePath|file_path|path|savePath|downloadPath)$/i.test(key))) return false
      for (const key of ['url', 'Url', 'URL']) if (key in values && (typeof values[key] !== 'string' || !/^https?:\/\//.test(values[key]))) return false
    }
    return true
  }
  if (!args || typeof args !== 'object' || !('Subagents' in args) || !Array.isArray(args.Subagents) || args.Subagents.length < 1 || args.Subagents.length > 4) return false
  return args.Subagents.every((agent: unknown) => {
    if (!agent || typeof agent !== 'object' || !('TypeName' in agent)) return false
    if ('Workspace' in agent && agent.Workspace !== 'inherit') return false
    if (Object.keys(agent).some(key => !['TypeName', 'Workspace', 'Model', 'Prompt', 'Role'].includes(key))) return false
    return agent.TypeName === 'browser' ? browser : subagents && (agent.TypeName === 'self' || agent.TypeName === 'research')
  })
}
