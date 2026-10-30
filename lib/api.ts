const configuredApiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000'
const API_BASE = configuredApiBase.startsWith('http')
  ? configuredApiBase
  : `https://${configuredApiBase}`
const TOKEN_KEY = 'pulsecare_token'

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export function setAccessToken(token: string | null) {
  if (typeof window === 'undefined') return
  if (token) window.sessionStorage.setItem(TOKEN_KEY, token)
  else window.sessionStorage.removeItem(TOKEN_KEY)
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const token =
    typeof window !== 'undefined'
      ? window.sessionStorage.getItem(TOKEN_KEY)
      : null
  if (token) headers.set('Authorization', `Bearer ${token}`)

  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers,
      cache: 'no-store',
    })
  } catch {
    throw new ApiError(0, 'The PulseCare API is unavailable. Check that it is running and try again.')
  }

  const text = await response.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      if (response.ok) {
        throw new ApiError(response.status, 'The API returned an invalid response.')
      }
      body = { detail: text }
    }
  }

  if (!response.ok) {
    if (response.status === 401 && path !== '/api/auth/login') {
      setAccessToken(null)
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('pulsecare:unauthenticated'))
      }
    }
    const detail =
      typeof body === 'object' &&
      body !== null &&
      'detail' in body &&
      typeof body.detail === 'string'
        ? body.detail
        : 'The request could not be completed.'
    throw new ApiError(response.status, detail)
  }

  return body as T
}

export async function downloadFile(path: string, filename: string): Promise<void> {
  const headers = new Headers()
  const token =
    typeof window !== 'undefined'
      ? window.sessionStorage.getItem(TOKEN_KEY)
      : null
  if (token) headers.set('Authorization', `Bearer ${token}`)

  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, { headers, cache: 'no-store' })
  } catch {
    throw new ApiError(0, 'The PulseCare API is unavailable. Check that it is running and try again.')
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: unknown } | null
    throw new ApiError(
      response.status,
      typeof body?.detail === 'string' ? body.detail : 'The download could not be completed.',
    )
  }

  const url = URL.createObjectURL(await response.blob())
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
