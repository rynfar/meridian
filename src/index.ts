/**
 * Public API entry point for @rynfar/meridian.
 *
 * External consumers (plugins, programmatic usage) should import from here.
 * Internal code and tests import from the specific source modules directly.
 */

export { startProxyServer, createProxyServer } from "./proxy/server"
export type { ProxyConfig, ProxyInstance, ProxyServer } from "./proxy/types"
