export function normalizeRequiredApiKeys(keys?: string[]): string[] {
  return (keys ?? []).map((key) => key.trim()).filter(Boolean)
}

export function extractRequestApiKey(xApiKey?: string, authorization?: string): string | undefined {
  if (xApiKey?.trim()) return xApiKey.trim()

  const bearerMatch = authorization?.match(/^Bearer\s+(.+)$/i)
  const bearerToken = bearerMatch?.[1]?.trim()
  return bearerToken || undefined
}

export interface BasicAuthCredentials {
  username: string
  password: string
}

export function normalizeBasicAuthCredentials(
  username?: string,
  password?: string,
): BasicAuthCredentials | undefined {
  const normalizedUsername = username?.trim()
  const normalizedPassword = password?.trim()
  if (!normalizedUsername || !normalizedPassword) return undefined
  return { username: normalizedUsername, password: normalizedPassword }
}

export function extractBasicAuthCredentials(authorization?: string): BasicAuthCredentials | undefined {
  const basicMatch = authorization?.match(/^Basic\s+(.+)$/i)
  const encoded = basicMatch?.[1]?.trim()
  if (!encoded) return undefined

  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8")
    const separatorIndex = decoded.indexOf(":")
    if (separatorIndex < 0) return undefined
    const username = decoded.slice(0, separatorIndex)
    const password = decoded.slice(separatorIndex + 1)
    return normalizeBasicAuthCredentials(username, password)
  } catch {
    return undefined
  }
}

export function isApiKeyAuthEnabled(requiredApiKeys?: string[]): boolean {
  return normalizeRequiredApiKeys(requiredApiKeys).length > 0
}

export function isApiKeyAuthorized(providedApiKey: string | undefined, requiredApiKeys?: string[]): boolean {
  const normalizedKeys = normalizeRequiredApiKeys(requiredApiKeys)
  if (normalizedKeys.length === 0) return true
  if (!providedApiKey) return false
  return normalizedKeys.includes(providedApiKey)
}

export function isBasicAuthEnabled(username?: string, password?: string): boolean {
  return Boolean(normalizeBasicAuthCredentials(username, password))
}

export function isBasicAuthAuthorized(
  providedCredentials: BasicAuthCredentials | undefined,
  expectedUsername?: string,
  expectedPassword?: string,
): boolean {
  const expectedCredentials = normalizeBasicAuthCredentials(expectedUsername, expectedPassword)
  if (!expectedCredentials) return true
  if (!providedCredentials) return false
  return providedCredentials.username === expectedCredentials.username
    && providedCredentials.password === expectedCredentials.password
}
